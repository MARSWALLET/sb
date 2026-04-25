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

router.get('/api/ai/strategy-history', async (req, res) => {
    try {
        const history = await fetchStrategyHistory();
        res.json({ success: true, history });
    } catch (err) {
        console.error('[/api/ai/strategy-history]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/ai-provider', (req, res) => {
    try {
        const status = getPredictionProviderStatus();
        console.log(`[/api/ai-provider GET] Active: ${status.active} | ${status.providers.filter(p => p.available).length}/${status.providers.length} ready`);
        res.json({ success: true, ...status });
    } catch (err) {
        console.error('[/api/ai-provider GET] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/ai-provider', (req, res) => {
    try {
        const { provider } = req.body;
        if (!provider) return res.status(400).json({ success: false, error: '"provider" field required in body' });
        setActivePredictionProvider(provider);
        broadcastAiStatus('info', `🤖 AI Provider switched to: ${provider.toUpperCase()} (${PREDICTION_PROVIDERS[provider]?.label || provider})`);
        const status = getPredictionProviderStatus();
        console.log(`[/api/ai-provider POST] ✅ Switched to: ${provider}`);
        res.json({ success: true, active: provider, ...status });
    } catch (err) {
        console.error('[/api/ai-provider POST] Error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.get('/api/ai-strategy', async (req, res) => {
    try {
        const strategy = await getStrategy();
        res.json({ success: true, strategy });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/ai-memory', async (req, res) => {
    try {
        const log = await getLog();
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/api/ai-memory/:id', async (req, res) => {
    try {
        if (req.query.clearAll === 'true') {
            await clearLog();
            return res.json({ success: true, message: 'Log cleared perfectly' });
        }
        await deleteEntry(req.params.id);
        res.json({ success: true, message: 'Entry removed' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/ai-provider', (req, res) => {
    try {
        console.log('[DEBUG] [GET /api/ai-provider] Reading AI config...');
        const { readConfig } = require('./ai_router');
        const config = readConfig();
        console.log(`[DEBUG] [GET /api/ai-provider] Current provider: ${config.provider}`);
        res.json({ success: true, ...config });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [GET /api/ai-provider]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/ai-provider', express.json(), (req, res) => {
    try {
        const { provider, claudeModel, openaiModel, geminiModel } = req.body ?? {};
        console.log(`[DEBUG] [POST /api/ai-provider] Switching provider to: ${provider}`);

        const VALID = ['claude', 'openai', 'gemini'];
        if (!provider || !VALID.includes(provider.toLowerCase())) {
            return res.status(400).json({ success: false, error: `Invalid provider. Must be one of: ${VALID.join(', ')}` });
        }

        const { writeConfig } = require('./ai_router');
        const updates = { provider: provider.toLowerCase() };
        if (claudeModel) updates.claudeModel = claudeModel;
        if (openaiModel) updates.openaiModel = openaiModel;
        if (geminiModel) updates.geminiModel = geminiModel;

        const saved = writeConfig(updates);
        console.log(`[DEBUG] [POST /api/ai-provider] ✅ Provider switched to: ${saved.provider}`);
        res.json({ success: true, ...saved });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [POST /api/ai-provider]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

    return router;
};
