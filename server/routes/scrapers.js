const express = require("express");
const router = express.Router();

// External imports copied from index.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Jimp = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { startContinuousScraper, stopContinuousScraper, reloadContinuousScraper, getHistoricalResults, getHistoryStoreInfo, scrapeLiveListOnDemand } = require("../scraper");
const { captureLeagueResults } = require("../screenshot_scraper");
const { nativeCaptureLeagueResults } = require("../native_scraper");
const { uploadMatchesToDatabase, syncMatchesToDatabase, getDatabaseHistoryLog, setDatabaseHistoryLog, dbEvents } = require("../db_uploader");
const { fetchResultsFromDatabase, fetchTodayResultsFromDatabase, todayDDMMYYYY, fetchFullDayRawResults, fetchTeamHistoryFromDatabase, fetchAvailableDates, fetchAvailableLeagues, fetchAllHistoryLogs, computeTeamForm, computeH2HForm, computeVenueAdvantage, computeAllLeagueBaselines, getLeagueBaseline, getCachedDocs } = require("../db_reader");
const { toDbLeague, SUPPORTED_LEAGUES } = require("../constants");
const { saveAnalysis, getRecentContext, getLog, deleteEntry, getEntryById, clearLog, getStrategy, updateStrategy, fetchStrategyHistory, getLeagueIntelligence, updateLeagueIntelligence, getAnalysisByScopeAndDate, saveDailyTip, getDailyTip, getAllDailyTips } = require("../ai_memory");
const { deleteLeagueData } = require("../db_admin");
const { connectDb, PatternSnapshot } = require("../db_init");
const {
    detectBehaviourPatterns,
    saveBehaviourSignals,
    fetchBehaviourSignals,
    buildBehaviourPromptInjection,
    buildLeagueBaselinePromptInjection,
    computeLeagueStreakProfile,
    compareScreenshotResults
} = require("../behaviour_pattern_engine");
const {
    callPredictionAI,
    parseAIJson,
    getActivePredictionProvider,
    setActivePredictionProvider,
    getPredictionProviderStatus,
    PREDICTION_PROVIDERS,
} = require("../prediction_ai");

