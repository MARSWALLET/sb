const express = require("express");
const router = express.Router();

// External imports copied from index.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Jimp = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { startContinuousScraper, stopContinuousScraper, reloadContinuousScraper, getHistoricalResults, getHistoryStoreInfo, scrapeLiveListOnDemand } = require("../scraper");

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

router.get('/api/vfootball/history', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        console.log(`[DEBUG] [/api/vfootball/history] Page ${page} requested`);

        const historyData = await getHistoricalResults(page);

        const storeInfo = getHistoryStoreInfo();
        console.log(`[DEBUG] [/api/vfootball/history] Store info:`, storeInfo);

        res.json({
            success: true,
            page,
            data: historyData,
            storeInfo,
        });
    } catch (error) {
        console.error('[Database Index Debug/Error Details]: [/api/vfootball/history] Error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch historical vFootball data',
            details: error.message,
        });
    }
});

router.get('/api/debug/history-store', (req, res) => {
    try {
        const info = getHistoryStoreInfo();
        console.log('[DEBUG] [/api/debug/history-store] Store stats:', info);
        res.json({ success: true, ...info });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/debug/live-list', async (req, res) => {
    try {
        console.log('[DEBUG] [/api/debug/live-list] Triggering on-demand live list scrape...');
        const liveListGames = await scrapeLiveListOnDemand();
        const totalMatches = liveListGames.reduce((acc, g) => acc + (g.matches?.length || 0), 0);

        console.log(`[DEBUG] [/api/debug/live-list] Got ${liveListGames.length} league groups, ${totalMatches} matches.`);
        liveListGames.forEach(g => {
            console.log(`  [Live List] League: "${g.league}" — ${g.matches?.length || 0} match(es)`);
            g.matches?.forEach((m, i) => console.log(`    [${i + 1}] ${m.time} | ${m.home} vs ${m.away} | Code: ${m.code} | ${m.score}`));
        });

        res.json({
            success: true,
            capturedAt: new Date().toISOString(),
            leagueGroups: liveListGames.length,
            totalMatches,
            data: liveListGames,
        });
    } catch (err) {
        console.error('[DEBUG] [/api/debug/live-list] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/admin/vfootball/sync-all', async (req, res) => {
    try {
        const leagues = SUPPORTED_LEAGUES;
        let targetDate = req.query.date;

        // Default to Today in YYYY-MM-DD for native context
        if (!targetDate) {
            targetDate = new Date().toISOString().split('T')[0];
        }
        
        console.log(`[Admin] 🚀 Starting Global Auto-Sync for ${leagues.join(', ')}...`);
        broadcastAiStatus('progress', `🚀 Starting Global Auto-Sync (4 Leagues)...`);

        const results = [];
        for (const league of leagues) {
            broadcastAiStatus('progress', `Syncing ${league}...`);
            
            const onPageCaptured = async (unused, matchRows, pageNum) => {
                if (matchRows && matchRows.length > 0) {
                    const tempFileName = `temp_sync_${league.replace(/\s+/g, '_')}_p${pageNum}.json`;
                    const tempFilePath = path.join(__dirname, tempFileName);
                    try {
                        fs.writeFileSync(tempFilePath, JSON.stringify(matchRows, null, 2));
                        await uploadMatchesToDatabase(matchRows, (msg) => {
                            broadcastAiStatus('tool', `[${league} P${pageNum}] ${msg}`);
                        });
                        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    } catch (e) {
                        console.error(`[GlobalSync] Error on ${league} P${pageNum}:`, e.message);
                    }
                }
            };

            const result = await nativeCaptureLeagueResults(league, targetDate, { onPageCaptured });
            results.push({ league, success: result.success });
        }

        broadcastAiStatus('success', `✅ Global Sync Complete! Processed ${leagues.length} leagues.`);
        res.json({ success: true, results });

        // ── Priority 6: Auto-train league intelligence in the background ─────────
        // Fire training for each league that successfully synced — no await, non-blocking
        const apiKeyForTraining = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY;
        if (apiKeyForTraining) {
            const ddmmyyyy = targetDate
                ? (() => { const [y,m,d] = targetDate.split('-'); return `${d}/${m}/${y}`; })()
                : todayDDMMYYYY();
            const leaguesToTrain = results.filter(r => r.success).map(r => r.league);
            console.log(`[Auto-Train] 🤖 Queuing background training for ${leaguesToTrain.length} leagues on ${ddmmyyyy}...`);
            setImmediate(async () => {
                for (const lg of leaguesToTrain) {
                    try {
                        console.log(`[Auto-Train] Starting training for ${lg}...`);
                        // Reuse the internal logic by calling a direct POST to ourselves
                        const trainRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/vfootball/learning-mode`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ league: lg, targetDate: ddmmyyyy })
                        });
                        const trainData = await trainRes.json();
                        if (trainData.success) {
                            console.log(`[Auto-Train] ✅ ${lg} profile built (${trainData.matchesAnalyzed} matches).`);
                        } else {
                            console.warn(`[Auto-Train] ⚠️ ${lg} training failed: ${trainData.error}`);
                        }
                    } catch (trainErr) {
                        console.error(`[Auto-Train] ❌ ${lg}: ${trainErr.message}`);
                    }
                }

                // 🧬 Auto-compute League DNA baselines after all leagues are trained
                // This ensures baselines are fresh and ready for the next prediction cycle
                console.log('[Auto-Train] 🧬 Computing League DNA baselines from last 7 days...');
                try {
                    const dnaBaselines = await computeAllLeagueBaselines(7);
                    console.log(`[Auto-Train] ✅ League DNA baselines computed for ${dnaBaselines.length} leagues.`);
                    broadcastAiStatus('success', `🧬 League DNA updated for ${dnaBaselines.length} leagues.`);
                } catch (blErr) {
                    console.error('[Auto-Train] ⚠️ DNA baseline compute failed (non-fatal):', blErr.message);
                }

                console.log('[Auto-Train] 🏁 Background training complete for all leagues.');
            });
        } else {
            console.log('[Auto-Train] Skipping — no DEEPSEEK_API_KEY or ANTHROPIC_API_KEY set.');
        }

    } catch (err) {
        console.error('[Admin] Global Sync failed:', err);
        broadcastAiStatus('error', `Global Sync failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/history-logs', async (req, res) => {
    try {
        console.log('[DEBUG] [/api/vfootball/history-logs] Fetching from Database...');
        const rawLogs = await fetchAllHistoryLogs();

        // Group by date → league for UI convenience
        // logKey format: "England League_2026-04-15"
        const groupedLogs = {};
        for (const key in rawLogs) {
            const underscoreIdx = key.indexOf('_');
            if (underscoreIdx === -1) continue;
            const league = key.slice(0, underscoreIdx);
            const date   = key.slice(underscoreIdx + 1);

            if (!groupedLogs[date]) groupedLogs[date] = {};
            groupedLogs[date][league] = rawLogs[key];
        }

        console.log(`[DEBUG] [/api/vfootball/history-logs] Returning ${Object.keys(groupedLogs).length} date groups.`);
        res.json({ success: true, logs: groupedLogs });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/vfootball/history-logs] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/public/results', async (req, res) => {
    try {
        const { page = 1, pageSize = 5, league, dateFrom, dateTo } = req.query;
        console.log(`[DEBUG] [/api/public/results] query=`, req.query);

        const data = await fetchResultsFromDatabase({ league, dateFrom, dateTo, page: Number(page), pageSize: Number(pageSize) });
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/public/results]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/available-dates', async (req, res) => {
    try {
        const { league } = req.query;
        const [dates, availableLeagues] = await Promise.all([
            fetchAvailableDates(league),
            fetchAvailableLeagues(),
        ]);
        res.json({ success: true, dates, availableLeagues });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/vfootball/available-dates]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/team-form', async (req, res) => {
    try {
        const { league, team, limit } = req.query;
        console.log(`[DEBUG] [/api/vfootball/team-form] league=${league} team=${team}`);
        if (!league || !team) {
            return res.status(400).json({ success: false, error: 'league and team query params are required.' });
        }
        const parsedLimit = Math.min(parseInt(limit || '10', 10), 30);
        const form = await computeTeamForm(league, team, parsedLimit);
        res.json({ success: true, form });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/vfootball/team-form]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/db-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onUpdate = () => {
        res.write(`data: ${JSON.stringify({ type: 'db-updated', ts: Date.now() })}\n\n`);
    };

    dbEvents.on('db-updated', onUpdate);

    // Keep connection alive
    const pingInterval = setInterval(() => {
        res.write(': ping\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(pingInterval);
        dbEvents.off('db-updated', onUpdate);
    });
});

router.post('/api/sync-local-to-database', async (req, res) => {
    const { leagueFilter } = req.body || {};

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (msg) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', message: msg, ts: Date.now() })}\n\n`);
        console.log(`[Sync-Local-FB] ${msg}`);
    };
    const done = (data) => { res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`); res.end(); };
    const fail = (msg) => { res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`); res.end(); };

    try {
        if (!fs.existsSync(OUTPUT_DATA_PATH)) return fail('No local database found (extracted_league_data.json missing).');

        let allData = JSON.parse(fs.readFileSync(OUTPUT_DATA_PATH));
        if (leagueFilter) {
            allData = allData.filter(m => m.league === leagueFilter);
            send(`🔍 Filtered to ${allData.length} records for league: ${leagueFilter}`);
        }

        if (allData.length === 0) return fail('Local database is empty. Nothing to sync.');

        send(`📂 Found ${allData.length} records in local DB. Starting Database sync...`);
        const { uploaded, skipped } = await uploadMatchesToDatabase(allData, send);
        send(`✅ Sync complete! ${uploaded} documents written, ${skipped} skipped.`);
        done({ uploaded, skipped, total: allData.length });

    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [sync-local-to-database]', err);
        fail(`Server error: ${err.message}`);
    }
});

router.post('/api/extract-and-upload', async (req, res) => {

    const { matchData, leagueName, forceUpload } = req.body;
    console.log(`[DEBUG] [extract-and-upload] Received DOM matchData records=${matchData?.length} league=${leagueName} force=${!!forceUpload}`);

    // --- Setup Server-Sent Events ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (step, message, type = 'progress') => {
        const payload = JSON.stringify({ step, message, type, ts: Date.now() });
        res.write(`data: ${payload}\n\n`);
        console.log(`[Extract-Upload] [${type.toUpperCase()}] ${step}: ${message}`);
    };

    const done = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`);
        res.end();
    };

    const fail = (message) => {
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
    };

    try {
        if (!matchData || !leagueName) return fail('Missing matchData array or leagueName in request body.');

        send('init', `Target: DOM Data | League: ${leagueName}`);

        const extractedData = matchData;

        // ── Level 2: Game ID Deduplication ────────────────────────────────────
        send('dedup', '🔄 Level 2: Running Game ID deduplication against local database...');
        let allData = fs.existsSync(OUTPUT_DATA_PATH) ? JSON.parse(fs.readFileSync(OUTPUT_DATA_PATH)) : [];
        let newRecords = 0; let dupeCount = 0;
        extractedData.forEach(match => {
            const isDupe = allData.some(e => e.gameId === match.gameId && e.league === match.league);
            if (!isDupe) { allData.push(match); newRecords++; } else dupeCount++;
        });
        fs.writeFileSync(OUTPUT_DATA_PATH, JSON.stringify(allData, null, 2));
        send('dedup', `✅ Dedup complete: ${newRecords} new records saved, ${dupeCount} duplicates discarded.`);

        if (newRecords === 0) {
            const localDbCount = allData.length;
            return done({
                skipped: false,
                reason: `⚠️ All ${dupeCount} extracted records already exist in local DB. Database upload skipped. Use "🔄 Sync Local DB → Database" below to push all ${localDbCount} local records to Database.`,
                uploaded: 0,
                newRecords: 0,
                localDbCount,
                canSyncLocalDb: true,
            });
        }

        // ── Database Upload ───────────────────────────────────────────────────
        send('database', `🔥 Uploading ${newRecords} new records to Database Firestore...`);
        const newMatchData = allData.slice(allData.length - newRecords);
        const { uploaded, skipped } = await uploadMatchesToDatabase(newMatchData, (msg) => send('database', msg));

        send('database', `✅ Database upload complete! ${uploaded} documents written, ${skipped} skipped.`);
        done({ skipped: false, uploaded, newRecords, dupeCount });

    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/extract-and-upload]', err);
        fail(`Server error: ${err.message}`);
    }
});

    return router;
};
