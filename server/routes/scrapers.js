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

    return router;
};