module.exports = function(globals) {
    const { broadcastAiStatus, broadcastLiveScores, getLivePage } = globals;

    const globalDataRef = {};
    Object.defineProperty(globalDataRef, "current", {
        get: () => globals.globalData,
        set: (v) => globals.globalData = v
    });

router.post('/api/scraper/reload', async (req, res) => {
    try {
        console.log('[DEBUG] [/api/scraper/reload] Reload requested via API');
        await reloadContinuousScraper();
        res.json({ success: true, message: 'Scraper background reload initiated' });
    } catch (err) {
        console.error('[/api/scraper/reload] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/screenshot-results', async (req, res) => {
    try {
        const league = req.query.league || 'England League';
        let targetDate = req.query.date;
        const forceUpdate = req.query.force === 'true';
        
        // Default to Today in YYYY-MM-DD for native context
        if (!targetDate) {
            targetDate = new Date().toISOString().split('T')[0];
        }

        console.log(`[DEBUG] [/api/vfootball/screenshot-results] Request params: ${league}, ${targetDate}, Force: ${forceUpdate}`);

        let isHistorical = false;
        let targetDateDDMMYYYY = null;
        if (targetDate) {
            const todayStr = new Date().toLocaleDateString('en-CA'); 
            isHistorical = targetDate !== todayStr;
            const [y, m, d] = targetDate.split('-');
            if (y && m && d) targetDateDDMMYYYY = `${d}/${m}/${y}`;
        }

        const logKey = `${league}_${targetDate}`;
        let record = { status: 'new', uploadedPages: [] };
        
        try {
            const fbRecord = await getDatabaseHistoryLog(logKey);
            if (fbRecord) record = fbRecord;
        } catch (e) {
            console.warn('[DEBUG] Failed to fetch layout history from DB: ', e.message);
        }

        if (forceUpdate) {
            console.log(`[DEBUG] Force Update toggled. Wiping clean state for ${logKey}`);
            record.status = 'new';
            record.uploadedPages = [];
        } else if (isHistorical) {
            // First check History Log. If it says complete, double check Database natively.
            if (record.status === 'completed' || (!record.status && record.uploadedPages.length === 4)) {
               console.log(`[DEBUG] Logs flag ${logKey} as completed. Verifying deeply via Database DB...`);
               if (targetDateDDMMYYYY) {
                   try {
                       const dbLeagueName = toDbLeague(league); // uses constants.js — single source of truth
                       const existingMatches = await fetchFullDayRawResults(dbLeagueName, targetDateDDMMYYYY);
                       if (existingMatches && existingMatches.length > 30) {
                           console.log(`[DEBUG] Native DB confirms ${existingMatches.length} matches for ${league} on ${targetDate}. Emitting Landing override.`);
                           return res.json({ success: true, fullyAvailable: true, landingUrl: '/' });
                       } else {
                           console.log(`[DEBUG] Native DB found ${existingMatches?.length || 0} matches. We require a fresh pull to complete!`);
                           // Continue with extraction loop
                       }
                   } catch(err) {
                       console.warn('[DEBUG] Database deep check failed, falling back...', err.message);
                   }
               }
            }
        }

        const options = {
            onPageCaptured: async (unusedScreenshotPath, matchRows, pageNum) => {
                if (matchRows && matchRows.length > 0) {
                    const tempFileName = `temp_sync_${league.replace(/\s+/g, '_')}_p${pageNum}.json`;
                    const tempFilePath = path.join(__dirname, tempFileName);

                    try {
                        // 1. Save to temporary file as requested
                        fs.writeFileSync(tempFilePath, JSON.stringify(matchRows, null, 2));
                        console.log(`\n[Sync-Pipeline] 📁 Saved ${matchRows.length} matches to ${tempFileName}`);

                        // 2. Batch push to database (handles deduplication via bulk upsert)
                        const { uploaded, skipped } = await uploadMatchesToDatabase(matchRows, (msg) => {
                            broadcastAiStatus('tool', `[Page ${pageNum}] ${msg}`);
                        });
                        console.log(`[Sync-Pipeline] 📤 Page ${pageNum}: ${uploaded} uploaded, ${skipped} skipped.`);

                        // 3. Delete file after finish
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                            console.log(`[Sync-Pipeline] 🗑️ Cleanup successful: Deleted ${tempFileName}`);
                        }

                        // Track progress in history log
                        record.uploadedPages.push(pageNum);
                        await setDatabaseHistoryLog(logKey, record);

                    } catch (e) {
                        console.error(`[Sync-Pipeline] ❌ Failed at Page ${pageNum}:`, e.message);
                    }
                }
            }
        };

        broadcastAiStatus('progress', `Starting high-speed native sync for ${league}...`);
        const result = await nativeCaptureLeagueResults(league, targetDate, options);

        if (!result.success) {
            return res.status(500).json(result);
        }

        if (isHistorical && !result.skippedAll) {
            record.status = 'completed';
            await setDatabaseHistoryLog(logKey, record);
        }

        res.json({
            success: true,
            league: result.league,
            base64Image: result.base64Image, // May be null if all skipped, frontend handles it.
            rawText: result.rawText,
            matchData: result.matchData || [],
            screenshotPath: result.screenshotPath || null,
            fullyAvailable: isHistorical,
            tokenStats: result.tokenStats
        });
    } catch (error) {
        console.error('[Database Index Debug/Error Details]: [/api/vfootball/screenshot-results] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/screenshot-preview/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        // Security: only allow .png filenames, no path traversal
        if (!filename.endsWith('.png') || filename.includes('/') || filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const filePath = path.join(__dirname, 'testdownloadpage', filename);
        if (!fs.existsSync(filePath)) {
            console.warn(`[DEBUG] [/api/screenshot-preview] File not found: ${filename}`);
            return res.status(404).json({ error: 'File not found' });
        }
        console.log(`[DEBUG] [/api/screenshot-preview] Serving: ${filename}`);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=60'); // 1 min cache
        res.sendFile(filePath);
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/screenshot-preview]', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/screenshots', (req, res) => {
    try {
        const dir = path.join(__dirname, 'testdownloadpage');
        if (!fs.existsSync(dir)) return res.json({ success: true, screenshots: [] });

        const processedHashes = fs.existsSync(PROCESSED_DB_PATH)
            ? JSON.parse(fs.readFileSync(PROCESSED_DB_PATH))
            : [];

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.png'))
            .map(filename => {
                const fullPath = path.join(dir, filename);
                const stat = fs.statSync(fullPath);
                const hash = getFileHash(fullPath);

                // Read companion metadata file for auto league detection
                const metaPath = fullPath.replace('.png', '.meta.json');
                let meta = {};
                if (fs.existsSync(metaPath)) {
                    try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (_) { }
                }

                return {
                    filename,
                    absolutePath: fullPath,
                    sizeBytes: stat.size,
                    capturedAt: meta.capturedAt || stat.mtimeMs,
                    capturedAtISO: meta.capturedAtISO || new Date(stat.mtimeMs).toISOString(),
                    league: meta.league || null,        // e.g. "England League"
                    dbLeague: meta.dbLeague || null,    // e.g. "England - Virtual"
                    date: meta.date || null,
                    isNew: !processedHashes.includes(hash),
                    hasMeta: fs.existsSync(metaPath),
                };
            })
            .sort((a, b) => b.capturedAt - a.capturedAt); // newest first

        const newCount = files.filter(f => f.isNew).length;
        console.log(`[DEBUG] [/api/screenshots] Found ${files.length} screenshots, ${newCount} new`);
        res.json({ success: true, screenshots: files });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/screenshots]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/reset-visual-hashes', (req, res) => {
    try {
        const prevCount = fs.existsSync(VISUAL_HASH_DB_PATH)
            ? JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH)).length
            : 0;
        fs.writeFileSync(VISUAL_HASH_DB_PATH, JSON.stringify([], null, 2));
        console.log(`[DEBUG] [reset-visual-hashes] Cleared ${prevCount} visual hash(es) from database.`);
        res.json({ success: true, cleared: prevCount, message: `Visual hash database cleared. ${prevCount} hash(es) removed.` });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [reset-visual-hashes]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/api/screenshots/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        console.log(`[DEBUG] [DELETE /api/screenshots] Request to delete: ${filename}`);

        // Security: only allow .png filenames, no path traversal
        if (!filename.endsWith('.png') || filename.includes('/') || filename.includes('..')) {
            console.warn(`[DEBUG] [DELETE /api/screenshots] Rejected unsafe filename: ${filename}`);
            return res.status(400).json({ success: false, error: 'Invalid filename. Only .png files allowed.' });
        }

        const dir = path.join(__dirname, 'testdownloadpage');
        const filePath = path.join(dir, filename);
        const metaPath = filePath.replace('.png', '.meta.json');

        if (!fs.existsSync(filePath)) {
            console.warn(`[DEBUG] [DELETE /api/screenshots] File not found: ${filePath}`);
            return res.status(404).json({ success: false, error: 'Screenshot file not found.' });
        }

        // Delete the PNG
        fs.unlinkSync(filePath);
        console.log(`[DEBUG] [DELETE /api/screenshots] Deleted PNG: ${filename}`);

        // Delete companion metadata if exists
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
            console.log(`[DEBUG] [DELETE /api/screenshots] Deleted metadata: ${filename.replace('.png', '.meta.json')}`);
        }

        res.json({ success: true, deleted: filename });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [DELETE /api/screenshots]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/screenshots/process-pending', async (req, res) => {
    try {
        const dir = path.join(__dirname, 'testdownloadpage');
        if (!fs.existsSync(dir)) return res.json({ success: true, processed: 0, skipped: 0, errors: [] });

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
        console.log(`[Pending Process] Found ${files.length} PNG file(s) to process.`);

        let processedCount = 0;
        let skippedCount   = 0;
        const errors       = [];

        const { extractMatchDataFromImage } = require('./ai_router');
        const { uploadMatchesToDatabase }   = require('./db_uploader');

        for (const filename of files) {
            const filePath = path.join(dir, filename);
            const metaPath = filePath.replace('.png', '.meta.json');

            // ── Resolve league from companion meta file ────────────────────────
            let league = 'England - Virtual'; // safe default
            if (fs.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    league = meta.dbLeague || meta.league || league;
                } catch (metaErr) {
                    console.warn(`[Pending Process] ⚠️ Could not parse meta for ${filename}: ${metaErr.message}`);
                }
            } else {
                console.warn(`[Pending Process] ⚠️ No meta file found for ${filename} — using default league: ${league}`);
            }

            console.log(`[Pending Process] 🔍 Extracting: ${filename} | league: ${league}`);

            try {
                const { matches: matchRows, totalPages } = await extractMatchDataFromImage(filePath, league);

                if (matchRows && matchRows.length > 0) {
                    // ai_router handles provider selection — just upload the result here explicitly
                    const { uploaded, skipped } = await uploadMatchesToDatabase(
                        matchRows,
                        (msg) => console.log(`[Pending Process → Database] ${msg}`)
                    );
                    console.log(`[Pending Process] ✅ ${filename}: ${uploaded} uploaded | ${skipped} skipped (${totalPages} pages detected)`);

                    // Clean up files only after successful upload
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
                    processedCount++;
                } else {
                    console.warn(`[Pending Process] ⚠️ No matches extracted from ${filename}. File kept for retry.`);
                    skippedCount++;
                }
            } catch (extractErr) {
                console.error(`[Pending Process] ❌ Error processing ${filename}: ${extractErr.message}`);
                errors.push({ filename, error: extractErr.message });
                skippedCount++;
            }
        }

        console.log(`[Pending Process] Done — ${processedCount} processed, ${skippedCount} skipped, ${errors.length} errors.`);
        res.json({ success: true, processed: processedCount, skipped: skippedCount, errors });

    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [POST /api/screenshots/process-pending]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

    return router;
};
