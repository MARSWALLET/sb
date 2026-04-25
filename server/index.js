// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: Load .env FIRST before any other imports use process.env
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
console.log('[DEBUG] [Env] GEMINI_API_KEY loaded:', process.env.GEMINI_API_KEY ? '✅ Present' : '❌ MISSING — check .env file');

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Jimp = require('jimp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { startContinuousScraper, stopContinuousScraper, reloadContinuousScraper, getHistoricalResults, getHistoryStoreInfo, scrapeLiveListOnDemand } = require('./scraper');
const { captureLeagueResults } = require('./screenshot_scraper');
const { nativeCaptureLeagueResults } = require('./native_scraper');
const { uploadMatchesToDatabase, syncMatchesToDatabase, getDatabaseHistoryLog, setDatabaseHistoryLog, dbEvents } = require('./db_uploader');
const { fetchResultsFromDatabase, fetchTodayResultsFromDatabase, todayDDMMYYYY, fetchFullDayRawResults, fetchTeamHistoryFromDatabase, fetchAvailableDates, fetchAvailableLeagues, fetchAllHistoryLogs, computeTeamForm, computeH2HForm, computeVenueAdvantage, computeAllLeagueBaselines, getLeagueBaseline, getCachedDocs } = require('./db_reader');
const { toDbLeague, SUPPORTED_LEAGUES } = require('./constants');
const { saveAnalysis, getRecentContext, getLog, deleteEntry, getEntryById, clearLog, getStrategy, updateStrategy, fetchStrategyHistory, getLeagueIntelligence, updateLeagueIntelligence, getAnalysisByScopeAndDate, saveDailyTip, getDailyTip, getAllDailyTips } = require('./ai_memory');
const { deleteLeagueData } = require('./db_admin');
const { connectDb, PatternSnapshot } = require('./db_init');
const {
    detectBehaviourPatterns,
    saveBehaviourSignals,
    fetchBehaviourSignals,
    buildBehaviourPromptInjection,
    buildLeagueBaselinePromptInjection,
    computeLeagueStreakProfile,
    compareScreenshotResults
} = require('./behaviour_pattern_engine');
const {
    callPredictionAI,
    parseAIJson,
    getActivePredictionProvider,
    setActivePredictionProvider,
    getPredictionProviderStatus,
    PREDICTION_PROVIDERS,
} = require('./prediction_ai');

const EventEmitter = require('events');
const aiStatusEmitter = new EventEmitter();

// ─────────────────────────────────────────────────────────────────────────────
// Live Scores SSE emitter — pushes data to /api/live-stream clients
// every time the scraper returns a new batch, replacing the need for
// the frontend to poll /api/scores every 5 seconds.
// ─────────────────────────────────────────────────────────────────────────────
const liveScoresEmitter = new EventEmitter();
liveScoresEmitter.setMaxListeners(50); // Allow up to 50 concurrent SSE connections

const broadcastAiStatus = (action, message) => {
    aiStatusEmitter.emit('status', { action, message, timestamp: Date.now() });
};

/**
 * Broadcasts current live scores to all connected SSE clients.
 * Called by the scraper callback on every successful poll.
 * @param {Array} data - Array of { league, matches[] }
 * @param {string} scraperStatus - 'live' | 'initializing'
 */
function broadcastLiveScores(data, scraperStatus = 'live') {
    liveScoresEmitter.emit('update', { data, status: scraperStatus, timestamp: Date.now() });
}
const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// MOUNTED ROUTES
// ─────────────────────────────────────────────────────────────────────────────
const globalsPass = {
    get globalData() { return globalData; },
    set globalData(val) { globalData = val; },
    getLivePage: () => typeof getLivePage !== "undefined" ? getLivePage() : null,
    broadcastAiStatus,
    broadcastLiveScores
};

app.use("/", require("./routes/system")(globalsPass));
app.use("/", require("./routes/db")(globalsPass));
app.use("/", require("./routes/scrapers")(globalsPass));
app.use("/", require("./routes/ai")(globalsPass));
app.use("/", require("./routes/intelligence")(globalsPass));


// ─────────────────────────────────────────────────────────────────────────────
// Static file serving — serves the built React frontend in production.
// When deployed on Railway, "npm run build" copies client/dist → server/public
// The Express server then serves both the API and the React app on one port.
// ─────────────────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
    console.log('[DEBUG] [Server] Serving built React client from /public');
    app.use(express.static(PUBLIC_DIR));
} else {
    console.log('[DEBUG] [Server] No /public folder found — running in API-only mode (dev). Run "npm run build" to bundle the client.');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health  — Server health check for Admin panel monitoring
// Returns: uptime, memory, scraper status, Node version, environment
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/health */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/scraper-diag  — Live DOM diagnostic for the running scraper page
//
// Runs a real-time DOM inspection on the already-open vFootball browser page,
// returning selector match counts, top class names, and a body text preview.
// Replaces the need to run debug_live_page.js manually outside the server.
//
// Usage: GET /api/scraper-diag
// Returns: { selectorResults, classNames, bodyPreview, url, pageTitle }
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/scraper-diag */


// ─────────────────────────────────────────────────────────────────────────────
// GET /   — Human Friendly Index / API Directory
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai-status-stream */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/live-stream  — SSE push endpoint for live vFootball odds
//
// Replaces frontend polling of /api/scores every 5s with a push model:
// the server broadcasts immediately on each scraper update.
//
// Falls back cleanly if SSE is not supported (the old /api/scores is kept).
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/live-stream */



/* Extracted get / */


// ─────────────────────────────────────────────────────────────────────────────
let globalData = null;

// Connect to MongoDB
connectDb().catch(err => console.error("MongoDB start error:", err));

// ────────────────────────────────────────────────────────────────────────────────
// AUTO-SYNC: Re-scrape today's results every 10 minutes.
// Matches are live during the day so scores change constantly.
// We use syncMatchesToDatabase (smart diff) instead of full upload
// so only NEW records or SCORE CHANGES are written to MongoDB.
// ────────────────────────────────────────────────────────────────────────────────
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let autoSyncRunning = false;

async function runDailyAutoSync() {
    if (autoSyncRunning) {
        console.log('[Auto-Sync] ⏳ Previous sync still in progress — skipping this cycle.');
        return;
    }
    autoSyncRunning = true;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    console.log(`[Auto-Sync] 🔄 Starting daily auto-sync for ${today} across ${SUPPORTED_LEAGUES.length} leagues...`);

    let totalInserted = 0, totalUpdated = 0, totalUnchanged = 0, totalSkipped = 0;

    for (const league of SUPPORTED_LEAGUES) {
        try {
            console.log(`[Auto-Sync]   ▶️  Scraping: ${league}`);
            const result = await nativeCaptureLeagueResults(league, today, {});

            if (!result.success || !result.matchData || result.matchData.length === 0) {
                console.warn(`[Auto-Sync]   ⚠️  No matches found for ${league}`);
                continue;
            }

            // Stamp today and source on every record
            const extractedAt = new Date().toISOString();
            const [y, m, d] = today.split('-');
            const todayFormatted = `${d}/${m}/${y}`; // DD/MM/YYYY
            result.matchData.forEach(match => {
                if (!match.date || !/^\d{2}\/\d{2}\/\d{4}$/.test(match.date)) {
                    match.date = todayFormatted;
                }
                match.extractedAt = extractedAt;
                match.sourceTag   = 'auto-sync';
            });

            const { inserted, updated, unchanged, skipped } = await syncMatchesToDatabase(
                result.matchData,
                (msg) => console.log(`[Auto-Sync]   📊 ${league}: ${msg}`)
            );

            totalInserted  += inserted;
            totalUpdated   += updated;
            totalUnchanged += unchanged;
            totalSkipped   += skipped;

            console.log(`[Auto-Sync]   ✅ ${league} done — +${inserted} new | ~${updated} updated | ${unchanged} unchanged`);
        } catch (err) {
            console.error(`[Auto-Sync]   ❌ Error syncing ${league}:`, err.message);
        }
    }

    console.log(`[Auto-Sync] 🏁 Cycle complete — Total: +${totalInserted} new | ~${totalUpdated} updated | ${totalUnchanged} unchanged | ${totalSkipped} skipped`);
    autoSyncRunning = false;
}

// Run once immediately on boot (after a short delay so MongoDB is ready)
setTimeout(() => {
    console.log('[Auto-Sync] 🚀 Running initial daily sync on startup...');
    runDailyAutoSync();
}, 15000); // 15s delay to let DB connection settle

// Then repeat every 10 minutes
setInterval(() => {
    console.log('[Auto-Sync] ⏰ 10-minute interval triggered.');
    runDailyAutoSync();
}, AUTO_SYNC_INTERVAL_MS);

// Start the single long-lived Chrome window immediately on server boot
console.log('[DEBUG] [Server] Booting vFootball Terminal API...');
startContinuousScraper((newData) => {
    globalData = newData;
    // Push update immediately to all connected SSE clients
    // replacing the need for the frontend to poll on a timer
    broadcastLiveScores(newData, 'live');
    console.log(`[DEBUG] [Server] 📡 Broadcasted live scores to SSE clients (${newData.length} groups).`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/scores  — Live vFootball odds (polled every 2s by frontend)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/scores */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scraper/reload
// Forces the background scraper to close its Chrome instance and cleanly restart.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/scraper/reload */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/history?page=N
//
// Returns paginated completed vFootball results from the in-memory history
// store. Newest matches are on page 1 (today). "View More" increments page.
//
// The history store is built by the live scraper: each vFootball match is
// tracked from first sighting. After 4 minutes on the betslip it is
// considered "completed" and moved into the history ring buffer.
//
// If the store is empty (server just started), a warm-up message is returned
// so the UI stays informative rather than breaking.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/history */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/debug/history-store  — Internal debug endpoint
// Shows how many matches are accumulated in the history ring buffer.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/debug/history-store */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/debug/live-list  — Trigger a fresh live_list scrape and return raw data
// Useful for diagnosing what the scraper actually sees on the live list page.
// Returns: { leagues[], totalMatches, capturedAt }
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/debug/live-list */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/vfootball/sync-all
// Orchestrates a high-speed native sync for all primary leagues.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/admin/vfootball/sync-all */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/screenshot-results
// Captures a screenshot of the requested league's results and runs OCR.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/screenshot-results */



// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/history-logs
// Returns historical batch upload statuses from Database (history_logs collection).
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/history-logs */


// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/results
// Public endpoint — reads from Database Firestore using database_reader.
// Query params: ?page=1&pageSize=5&league=England+-+Virtual&dateFrom=...&dateTo=...
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/public/results */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/available-dates
// Returns a list of unique available dates in the database for the dropdown.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/available-dates */


// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER: runLearningForLeagueDate
// Shared core that powers:
//   1. The /api/vfootball/learning-mode HTTP endpoint
//   2. The midnight auto-learn scheduler (runs for yesterday)
//   3. The pre-analysis guardian (auto-runs if user forgot to click Commence Learning)
//
// Returns: { success, profile, matchesAnalyzed, cached, error }
// ─────────────────────────────────────────────────────────────────────────────
async function runLearningForLeagueDate(league, targetDate, { force = false } = {}) {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return { success: false, error: 'No AI API key configured (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY required).' };
    }

    console.log(`[Learning] 🧠 runLearningForLeagueDate: league=${league} date=${targetDate} force=${force}`);

    // ── Cache check — skip if already trained for this date ──────────────────
    const existingIntel = await getLeagueIntelligence(league);
    const dateKey = targetDate.replace(/\//g, '-');
    if (!force && existingIntel?.history?.[dateKey]) {
        console.log(`[Learning] ✅ Cache hit — ${league} on ${targetDate} already trained. Skipping.`);
        return { success: true, profile: existingIntel.history[dateKey], matchesAnalyzed: 0, cached: true };
    }

    // ── Fetch raw results ─────────────────────────────────────────────────────
    const allMatches = await fetchFullDayRawResults(league, targetDate);
    if (!allMatches || allMatches.length === 0) {
        console.warn(`[Learning] ⚠️ No match data for ${league} on ${targetDate}`);
        return { success: false, error: `No match data found for ${league} on ${targetDate}.` };
    }

    // ── Filter to real scores only (strips odds strings like "1(1.85)") ───────
    const realMatches = allMatches.filter(m => /^\d+[-:]\d+$/.test((m.score || '').trim()));
    if (realMatches.length === 0) {
        console.warn(`[Learning] ⚠️ No real-score matches for ${league} on ${targetDate} (only odds data)`);
        return { success: false, error: `No real scores yet for ${league} on ${targetDate}.` };
    }

    console.log(`[Learning] 📊 Analyzing ${realMatches.length} real-score matches for ${league} on ${targetDate}...`);

    // ── Build stats ───────────────────────────────────────────────────────────
    const compressedMatches = realMatches.map(m => `[${m.time || '--'}] ${m.homeTeam} ${m.score} ${m.awayTeam}`);
    const teamStats = {};
    for (const m of realMatches) {
        const [hg, ag] = (m.score || '0:0').replace('-', ':').split(':').map(Number);
        const addStat = (team, isHome, scored, conceded) => {
            if (!teamStats[team]) teamStats[team] = { played:0, wins:0, draws:0, losses:0, homeWins:0, homePlayed:0, awayWins:0, awayPlayed:0, goalsFor:0, goalsAgainst:0 };
            const s = teamStats[team];
            s.played++; s.goalsFor += scored; s.goalsAgainst += conceded;
            if (isHome) { s.homePlayed++; if (scored > conceded) s.homeWins++; }
            else        { s.awayPlayed++; if (scored > conceded) s.awayWins++;  }
            if (scored > conceded) s.wins++;
            else if (scored === conceded) s.draws++;
            else s.losses++;
        };
        if (m.homeTeam) addStat(m.homeTeam, true,  hg, ag);
        if (m.awayTeam) addStat(m.awayTeam, false, ag, hg);
    }
    const teamStatsSummary = Object.entries(teamStats).map(([team, s]) => {
        const hwPct = s.homePlayed > 0 ? Math.round(s.homeWins / s.homePlayed * 100) : 0;
        const awPct = s.awayPlayed > 0 ? Math.round(s.awayWins / s.awayPlayed * 100) : 0;
        return `${team}: played=${s.played} W=${s.wins} D=${s.draws} L=${s.losses} HomeWin%=${hwPct} AwayWin%=${awPct} GF=${s.goalsFor} GA=${s.goalsAgainst}`;
    }).join('\n');

    const homeWins = realMatches.filter(m => { const [h,a]=(m.score||'0:0').replace('-',':').split(':').map(Number); return h>a; }).length;
    const draws    = realMatches.filter(m => { const [h,a]=(m.score||'0:0').replace('-',':').split(':').map(Number); return h===a; }).length;
    const awayWins = realMatches.length - homeWins - draws;
    const venueEffect = `HomeWin=${Math.round(homeWins/realMatches.length*100)}% Draw=${Math.round(draws/realMatches.length*100)}% AwayWin=${Math.round(awayWins/realMatches.length*100)}% (from ${realMatches.length} matches)`;

    // ── AI Prompt ─────────────────────────────────────────────────────────────
    const prompt = `You are a Deep Learning AI profiling the virtual football league "${league}" for the date ${targetDate}.
Analyze every match result and team performance to produce a structured intelligence profile.

Raw Match Results (real scores only):
${compressedMatches.join('\n')}

Pre-computed Team Stats:
${teamStatsSummary}

League Venue Effect: ${venueEffect}

Return EXACTLY valid JSON:
{
  "leagueVibe": "Concise description of pace, goal frequency, home advantage strength, and overall vibe",
  "venueEffect": "${venueEffect}",
  "topPerformingTeams": [{"team": "Name", "homeWinPct": 75, "awayWinPct": 40, "reason": "Why they are strong"}],
  "worstPerformingTeams": [{"team": "Name", "homeWinPct": 15, "awayWinPct": 5, "reason": "Their weaknesses"}],
  "recurringRules": ["Specific actionable pattern"],
  "drawTendency": "Draw rate, common scorelines, and which fixture types produce draws",
  "teamStats": {"TeamName": {"homeWinPct": 75, "awayWinPct": 35, "avgGoals": 2.4, "formNote": "Brief note"}}
}

Return ONLY valid JSON. No markdown, no wrappers. Be specific.`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);
        let aiResponse;
        try {
            aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.2,
                    response_format: { type: 'json_object' }
                })
            });
        } catch (fetchErr) {
            if (fetchErr.name === 'AbortError') return { success: false, error: 'DeepSeek timed out after 60s.' };
            throw fetchErr;
        } finally { clearTimeout(timeoutId); }

        const rawBody = await aiResponse.text();
        if (!aiResponse.ok) {
            return { success: false, error: `DeepSeek error ${aiResponse.status}: ${rawBody.slice(0, 200)}` };
        }

        const parsed = JSON.parse(rawBody);
        const rawContent = parsed.choices?.[0]?.message?.content || '';
        let profile;
        try { profile = JSON.parse(rawContent.replace(/```json|```/g, '').trim()); }
        catch { return { success: false, error: 'AI returned invalid JSON profile.' }; }

        // Quality gate
        if (!Array.isArray(profile.topPerformingTeams) || profile.topPerformingTeams.length < 2 ||
            !Array.isArray(profile.recurringRules)    || profile.recurringRules.length < 2 ||
            typeof profile.leagueVibe !== 'string'    || profile.leagueVibe.length < 20) {
            return { success: false, error: 'AI returned a vague or incomplete profile.' };
        }

        profile.venueEffect = venueEffect;
        await updateLeagueIntelligence(league, targetDate, profile);
        console.log(`[Learning] ✅ Profile saved for ${league} on ${targetDate} (${realMatches.length} matches).`);
        return { success: true, profile, matchesAnalyzed: realMatches.length, cached: false };

    } catch (err) {
        console.error(`[Learning] ❌ Unexpected error for ${league} / ${targetDate}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDNIGHT SCHEDULER: Auto-learn yesterday's data when a new day starts.
// Fires at 00:01 every day (1 minute past midnight) so yesterday's full
// match results are already in MongoDB before learning begins.
// ─────────────────────────────────────────────────────────────────────────────
function scheduleMidnightLearning() {
    const msUntilMidnight = () => {
        const now  = new Date();
        const next = new Date();
        next.setDate(now.getDate() + 1);
        next.setHours(0, 1, 0, 0); // 00:01:00
        return next - now;
    };

    const runAndReschedule = async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const [y, m, d] = yesterday.toISOString().split('T')[0].split('-');
        const yesterdayFormatted = `${d}/${m}/${y}`; // DD/MM/YYYY

        console.log(`[Midnight Learning] 🌙 New day detected! Auto-learning yesterday (${yesterdayFormatted}) across ${SUPPORTED_LEAGUES.length} leagues...`);
        broadcastAiStatus('learning', `🌙 Midnight auto-learning: processing yesterday (${yesterdayFormatted})...`);

        for (const league of SUPPORTED_LEAGUES) {
            console.log(`[Midnight Learning]   📚 Training: ${league}...`);
            const result = await runLearningForLeagueDate(league, yesterdayFormatted, { force: false });
            if (result.success && !result.cached) {
                console.log(`[Midnight Learning]   ✅ ${league}: profile saved (${result.matchesAnalyzed} matches)`);
                broadcastAiStatus('learned', `✅ Yesterday learned: ${league} — ${result.matchesAnalyzed} matches profiled`);
            } else if (result.cached) {
                console.log(`[Midnight Learning]   ⏸️ ${league}: already trained — skipped`);
            } else {
                console.warn(`[Midnight Learning]   ⚠️ ${league}: ${result.error}`);
            }
        }

        console.log('[Midnight Learning] 🏁 Yesterday learning complete. Scheduling next midnight run...');
        setTimeout(runAndReschedule, msUntilMidnight());
    };

    const delay = msUntilMidnight();
    console.log(`[Midnight Learning] ⏰ Scheduled for 00:01 tonight (in ${Math.round(delay / 60000)} minutes)`);
    setTimeout(runAndReschedule, delay);
}

scheduleMidnightLearning();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze
// Sends match data to DeepSeek AI and uses ai_memory system to feed past context.
// Body: { scope, dateLabel, dateFrom, dateTo, league, deepseekKey }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {

    try {
        const { scope, dateLabel, dateFrom, dateTo, league, deepseekKey } = req.body;
        const apiKey = deepseekKey || process.env.DEEPSEEK_API_KEY;

        if (!apiKey) return res.status(400).json({ success: false, error: 'DEEPSEEK_API_KEY missing.' });

        console.log(`[DEBUG] [/api/analyze] scope=${scope} label=${dateLabel}`);

        // PREVENT DUPLICATE TOKEN WASTE
        const existingData = await getAnalysisByScopeAndDate(scope, dateLabel, league);
        if (existingData) {
            console.log(`[DEBUG] [/api/analyze] Found existing analysis in Database. Returning cached data.`);
            return res.json({ success: true, analysis: existingData.analysis, tokensUsed: 0, cached: true });
        }

        // Fetch matches from Database
        let matches = [];
        if (scope === 'today') {
            matches = await fetchTodayResultsFromDatabase(league);
        } else {
            const result = await fetchResultsFromDatabase({ league, dateFrom, dateTo, page: 1, pageSize: 100 });
            matches = result.dates.flatMap(d => Object.values(d.leagues).flat());
        }

        if (!matches || matches.length === 0) return res.status(400).json({ success: false, error: 'No matches found in Database for this range.' });

        // ── PRE-ANALYSIS LEARNING GUARDIAN ────────────────────────────────────
        // Before calling DeepSeek for analysis, ensure league intelligence has been
        // trained for this date. If the user forgot to click "Commence Learning",
        // we auto-run it now so the analysis uses fresh league context — saving tokens.
        if (league) {
            const targetDateForLearning = dateFrom || dateLabel; // DD/MM/YYYY
            if (targetDateForLearning) {
                const intel = await getLeagueIntelligence(league);
                const dateKey = targetDateForLearning.replace(/\//g, '-');
                if (!intel?.history?.[dateKey]) {
                    console.log(`[Pre-Analysis Guard] 🧠 League intelligence missing for ${league} on ${targetDateForLearning} — auto-running learning first...`);
                    broadcastAiStatus('learning', `🧠 Auto-training ${league} before analysis (${targetDateForLearning})...`);
                    const learnResult = await runLearningForLeagueDate(league, targetDateForLearning, { force: false });
                    if (learnResult.success) {
                        console.log(`[Pre-Analysis Guard] ✅ Learning complete — ${learnResult.matchesAnalyzed} matches profiled. Proceeding with analysis.`);
                        broadcastAiStatus('learned', `✅ Auto-learned ${league} (${learnResult.matchesAnalyzed} matches). Running analysis...`);
                    } else {
                        console.warn(`[Pre-Analysis Guard] ⚠️ Auto-learning failed (${learnResult.error}) — proceeding with analysis anyway.`);
                    }
                } else {
                    console.log(`[Pre-Analysis Guard] ✅ League intelligence already cached for ${league} on ${targetDateForLearning}.`);
                }
            }
        }

        const analyzeMatches = matches.slice(0, 100);
        const matchSummary = analyzeMatches.map(m => `${m.date} | ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam} (${m.league})`).join('\n');

        const memoryContext = await getRecentContext(5);

        const prompt = `You are a strict, top-tier virtual football (vFootball) analyst bot.
CRUCIAL DIRECTIVES:
1. Return ONLY pure, highly-structured JSON. Do not include markdown code block syntax.
2. Be extremely concise. Avoid all conversational filler or pleasantries.
3. Your primary objective is to act as a self-improving prediction node.
4. Compare your explicitly stated 'Predictions Given' from the provided memory against the 'Current New Database Matches'.
5. ONLY pivot if the strategy is genuinely failing repeatedly.

Context: Analyzed Scope: ${scope} (${dateLabel})
Matches: ${analyzeMatches.length} recent games.
${memoryContext}
Current New Database Matches:
${matchSummary}

Provide a comprehensive analysis in valid JSON format with EXACTLY these fields:
{
  "summary": "2-3 sentence executive summary of the day's results",
  "reflection": "Be critical: evaluate if your LAST predictions (O1.5, GG, etc) in memory succeeded or failed based on these new matching results. Was the strategy effective?",
  "drawAnalysis": {
     "0:0": 0,
     "1:1": 0,
     "2:2": 0,
     "insights": "Detailed tactical insights on drawing patterns."
  },
  "bettingPredictions": {
     "over1_5": "Predict specific logical targets for Over 1.5",
     "over2_5": "Predict targets for Over 2.5",
     "GG": "Predict targets for Both Teams to Score (GG)",
     "correctScore": "Bold prediction for a correct score"
  },
  "strategyCommand": {
     "action": "maintain OR pivot (ONLY pivot if current strategy has failed repeatedly)",
     "newStrategy": "If pivot: describe the new strategy. If maintain: null",
     "newRules": ["If pivot: strict rule 1", "If pivot: strict rule 2"]
  }
}

Return ONLY valid JSON.`;

        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 1500,
                response_format: { type: "json_object" }
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('[Database Index Debug/Error Details]: [/api/analyze] DeepSeek error:', errText);
            return res.status(response.status).json({ success: false, error: `DeepSeek API error: ${errText.slice(0, 200)}` });
        }

        const data = await response.json();
        const rawContent = data.choices?.[0]?.message?.content || '';
        const tokensUsed = data.usage?.total_tokens || 0;

        let analysis;
        try {
            analysis = JSON.parse(rawContent.replace(/```json|```/g, '').trim());
        } catch (e) {
            return res.status(500).json({ success: false, error: 'DeepSeek returned invalid JSON.' });
        }

        // Update the AI strategy tracker
        if (analysis.strategyCommand) {
            let successDelta = 0;
            let failDelta = 0;
            const reflectionL = (analysis.reflection || '').toLowerCase();
            if (reflectionL.includes('successful') || reflectionL.includes('succeeded') || reflectionL.includes('hit')) {
                successDelta = 1;
            } else if (reflectionL.includes('failed') || reflectionL.includes('unsuccessful') || reflectionL.includes('missed') || reflectionL.includes('wrong')) {
                failDelta = 1;
            }
            await updateStrategy(analysis.strategyCommand, successDelta, failDelta);
        }

        await saveAnalysis({ scope, dateLabel, dateFrom, dateTo, league, matchCount: analyzeMatches.length, analysis, tokensUsed });

        res.json({ success: true, analysis, tokensUsed });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/analyze]', err.message);
        
        // Detect Database RESOURCE_EXHAUSTED (gRPC 8) — quota or missing composite index
        const code = err?.code || err?.details?.code;
        const msg  = (err?.message || '').toLowerCase();
        const isDatabaseQuotaErr = code === 8 || code === 'resource-exhausted' ||
            msg.includes('resource_exhausted') || msg.includes('quota exceeded') ||
            msg.includes('requires an index') || msg.includes('resource exhausted');
        
        if (isDatabaseQuotaErr) {
            const indexUrl = (err?.message || '').match(/https:\/\/console\.database\.google\.com[^\s]*/)?.[0];
            if (indexUrl) {
                console.error('[Database Index Debug/Error Details]: 🔗 Database needs a composite index. CREATE IT HERE:', indexUrl);
            } else {
                console.error('[Database Index Debug/Error Details]: 🔴 Database Quota/Index error — visit https://console.database.google.com/ to check your Firestore indexes and quotas.');
            }
            return res.status(503).json({
                success: false,
                error: '⚠️ Database quota exceeded or a required Firestore index is missing. The analysis engine is temporarily unavailable — your request has been queued. Check the server console for the index creation link, or wait for the quota to reset (usually within 24 hours).',
                errorType: 'FIREBASE_QUOTA',
                indexUrl: indexUrl || null,
            });
        }
        
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/learning-mode
// Ingests a full raw day of real match results and builds a League Intelligence Profile.
// Improvements:
//   1. Real-score filter — strips odds-format strings (e.g. "1(1.85)") before training
//   2. Multi-day rolling storage — each date saved separately, merged over last 7 days
//   3. Expanded schema — team-level stats + venueEffect injected into profile
//   4. Temperature 0.2 + quality gate — rejects vague AI responses
//   5. Profile preview returned to UI for display
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vfootball/learning-mode', async (req, res) => {
    // DeepSeek is primary for league training (long reasoning); Claude is the fallback
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'No AI API key configured in server .env (DEEPSEEK_API_KEY or ANTHROPIC_API_KEY required).' });

    const usingDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    console.log(`[DEBUG] [learning-mode] Using ${usingDeepSeek ? 'DeepSeek' : 'Claude/Anthropic (fallback)'} for training.`);

    try {
        const { league, targetDate, force = false } = req.body;
        if (!league || !targetDate) return res.status(400).json({ success: false, error: 'league and targetDate are required.' });

        // ── Priority 2: Check per-date cache (not just "last trained date") ────
        const existingIntel = await getLeagueIntelligence(league);
        const dateKey = targetDate.replace(/\//g, '-'); // normalise slashes
        if (!force && existingIntel?.history?.[dateKey]) {
            console.log(`[DEBUG] [learning-mode] Cache hit — ${league} on ${targetDate} already trained.`);
            return res.json({
                success: true,
                profile: existingIntel.history[dateKey],
                merged: existingIntel.merged || null,
                cached: true,
                matchesAnalyzed: 0
            });
        }

        const allMatches = await fetchFullDayRawResults(league, targetDate);
        if (!allMatches || allMatches.length === 0) {
            return res.status(400).json({ success: false, error: `No match data found for ${league} on ${targetDate}. Upload results for this date first via the Admin → Sync tab.` });
        }

        // ── Priority 1: Filter to REAL scores only ────────────────────────────
        // Real scores look like "2-1", "2:1", "0-0", "3-2" — odds look like "1(1.85) X(3.40) 2(2.10)"
        const realMatches = allMatches.filter(m => /^\d+[-:]\d+$/.test((m.score || '').trim()));
        const oddsOnlyCount = allMatches.length - realMatches.length;
        if (oddsOnlyCount > 0) {
            console.log(`[DEBUG] [learning-mode] Filtered out ${oddsOnlyCount} odds-only records. Using ${realMatches.length} real-score matches.`);
        }
        if (realMatches.length === 0) {
            return res.status(400).json({
                success: false,
                error: `Found ${allMatches.length} match records for ${league} on ${targetDate} but none have real scores yet (only odds data). Please upload native scraper results first.`
            });
        }

        console.log(`[DEBUG] [learning-mode] Analyzing ${realMatches.length} real-score matches for ${league} on ${targetDate}...`);

        // ── Priority 3: Compress with home/away context ────────────────────
        const compressedMatches = realMatches.map(m =>
            `[${m.time || '--'}] ${m.homeTeam} ${m.score} ${m.awayTeam}`
        );

        // Build per-team goal tallies from real scores for team-level stats
        const teamStats = {};
        for (const m of realMatches) {
            const [hg, ag] = (m.score || '0:0').replace('-', ':').split(':').map(Number);
            const addStat = (team, isHome, scored, conceded) => {
                if (!teamStats[team]) teamStats[team] = { played: 0, wins: 0, draws: 0, losses: 0, homeWins: 0, homePlayed: 0, awayWins: 0, awayPlayed: 0, goalsFor: 0, goalsAgainst: 0 };
                const s = teamStats[team];
                s.played++; s.goalsFor += scored; s.goalsAgainst += conceded;
                if (isHome) { s.homePlayed++; if (scored > conceded) s.homeWins++; }
                else        { s.awayPlayed++; if (scored > conceded) s.awayWins++;  }
                if (scored > conceded) s.wins++;
                else if (scored === conceded) s.draws++;
                else s.losses++;
            };
            if (m.homeTeam) addStat(m.homeTeam, true,  hg, ag);
            if (m.awayTeam) addStat(m.awayTeam, false, ag, hg);
        }
        const teamStatsSummary = Object.entries(teamStats)
            .map(([team, s]) => {
                const hwPct = s.homePlayed > 0 ? Math.round(s.homeWins / s.homePlayed * 100) : 0;
                const awPct = s.awayPlayed > 0 ? Math.round(s.awayWins / s.awayPlayed * 100) : 0;
                return `${team}: played=${s.played} W=${s.wins} D=${s.draws} L=${s.losses} HomeWin%=${hwPct} AwayWin%=${awPct} GF=${s.goalsFor} GA=${s.goalsAgainst}`;
            })
            .join('\n');

        // League-wide venue effect
        const homeWins = realMatches.filter(m => { const [h,a]=(m.score||'0:0').replace('-', ':').split(':').map(Number); return h>a; }).length;
        const draws    = realMatches.filter(m => { const [h,a]=(m.score||'0:0').replace('-', ':').split(':').map(Number); return h===a; }).length;
        const awayWins = realMatches.length - homeWins - draws;
        const venueEffect = `HomeWin=${Math.round(homeWins/realMatches.length*100)}% Draw=${Math.round(draws/realMatches.length*100)}% AwayWin=${Math.round(awayWins/realMatches.length*100)}% (from ${realMatches.length} matches)`;

        // ── Priority 3: Expanded prompt schema ───────────────────────────────
        const prompt = `You are a Deep Learning AI profiling the virtual football league "${league}" for the date ${targetDate}.
Analyze every match result and team performance to produce a structured intelligence profile.

Raw Match Results (real scores only):
${compressedMatches.join('\n')}

Pre-computed Team Stats (from the same matches above):
${teamStatsSummary}

League Venue Effect: ${venueEffect}

You must return EXACTLY valid JSON:
{
  "leagueVibe": "Concise description of pace, goal frequency, home advantage strength, and overall vibe",
  "venueEffect": "${venueEffect}",
  "topPerformingTeams": [
    {"team": "Name", "homeWinPct": 75, "awayWinPct": 40, "reason": "Why they are strong"}
  ],
  "worstPerformingTeams": [
    {"team": "Name", "homeWinPct": 15, "awayWinPct": 5, "reason": "Their weaknesses"}
  ],
  "recurringRules": [
    "Specific actionable pattern (e.g. Over 2.5 lands 78% when Arsenal hosts bottom-half teams)"
  ],
  "drawTendency": "Draw rate, most common draw scorelines, and which fixture types produce draws",
  "teamStats": {
    "TeamName": { "homeWinPct": 75, "awayWinPct": 35, "avgGoals": 2.4, "formNote": "Brief note" }
  }
}

Return ONLY valid JSON. No markdown, no wrappers. Be specific — avoid generic statements.`;

        // ── Priority 4: 60s timeout + low temperature ────────────────────────
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);

        let aiResponse;
        try {
            aiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.2,   // lowered from 0.7 — factual analysis needs low temp
                    response_format: { type: 'json_object' }
                })
            });
        } catch (fetchErr) {
            if (fetchErr.name === 'AbortError') {
                return res.status(504).json({ success: false, error: 'The DeepSeek API did not respond within 60 seconds. This usually means the service is temporarily unreachable. Please try again in a moment.' });
            }
            throw fetchErr;
        } finally {
            clearTimeout(timeoutId);
        }

        // Read raw body — NEVER assume it is JSON
        const rawBody = await aiResponse.text();
        console.log(`[DEBUG] [learning-mode] DeepSeek HTTP ${aiResponse.status} — body length: ${rawBody.length}`);

        if (!aiResponse.ok) {
            if (rawBody.trim().startsWith('<')) {
                const statusCode = aiResponse.status;
                const friendly =
                    statusCode === 504 ? 'DeepSeek is temporarily unreachable (504). Please retry in 1–2 minutes.'
                    : statusCode === 503 ? 'DeepSeek is temporarily unavailable (503). Please retry shortly.'
                    : statusCode === 429 ? 'DeepSeek rate limit reached (429). Wait a few minutes before retrying.'
                    : `DeepSeek returned an unexpected error (HTTP ${statusCode}). Please try again.`;
                console.error(`[learning-mode] Non-JSON error from DeepSeek (${statusCode}):`, rawBody.slice(0, 200));
                return res.status(502).json({ success: false, error: friendly });
            }
            let errJson;
            try { errJson = JSON.parse(rawBody); } catch { errJson = null; }
            const errMsg = errJson?.error?.message || errJson?.message || rawBody.slice(0, 300);
            return res.status(aiResponse.status).json({ success: false, error: `DeepSeek API error: ${errMsg}` });
        }

        let data;
        try { data = JSON.parse(rawBody); } catch {
            return res.status(500).json({ success: false, error: 'DeepSeek returned a non-JSON response. The service may be experiencing issues — please retry.' });
        }

        const rawContent = data.choices?.[0]?.message?.content || '';
        let profile;
        try {
            profile = JSON.parse(rawContent.replace(/```json|```/g, '').trim());
        } catch (e) {
            console.error('[learning-mode] Profile JSON parse failed:', rawContent.slice(0, 300));
            return res.status(500).json({ success: false, error: 'The AI returned a response that could not be parsed as a league profile. Try again or check the server logs.' });
        }

        // ── Priority 4: Quality gate ──────────────────────────────────────────
        const hasTopTeams = Array.isArray(profile.topPerformingTeams) && profile.topPerformingTeams.length >= 2;
        const hasRules    = Array.isArray(profile.recurringRules) && profile.recurringRules.length >= 2;
        const hasVibe     = typeof profile.leagueVibe === 'string' && profile.leagueVibe.length > 20;
        if (!hasTopTeams || !hasRules || !hasVibe) {
            console.warn('[learning-mode] ⚠️ Low-quality profile detected — rejecting:', JSON.stringify(profile).slice(0, 200));
            return res.status(422).json({
                success: false,
                error: 'The AI returned a profile that was too vague or incomplete. This can happen with very small datasets. Try a date with more match records.'
            });
        }

        // Inject the pre-computed venue effect into the profile
        profile.venueEffect = venueEffect;

        // ── Priority 2: Save per-date + update 7-day merged profile ──────────
        await updateLeagueIntelligence(league, targetDate, profile);
        console.log(`[DEBUG] [learning-mode] ✅ Profile saved for ${league} on ${targetDate} (${realMatches.length} matches).`);

        // ── Priority 5: Return full profile preview to UI ─────────────────────
        res.json({
            success: true,
            profile,
            matchesAnalyzed: realMatches.length,
            oddsFilteredOut: oddsOnlyCount,
            cached: false
        });

    } catch (err) {
        console.error('[/api/vfootball/learning-mode] Unhandled error:', err.message);
        res.status(500).json({ success: false, error: `Unexpected server error: ${err.message}` });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/strategy-history
// Fetch the permanent AI Brain Ledger
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai/strategy-history */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-provider
// Returns active prediction AI provider + capability status for all providers
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai-provider */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-provider
// Body: { provider: 'deepseek' | 'gemini' | 'claude' }
// Switches global AI provider for all future predictions (persists for session)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/ai-provider */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/predict-live
// Employs DB Head-to-Head + League Intelligence + Strategy to predict a single fixture
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vfootball/predict-live', async (req, res) => {
    try {
        let { league, homeTeam, awayTeam, provider: reqProvider } = req.body;
        const provider = reqProvider || getActivePredictionProvider();
        console.log(`[predict-live] 🤖 AI Provider: ${provider.toUpperCase()} (${PREDICTION_PROVIDERS[provider]?.label || provider})`);
        if (!league || !homeTeam || !awayTeam) return res.status(400).json({ success: false, error: 'league, homeTeam, awayTeam required' });

        // Auto-resolve generic live scraper league names using the database
        if (league === 'vFootball Live Odds') {
            const rawData = await getCachedDocs();
            const realMatch = rawData.find(m => m.homeTeam === homeTeam || m.awayTeam === homeTeam);
            if (realMatch && realMatch.league) {
                league = realMatch.league;
                console.log(`[DEBUG] [predict-live] Auto-resolved generic league to: ${league}`);
            }
        }

        const h2hMatches = await fetchTeamHistoryFromDatabase(league, homeTeam, awayTeam, 10);
        const h2hText = h2hMatches.map(m => `${m.date} | ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam}`).join('\n');

        // Compute current form for both teams + league baseline (parallel for speed)
        const [homeForm, awayForm, h2hForm, leagueBaseline] = await Promise.all([
            computeTeamForm(league, homeTeam, 8),
            computeTeamForm(league, awayTeam, 8),
            computeH2HForm(league, homeTeam, awayTeam, 10),
            computeVenueAdvantage(league)
        ]);

        // 🧬 Fetch full League DNA Baseline (BTTS%, O1.5%, O2.5%, avgGoals, top scorelines)
        // Tier-1 macro-behavioral context — overrides generic form defaults in AI prompt
        const fullBaselineDNA = await getLeagueBaseline(league);
        const leagueBaselineDNAInjection = fullBaselineDNA
            ? buildLeagueBaselinePromptInjection(fullBaselineDNA)
            : '';
        console.log(`[predict-live] 🧬 League DNA: ${fullBaselineDNA
            ? `O1.5=${fullBaselineDNA.stats?.over1_5Percent}% BTTS=${fullBaselineDNA.stats?.bttsPercent}% O2.5=${fullBaselineDNA.stats?.over2_5Percent}% Draw=${fullBaselineDNA.stats?.drawPercent}% (${fullBaselineDNA.matchCount} matches)`
            : 'No cached baseline — run Sync All + Recompute DNA first'}`);

        // Build venue-split form text for AI prompt (the key improvement)
        const homeFormTxt = [
            `${homeTeam} (HOME): Overall=${homeForm.recentForm} | HomeForm=${homeForm.homeForm} | HomeWin%=${homeForm.homeWinPercent}% | AwayWin%=${homeForm.awayWinPercent}%`,
            `  HomeAvgGoals=${homeForm.homeGoalsScored} | AwayAvgGoals=${homeForm.awayGoalsScored} | DrawRate=${homeForm.drawPercent}% | Streak=${homeForm.streak}`,
            `  O1.5%=${homeForm.over1_5_percent}% | O2.5%=${homeForm.over2_5_percent}% | GG%=${homeForm.btts_percent}%`
        ].join('\n');

        const awayFormTxt = [
            `${awayTeam} (AWAY): Overall=${awayForm.recentForm} | HomeForm=${awayForm.homeForm} | HomeWin%=${awayForm.homeWinPercent}% | AwayWin%=${awayForm.awayWinPercent}%`,
            `  HomeAvgGoals=${awayForm.homeGoalsScored} | AwayAvgGoals=${awayForm.awayGoalsScored} | DrawRate=${awayForm.drawPercent}% | Streak=${awayForm.streak}`,
            `  O1.5%=${awayForm.over1_5_percent}% | O2.5%=${awayForm.over2_5_percent}% | GG%=${awayForm.btts_percent}%`
        ].join('\n');

        const h2hFormTxt = [
            `H2H (Last ${h2hForm.matchesAnalysed} meetings): O1.5=${h2hForm.over1_5_percent}% | O2.5=${h2hForm.over2_5_percent}% | GG=${h2hForm.btts_percent}%`,
            `  HomeWinsInH2H=${h2hForm.homeWinsInH2H} | AwayWinsInH2H=${h2hForm.awayWinsInH2H} | DrawsInH2H=${h2hForm.drawsInH2H} | VenueBias=${h2hForm.homeAdvantageH2H}`
        ].join('\n');

        const leagueBaselineTxt = `LEAGUE BASELINE (${leagueBaseline.matchesAnalysed} games): Home wins ${leagueBaseline.homeWinPercent}% | Away wins ${leagueBaseline.awayWinPercent}% | Draws ${leagueBaseline.drawPercent}%`;

        console.log(`[DEBUG] [predict-live] Form computed. HomeWin%=${homeForm.homeWinPercent}% AwayWin%=${awayForm.awayWinPercent}% H2H Bias=${h2hForm.homeAdvantageH2H} LeagueHome%=${leagueBaseline.homeWinPercent}%`);

        // ── Behaviour Pattern Analysis ────────────────────────────────────────
        // Detects win streak fatigue, big team clashes, and loss reversal signals.
        // These override simple win% predictions when anomalous patterns are present.
        let behaviourInjection = '';
        let behaviourSignalData = [];
        try {
            console.log('[DEBUG] [predict-live] 🔬 Running behaviour pattern analysis...');
            const rawSignals = await detectBehaviourPatterns(
                [{ homeTeam, awayTeam }],
                league
            );
            behaviourSignalData = rawSignals;
            behaviourInjection = buildBehaviourPromptInjection(rawSignals);
            if (rawSignals.length > 0) {
                console.log(`[DEBUG] [predict-live] ✅ ${rawSignals.length} behaviour signals detected — injecting into prompt.`);
                // Persist signals for history/dashboard
                const today = todayDDMMYYYY();
                await saveBehaviourSignals(rawSignals, league, today).catch(e =>
                    console.error('[predict-live] Behaviour save error (non-fatal):', e.message)
                );
            } else {
                console.log('[DEBUG] [predict-live] ✅ No anomalous behaviour signals for this fixture.');
            }
        } catch (bErr) {
            console.error('[DEBUG] [predict-live] ⚠️ Behaviour pattern analysis failed (non-fatal):', bErr.message);
        }

        // ── PRE-LIVE PREDICT GUARDIAN ─────────────────────────────────────────
        // Check if there is league intel available. If not heavily trained for today, try a quick auto-learn 
        // using whatever matches have completed today so far.
        const todayStr = todayDDMMYYYY();
        let intelDoc = await getLeagueIntelligence(league);
        const todayKey = todayStr.replace(/\//g, '-');
        
        if (!intelDoc?.history?.[todayKey]) {
            console.log(`[Pre-Live Guard] 🧠 No learning found for today (${todayStr}) in ${league} — auto-running before prediction...`);
            broadcastAiStatus('learning', `🧠 Auto-training ${league} live patterns...`);
            const learnResult = await runLearningForLeagueDate(league, todayStr, { force: false });
            if (learnResult.success) {
                console.log(`[Pre-Live Guard] ✅ Auto-learning done. Matches: ${learnResult.matchesAnalyzed}`);
                intelDoc = await getLeagueIntelligence(league); // Refresh intel after learning
            } else {
                console.warn(`[Pre-Live Guard] ⚠️ Auto-learning skipped/failed: ${learnResult.error} — using existing baseline.`);
            }
        }

        const intelStr = intelDoc ? JSON.stringify(intelDoc.merged || intelDoc.profile || intelDoc) : 'No deep learning profile available yet.';
        const strategy = await getStrategy();

        const prompt = `You are an elite virtual football analyst. Predict the upcoming fixture.
CRITICAL RULES:
1. Return ONLY pure JSON.
2. NEVER use or reference betting odds in your prediction — odds are UNRELIABLE in vFootball. Favourites lose regularly.
3. Base ALL predictions strictly on: home/away form %, H2H venue record, and league intelligence.
4. A team playing at HOME with 60%+ HomeWin% vs a team with <25% AwayWin% = predict Home Win, NOT Draw.
5. Only predict Draw if BOTH teams have draw rates >30% AND no clear home advantage exists in form or H2H.
6. Use the exact HomeWin%, AwayWin%, H2H venue bias numbers provided — do NOT guess.

League: ${league}
Fixture: ${homeTeam} (Home) vs ${awayTeam} (Away)

== 📊 VENUE-SPLIT TEAM FORM ==
${homeFormTxt}
${awayFormTxt}

== 🔄 HEAD-TO-HEAD HISTORY (last ${h2hMatches.length} meetings) ==
${h2hText || 'No direct history found. Rely on form and league baseline.'}
${h2hFormTxt}

== 🏠 LEAGUE VENUE BASELINE ==
${leagueBaselineTxt}
${leagueBaselineDNAInjection}
== 🧠 LEAGUE INTELLIGENCE PROFILE ==
${intelStr}

${behaviourInjection}
== ⚙️ YOUR ACTIVE PREDICTION STRATEGY ==
${strategy.currentStrategy}
Constraints: ${strategy.activeRules.join(', ')}

Return EXACTLY this JSON:
{
  "predictionText": "2-3 sentence analysis based ONLY on form and H2H data.",
  "confidenceScore": 85,
  "match_winner": "Home or Away or Draw",
  "winner_reasoning": "One sentence explaining why Home/Away/Draw using the % stats provided.",
  "over1_5": "Yes/No with strict reason",
  "over2_5": "Yes/No with strict reason",
  "GG": "Yes/No with strict reason",
  "correctScore": "Precise exact score prediction (e.g. 2:1)"
}

Return ONLY valid JSON.`;

        broadcastAiStatus('analyzing', `Calling ${provider.toUpperCase()} AI for single-match prediction...`);
        const aiResult = await callPredictionAI(prompt, provider);
        let prediction;
        try {
            prediction = parseAIJson(aiResult.content);
        } catch (e) {
            console.error(`[predict-live] ❌ ${provider} returned invalid JSON:`, aiResult.content?.slice(0, 500));
            return res.status(500).json({ success: false, error: `${provider} returned invalid JSON: ${e.message}` });
        }

        res.json({
            success: true,
            prediction,
            h2hAnalyzed: h2hMatches.length,
            behaviourSignals: behaviourSignalData,
            aiProvider: provider,
            aiModel: aiResult.model,
            aiMs: aiResult.ms,
        });
    } catch (err) {
        console.error('[/api/vfootball/predict-live]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/daily-tips
// Fetches daily tips from Database for a given date and league.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/daily-tips */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/behaviour-patterns
// Returns saved behaviour pattern signals from Database for a league.
// Optionally runs a live streak profile across all teams in the league.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/behaviour-patterns */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/behaviour-patterns/analyse
// Runs a live behaviour analysis on a given set of upcoming fixtures.
// Compares with previous screenshot results if matchData arrays are provided.
// Body: { league, fixtures: [{homeTeam, awayTeam, gameTime}], latestMatches?, previousMatches? }
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/vfootball/behaviour-patterns/analyse */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/league-baselines
// Returns all cached League DNA baselines from MongoDB (used by UI panels)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/league-baselines */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/league-baselines/compute
// Triggers a full DNA baseline recompute from the last N days of MongoDB data
// Body: { daysBack?: number } (default: 7)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/vfootball/league-baselines/compute */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/daily-tips/history
// Fetches the entire logged history of daily tips (upcoming predictions).
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/daily-tips/history */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/daily-tips/analyze
// Uses AI to analyze the matches up to the current date and provides tips.
// It explicitly looks for patterns after 0:0, 1:1, 2:2.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vfootball/daily-tips/analyze', async (req, res) => {
    try {
        let { date, league, provider: reqProvider } = req.body;
        const provider = reqProvider || getActivePredictionProvider();
        console.log(`[daily-tips/analyze] 🤖 AI Provider: ${provider.toUpperCase()} (${PREDICTION_PROVIDERS[provider]?.label || provider})`);
        let bSignalsToReturn = [];
        const forceRerun = req.query.force === 'true' || req.body.force === true;
        if (!date || !league) return res.status(400).json({ success: false, error: 'date and league required' });

        // Prevent duplicate AI runs if already analyzed (skip if force=true)
        broadcastAiStatus('start', `Starting analysis for ${league} on ${date}. Checking cache...`);
        if (!forceRerun) {
            const existingTip = await getDailyTip(date, league);
            if (existingTip && existingTip.tipData) {
                console.log(`[DEBUG] [/api/vfootball/daily-tips/analyze] Found cached tip for ${date} ${league}.`);
                broadcastAiStatus('success', 'Found existing cached analysis. Skipping AI inference.');
                return res.json({ success: true, tipData: existingTip.tipData, cached: true });
            }
        } else {
            console.log(`[DEBUG] [/api/vfootball/daily-tips/analyze] Force re-run requested for ${date} ${league} — bypassing cache.`);
            broadcastAiStatus('info', 'Force re-run requested — bypassing cache.');
        }

        // Fetch matches. If today, fetch today's results. Else, fetch historical results.
        let matches = [];
        broadcastAiStatus('fetching', 'Fetching historical match results from Database database...');
        if (date === todayDDMMYYYY()) {
            matches = await fetchTodayResultsFromDatabase(league);
        } else {
            const result = await fetchResultsFromDatabase({ league, dateFrom: date, dateTo: date, page: 1, pageSize: 100 });
            matches = result.dates.flatMap(d => Object.values(d.leagues).flat());
        }

        // ── PRE-TIPS LEARNING GUARDIAN ────────────────────────────────────────
        // Ensure league intelligence is trained BEFORE tips generation.
        // This saves tokens — the AI tip prompt includes league profile context.
        {
            const intel = await getLeagueIntelligence(league);
            const dateKey = date.replace(/\//g, '-');
            if (!intel?.history?.[dateKey]) {
                console.log(`[Pre-Tips Guard] 🧠 No learning found for ${league} on ${date} — auto-running before tips...`);
                broadcastAiStatus('learning', `🧠 Auto-training ${league} (${date}) before generating tips...`);
                const learnResult = await runLearningForLeagueDate(league, date, { force: false });
                if (learnResult.success) {
                    console.log(`[Pre-Tips Guard] ✅ Auto-learning done (${learnResult.matchesAnalyzed} matches). Generating tips...`);
                    broadcastAiStatus('learned', `✅ Auto-learned ${league} — generating tips now.`);
                } else {
                    console.warn(`[Pre-Tips Guard] ⚠️ Auto-learning failed: ${learnResult.error} — proceeding anyway.`);
                }
            } else {
                console.log(`[Pre-Tips Guard] ✅ League intel already cached for ${league} on ${date}.`);
            }
        }

        // ─── Detect whether we have real live upcoming matches for this league ───
        let upcomingMatchesTxt = null;
        let hasLiveMatches = false;

        if (typeof globalData !== 'undefined' && globalData && globalData.length > 0) {
            broadcastAiStatus('tool', 'Using live scraper state to find active upcoming matches...');
            
            const reqLeaguePrefix = league.split(' ')[0]; // e.g. "England"
            // Match against identical league name, generic name, or prefix
            const liveLeagueData = globalData.find(g => 
                g.league === league || 
                g.league === 'vFootball Live Odds' || 
                g.league.includes(reqLeaguePrefix)
            );
            
            if (liveLeagueData && liveLeagueData.matches && liveLeagueData.matches.length > 0) {
                hasLiveMatches = true;

                const rawData = await getCachedDocs();
                let validMatches = liveLeagueData.matches;
                
                // If it's a mixed batch from the Live Odds scraper, map teams to their real league
                if (liveLeagueData.league === 'vFootball Live Odds') {
                    validMatches = liveLeagueData.matches.filter(m => {
                        const realMatch = rawData.find(d => d.homeTeam === m.home);
                        const mLeague = realMatch ? realMatch.league : 'Unknown';
                        // If user specifically requested 'vFootball Live Odds' (ScoreBoard), allow all.
                        // If user requested 'England - Virtual' (DailyTips), ONLY keep England matches!
                        if (league === 'vFootball Live Odds') return true; 
                        return mLeague === league || mLeague.includes(reqLeaguePrefix);
                    });
                }

                // Cap at 20 matches to prevent DeepSeek output token overflow
                const matchesToAnalyze = validMatches.slice(0, 20);
                console.log(`[DEBUG] [analyze] Sliced from ${liveLeagueData.matches.length} to ${matchesToAnalyze.length} matches — building venue-aware match lines (ODDS EXCLUDED).`);
                
                const firstMatch = matchesToAnalyze[0];
                if (firstMatch) {
                    console.log(`[DEBUG] [analyze] Scraper match shape: home="${firstMatch.home}" away="${firstMatch.away}" time="${firstMatch.time}" score(=odds)="${firstMatch.score}" — ODDS ARE EXCLUDED FROM AI PROMPT (unreliable predictor in vFootball)`);
                }

                // Compute league-wide venue baseline ONCE (cached) to avoid redundant reads
                const leagueBaseline = await computeVenueAdvantage(league);

                // 🧬 Fetch full League DNA Baseline (BTTS%, O1.5%, O2.5%, top scorelines, directives)
                // This is Tier-1 context — the AI cannot override these statistical priors without explicit reasoning
                const fullBaselineDNAForTips = await getLeagueBaseline(league);
                const leagueTipsDNAInjection = fullBaselineDNAForTips
                    ? buildLeagueBaselinePromptInjection(fullBaselineDNAForTips)
                    : '';
                console.log(`[daily-tips] 🧬 League DNA: ${fullBaselineDNAForTips
                    ? `O1.5=${fullBaselineDNAForTips.stats?.over1_5Percent}% BTTS=${fullBaselineDNAForTips.stats?.bttsPercent}% O2.5=${fullBaselineDNAForTips.stats?.over2_5Percent}% Draw=${fullBaselineDNAForTips.stats?.drawPercent}% (${fullBaselineDNAForTips.matchCount} matches)`
                    : 'No cached DNA baseline — using venue advantage only'}`);

                if (league !== 'vFootball Live Odds') {
                    console.log(`[DEBUG] [analyze] League baseline: Home=${leagueBaseline.homeWinPercent}% Away=${leagueBaseline.awayWinPercent}% Draw=${leagueBaseline.drawPercent}%`);
                }

                const matchLines = await Promise.all(matchesToAnalyze.map(async m => {
                    let matchLeague = league;
                    
                    // Resolve strictly for mixed batches
                    if (league === 'vFootball Live Odds') {
                         const mDoc = rawData.find(d => d.homeTeam === m.home);
                         if (mDoc) matchLeague = mDoc.league || league;
                    }

                    const [hForm, aForm, h2hForm, matchLeagueBaseline] = await Promise.all([
                        computeTeamForm(matchLeague, m.home, 8),
                        computeTeamForm(matchLeague, m.away, 8),
                        computeH2HForm(matchLeague, m.home, m.away, 10),
                        (league === 'vFootball Live Odds') ? computeVenueAdvantage(matchLeague) : Promise.resolve(leagueBaseline)
                    ]);
                    // NOTE: Odds (m.score) are intentionally excluded — they are unreliable in vFootball
                    return [
                        `[${m.time || '?'}] ${m.home} (HOME) vs ${m.away} (AWAY)`,
                        `  HOME: HomeWin%=${hForm.homeWinPercent}% | Form(home)=${hForm.homeForm} | Goals/homeGame=${hForm.homeGoalsScored} | DrawRate=${hForm.drawPercent}% | Streak=${hForm.streak}`,
                        `  AWAY: AwayWin%=${aForm.awayWinPercent}% | Form(away)=${aForm.awayForm} | Goals/awayGame=${aForm.awayGoalsScored} | DrawRate=${aForm.drawPercent}% | Streak=${aForm.streak}`,
                        `  H2H (${h2hForm.matchesAnalysed} games): O2.5=${h2hForm.over2_5_percent}% | GG=${h2hForm.btts_percent}% | HomeWins=${h2hForm.homeWinsInH2H} AwayWins=${h2hForm.awayWinsInH2H} Draws=${h2hForm.drawsInH2H} | Bias=${h2hForm.homeAdvantageH2H}`,
                    ].join('\n');
                }));

                // Inject league baseline as a header line so AI knows the prior probability
                const leagueBaselineLine = `\nLEAGUE VENUE BASELINE (${leagueBaseline.matchesAnalysed} total games): Home wins ${leagueBaseline.homeWinPercent}% | Away wins ${leagueBaseline.awayWinPercent}% | Draws ${leagueBaseline.drawPercent}%\n`;
                
                // Fetch the merged Deep Learning profile for this league
                const intelDoc = await getLeagueIntelligence(league);
                const intelStr = intelDoc ? JSON.stringify(intelDoc.merged || intelDoc.profile || intelDoc) : 'No deep learning profile available yet.';
                
                // ── Behaviour Pattern Analysis ────────────────────────────────────────
                // Win streak fatigue, big team clashes, loss reversal signals
                let dailyBehaviourInjection = '';
                try {
                    const dailyFixtures = matchesToAnalyze.map(m => ({ homeTeam: m.home, awayTeam: m.away, gameTime: m.time }));
                    const resolvedLeagueForBeh = liveLeagueData.league === 'vFootball Live Odds' ? league : liveLeagueData.league;
                    console.log(`[DEBUG] [analyze] 🔬 Running behaviour pattern analysis on ${dailyFixtures.length} upcoming fixtures...`);
                    const bSignals = await detectBehaviourPatterns(dailyFixtures, resolvedLeagueForBeh);
                    bSignalsToReturn = bSignals;
                    dailyBehaviourInjection = buildBehaviourPromptInjection(bSignals);
                    if (bSignals.length > 0) {
                        console.log(`[DEBUG] [analyze] ✅ ${bSignals.length} behaviour signals found — injecting into daily-tips prompt.`);
                        // Save signals for dashboard history
                        await saveBehaviourSignals(bSignals, resolvedLeagueForBeh, date).catch(e =>
                            console.error('[analyze] Behaviour save error (non-fatal):', e.message)
                        );
                    } else {
                        console.log('[DEBUG] [analyze] ✅ No anomalous behaviour signals for today\'s fixtures.');
                    }
                } catch (bErr) {
                    console.error('[DEBUG] [analyze] ⚠️ Behaviour pattern analysis error (non-fatal):', bErr.message);
                }

                upcomingMatchesTxt = `=== DEEP LEARNING LEAGUE PROFILE ===\n${intelStr}\n====================================\n\n` +
                    leagueBaselineLine +
                    (leagueTipsDNAInjection ? `\n${leagueTipsDNAInjection}\n` : '') +
                    matchLines.join('\n\n') +
                    (dailyBehaviourInjection ? `\n\n${dailyBehaviourInjection}` : '');
                console.log(`[DEBUG] [analyze] ✅ Live matches injected: ${matchesToAnalyze.length} (ODDS EXCLUDED — form+H2H+League DNA+behaviour signals)`);
                broadcastAiStatus('success', `Injected ${matchesToAnalyze.length} fixtures with form, H2H, League DNA 🧬, and behaviour signals.`);
            } else {
                console.log(`[DEBUG] [analyze] ⚠️ globalData present but no matches matched league "${league}". Skipping live fixture injection.`);
            }
        } else {
            console.log('[DEBUG] [analyze] ⚠️ globalData is null/empty — live scraper may not have data yet. Predictions will be pattern-based only.');
        }

        if ((!matches || matches.length === 0) && !hasLiveMatches) {
            broadcastAiStatus('error', 'No match data found to analyze for this date and league.');
            return res.status(400).json({ success: false, error: 'No match data found to analyze for this date and league.' });
        }

        // Calculate yesterday's date to fetch past tips for Self Evaluation
        const reqDateObj = new Date(date.split('/').reverse().join('-'));
        reqDateObj.setDate(reqDateObj.getDate() - 1);
        const yDayStr = reqDateObj.toISOString().split('T')[0];
        const yDayApi = `${yDayStr.split('-')[2]}/${yDayStr.split('-')[1]}/${yDayStr.split('-')[0]}`;
        
        const pastTip = await getDailyTip(yDayApi, league);
        let pastTipContext = '';
        if (pastTip && pastTip.tipData) {
            pastTipContext = `
LAST SESSION'S TIPS (Date: ${yDayApi}) TO SELF-EVALUATE AGAINST:
${JSON.stringify(pastTip.tipData.upcoming_matches || pastTip.tipData.predictions || [])}
TASK: Compare the above predictions to the completed matches below.
Specifically count: how many "Draw" predictions were WRONG (actual result was Home or Away win)?
`;
        }

        // Strip down the matches to save tokens
        const compressedMatches = (matches || []).map(m => `[${m.time}] ${m.homeTeam} ${m.score} ${m.awayTeam}`);

        const strategy = await getStrategy();

        // ─── Build prompt with venue-aware directives ────────────────────────
        const prompt = `You are an elite virtual football analyst providing "Upcoming Tips" for the league "${league}".
I am providing you with complete home/away form statistics for every upcoming fixture.

${pastTipContext}

CRITICAL ANALYSIS DIRECTIVES — READ CAREFULLY:
1. NEVER use or reference betting odds. Odds are unreliable in vFootball — the favourite regularly loses.
2. Base ALL match_winner picks ONLY on: HomeWin%, AwayWin%, home/away form strings, H2H venue bias, and the Deep Learning League Profile.
3. DRAW RULE: Only predict "Draw" when BOTH teams have draw rate >30% AND their home/away win% difference is <15pts AND H2H shows balanced results.
4. HOME ADVANTAGE RULE: If the home team's HomeWin% > 55% AND the away team's AwayWin% < 30% → predict "Home", NOT Draw.
5. AWAY WIN RULE: Only predict "Away" if the away team has AwayWin% > 40% OR H2H clearly shows away advantage.
6. Use exact percentages from the data provided. Do NOT estimate.

== ⚙️ YOUR CURRENT BRAIN CONSTRAINTS (ACTIVE RULES) ==
${strategy.activeRules && strategy.activeRules.length > 0 ? strategy.activeRules.join('\n') : 'No constraints active. Learn freely.'}
If any rule caused a wrong draw prediction today, put it precisely in failed_rules_to_remove. If you discover a new pattern, put it in new_rules_to_add.

== 🏟️ UPCOMING LIVE FIXTURES (with full venue stats) ==
${hasLiveMatches ? upcomingMatchesTxt : "NO LIVE MATCHES FOUND. Return an empty upcoming_matches array."}

== 📋 RAW COMPLETED MATCHES FROM TODAY (context only) ==
${compressedMatches.length > 0 ? compressedMatches.join('\n') : "No historical matches have completed yet today."}

Return EXACTLY this valid JSON structure. DO NOT deviate from this schema:
{
  "context": "2 sentence summary of the dominant patterns and home/away trends observed in today's completed matches.",
  "Self_Evaluation": {
      "score": "x/10",
      "emoji": "🎯",
      "review": "Compare completed matches to yesterday's predictions. How accurate were the match_winner calls specifically?",
      "wrong_draws_count": 0,
      "draw_prediction_accuracy": "x%",
      "Brain_Updates": {
          "new_rules_to_add": ["rule string 1"],
          "failed_rules_to_remove": ["exact string to delete from memory"],
          "unused_rules_to_monitor": ["rule you are unsure about"]
      }
  },
  "upcoming_matches": [
      {
          "fixture": "TeamA vs TeamB",
          "game_time": "12:05",
          "exact_score": "2:1",
          "match_winner": "Home",
          "winner_team_name": "TeamA",
          "venue_confidence": "High",
          "over_1_5": "Yes",
          "over_2_5": "No",
          "gg": "Yes",
          "prediction_reasoning": "TeamA wins 68% at home. TeamB has lost last 5 away games (AwayWin%=10%). Strong home advantage confirmed by H2H record."
      }
  ],
  "Tool_Requests": {
      "capture_league": false,
      "team_track_request": null
  }
}

FIELD NOTES:
- match_winner MUST be exactly "Home", "Away", or "Draw" — NOT a team name
- winner_team_name = the actual team name that you predict wins
- venue_confidence = "High" (clear home/away advantage), "Medium" (slight edge), or "Low" (genuinely balanced — only then is Draw valid)
- If wrong_draws_count > 2, you MUST add an "avoid_draw_default" rule to new_rules_to_add

Return ONLY valid JSON. No markdown. No code blocks. No extra text.`;

        broadcastAiStatus('analyzing', `Prompting ${provider.toUpperCase()} AI to synthesize match data and generate predictions...`);
        const aiResult = await callPredictionAI(prompt, provider, { maxTokens: 8000 });
        let tipData;
        try {
            tipData = parseAIJson(aiResult.content);
            console.log(`[DEBUG] [daily-tips/analyze] ✅ JSON parsed from ${provider} (${aiResult.ms}ms, ${aiResult.tokensUsed} tokens).`);
        } catch (e) {
            console.error(`[daily-tips/analyze] ❌ JSON parse failed from ${provider}. Raw output (first 1000 chars):`);
            console.error('RAW CONTENT >>>', aiResult.content?.slice(0, 1000));
            return res.status(500).json({ success: false, error: `${provider} returned invalid JSON: ${e.message}. Check server logs for raw output.` });
        }

        // Stamp analysis metadata for frontend display
        tipData.analysisMode     = hasLiveMatches ? 'live' : 'historical';
        tipData.behaviourSignals = bSignalsToReturn;
        tipData.aiProvider       = provider;
        tipData.aiModel          = aiResult.model;
        tipData.aiMs             = aiResult.ms;
        console.log(`[DEBUG] [daily-tips/analyze] ✅ Complete. Provider: ${provider} | Model: ${aiResult.model} | Mode: ${tipData.analysisMode} | Matches: ${matches.length}`);

        // ── Process Brain Updates ──────────────────────────────────────────────
        const brainUpdates = tipData.Self_Evaluation?.Brain_Updates;
        if (brainUpdates && (
            (brainUpdates.new_rules_to_add && brainUpdates.new_rules_to_add.length > 0) || 
            (brainUpdates.failed_rules_to_remove && brainUpdates.failed_rules_to_remove.length > 0) ||
            (brainUpdates.unused_rules_to_monitor && brainUpdates.unused_rules_to_monitor.length > 0)
        )) {
            console.log('[DEBUG] [daily-tips/analyze] 🧠 AI requested autonomous Brain Updates. Executing...');
            await updateStrategy({
                action: 'update_rules',
                add_rules: brainUpdates.new_rules_to_add || [],
                remove_rules: brainUpdates.failed_rules_to_remove || [],
                monitor_rules: brainUpdates.unused_rules_to_monitor || []
            });
        }

        // ── AI TOOL CALLING: Handle Tool_Requests from the AI ────────────────
        const toolRequests = tipData.Tool_Requests || {};
        let toolCallResult = null;

        if (toolRequests.capture_league === true) {
            console.log(`[AI Tool Call] 🤖 AI requested a sync for league: ${league}. Triggering native capture...`);
            broadcastAiStatus('tool', `🤖 AI Tool Call: Triggering native sync for ${league}...`);
            try {
                await nativeCaptureLeagueResults(league, date, {
                    onPageCaptured: async (unused, matchRows, pageNum) => {
                        if (matchRows && matchRows.length > 0) {
                            await uploadMatchesToDatabase(matchRows, (msg) => {
                                broadcastAiStatus('tool', `[AI Sync ${league} P${pageNum}] ${msg}`);
                            });
                        }
                    }
                });
                toolCallResult = { capture_league: true, status: 'completed', league };
                broadcastAiStatus('success', `🤖 AI-triggered sync for ${league} complete.`);
                console.log(`[AI Tool Call] ✅ AI-triggered sync for ${league} completed successfully.`);
            } catch (syncErr) {
                console.error(`[AI Tool Call] ❌ AI sync failed for ${league}:`, syncErr.message);
                toolCallResult = { capture_league: true, status: 'failed', error: syncErr.message };
            }
        }

        let teamFormResult = null;
        if (toolRequests.team_track_request && typeof toolRequests.team_track_request === 'string') {
            const trackTeam = toolRequests.team_track_request;
            console.log(`[AI Tool Call] 📊 AI requested team tracking for: ${trackTeam}`);
            broadcastAiStatus('tool', `📊 Computing form for ${trackTeam} as requested by AI...`);
            teamFormResult = await computeTeamForm(league, trackTeam, 10);
        }

        // Save tip (include tool call result metadata)
        tipData._toolCallResult = toolCallResult;
        tipData._teamFormResult = teamFormResult;
        await saveDailyTip(date, league, tipData);

        broadcastAiStatus('success', 'Analysis complete and data saved to Database.');
        res.json({ success: true, tipData, cached: false, matchesAnalyzed: matches.length, toolCallResult, teamFormResult });
    } catch (err) {
        console.error('[/api/vfootball/daily-tips/analyze]', err.message);
        
        // Detect Database RESOURCE_EXHAUSTED (gRPC 8) — quota or missing composite index
        const code = err?.code || err?.details?.code;
        const errMsg = (err?.message || '').toLowerCase();
        const isDatabaseQuotaErr = code === 8 || code === 'resource-exhausted' ||
            errMsg.includes('resource_exhausted') || errMsg.includes('quota exceeded') ||
            errMsg.includes('requires an index') || errMsg.includes('resource exhausted');
        
        if (isDatabaseQuotaErr) {
            const indexUrl = (err?.message || '').match(/https:\/\/console\.database\.google\.com[^\s]*/)?.[0];
            if (indexUrl) {
                console.error('[Database Index Debug/Error Details]: 🔗 Database needs a composite index for daily-tips. CREATE IT HERE:', indexUrl);
            } else {
                console.error('[Database Index Debug/Error Details]: 🔴 Database Quota/Index error — visit https://console.database.google.com/ → Firestore → Indexes to create required indexes.');
            }
            broadcastAiStatus('error', '⚠️ Database quota exceeded or missing index. The AI analysis could not save. Check the server console for instructions to fix this.');
            return res.status(503).json({
                success: false,
                error: '⚠️ Database quota exceeded or a required Firestore index is missing. The Daily Tips analysis cannot save right now. Check the server console log for the index creation link.',
                errorType: 'FIREBASE_QUOTA',
                indexUrl: indexUrl || null,
            });
        }
        
        broadcastAiStatus('error', `Analysis failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/league-intelligence/:league
// Returns the AI's aggregated league intelligence profile
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/league-intelligence/:league */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/team-form
// Returns recent W/D/L form for a specific team in a league.
// Query params: league, team, limit (optional, default 10)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/vfootball/team-form */



// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-strategy
// Returns the currently active AI prediction strategy.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai-strategy */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-memory
// Returns the entire AI memory log (used for admin / user display).
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai-memory */


// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/ai-memory/:id
// Deletes a specific entry by ID, or pass ?clearAll=true to wipe the whole log.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted delete /api/ai-memory/:id */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/screenshot-preview/:filename
// Serves a screenshot PNG directly as an image for UI thumbnails and previews.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/screenshot-preview/:filename */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/screenshots
// Lists all PNG screenshots in testdownloadpage/, newest first.
// Each entry includes: filename, absolutePath, sizeBytes, capturedAt, isNew
// isNew = true if the file's MD5 hash is NOT in processed_images_hash.json
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/screenshots */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/extract-and-upload (Server-Sent Events)
//
// Accepts: { imagePath, leagueName } in query params or POST body
// Streams back real-time status messages as SSE events.
// Full pipeline: MD5 Check → Visual Hash Check → Gemini Extract → Upload to Database
// ─────────────────────────────────────────────────────────────────────────────

// --- Inline extractor state (mirrors gemini_extractor.js) ---
const PROCESSED_DB_PATH = path.join(__dirname, 'processed_images_hash.json');
const VISUAL_HASH_DB_PATH = path.join(__dirname, 'processed_visual_hashes.json');
const OUTPUT_DATA_PATH = path.join(__dirname, 'extracted_league_data.json');
const HISTORY_LOG_PATH = path.join(__dirname, 'history_logs.json');

function getFileHash(fp) {
    return crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex');
}
function isImageProcessed(hash) {
    if (!fs.existsSync(PROCESSED_DB_PATH)) return false;
    return JSON.parse(fs.readFileSync(PROCESSED_DB_PATH)).includes(hash);
}
function markImageProcessed(hash) {
    let db = fs.existsSync(PROCESSED_DB_PATH) ? JSON.parse(fs.readFileSync(PROCESSED_DB_PATH)) : [];
    if (!db.includes(hash)) fs.writeFileSync(PROCESSED_DB_PATH, JSON.stringify([...db, hash], null, 2));
}
function hammingDistance(h1, h2) {
    if (h1.length !== h2.length) return 1.0;
    let diff = 0;
    for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) diff++;
    return diff / h1.length;
}
async function getTopVisualHash(filePath) {
    try {
        const image = await Jimp.read(filePath);
        const w = image.bitmap.width; const h = image.bitmap.height;
        // Crop the top matches area, skipping the header/clock
        // From 15% to 55% (40% total height)
        image.crop(0, Math.floor(h * 0.15), w, Math.floor(h * 0.4));

        // Use an MD5 of the raw image pixels instead of an 8x8 perceptual hash.
        // This ensures the hash changes if even a single character (like a score or Match ID) changes!
        return crypto.createHash('md5').update(image.bitmap.data).digest('hex');
    } catch (e) { return null; }
}
async function isTopVisuallyDuplicate(hash) {
    if (!hash || !fs.existsSync(VISUAL_HASH_DB_PATH)) return false;
    const db = JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH));
    // Check for exact pixel-hash equality.
    return db.includes(hash);
}
function markVisualHashProcessed(hash) {
    if (!hash) return;
    let db = fs.existsSync(VISUAL_HASH_DB_PATH) ? JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH)) : [];
    if (!db.includes(hash)) fs.writeFileSync(VISUAL_HASH_DB_PATH, JSON.stringify([...db, hash], null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reset-visual-hashes
// Clears the visual hash database so previously "similar-looking" screenshots
// can be re-processed. Safe to use — does NOT delete any match data.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/reset-visual-hashes */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/db-stream
// Real-time SSE stream that notifies clients when the database has been updated
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/db-stream */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync-local-to-database
// Pushes ALL records from extracted_league_data.json to Database.
// This is the recovery path for data that was extracted but never uploaded
// (e.g. due to past pipeline errors). Streams SSE progress back to the UI.
// Optional body: { leagueFilter: "Germany - Virtual" } to filter by league.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/sync-local-to-database */



/* Extracted post /api/extract-and-upload */



// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/screenshots/:filename
// Deletes a specific screenshot PNG (and its .meta.json if present).
// Validates filename to prevent path traversal attacks.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted delete /api/screenshots/:filename */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/screenshots/process-pending
// Loops through all pending .png files in the server directory
// processes them explicitly and uploads to Database.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/screenshots/process-pending */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-provider  — returns the currently configured AI provider
// POST /api/ai-provider — updates the active provider (claude | openai)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/ai-provider */



/* Extracted post /api/ai-provider */



/* Extracted delete /api/admin/league/:leagueName */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel
// Computes all 80%+ patterns from the database, finds the most recent matches
// that triggered each pattern, and predicts what will happen next.
//
// Query params:
//   league (optional) — filter to a specific league
//   minPct (optional) — minimum hit % threshold (default: 80)
//   minSamples (optional) — minimum sample size (default: 8)
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/pattern-intel */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-predict-pattern
// Uses the active AI to write a natural language prediction for the next fixture
// based on the statistical pattern provided.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/ai-predict-pattern */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/upcoming-ai-analysis
// Analyzes the best active patterns against real-time upcoming fixtures using AI.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/pattern-intel/upcoming-ai-analysis */


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pattern-intel/save-snapshot
// Called automatically when /api/pattern-intel runs — persists today's live
// patterns into MongoDB so they can be browsed historically.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted post /api/pattern-intel/save-snapshot */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/dates
// Returns all dates that have saved pattern snapshots, newest first.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/pattern-intel/dates */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/history?date=DD/MM/YYYY
// Returns all saved pattern snapshots for a given date.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/pattern-intel/history */


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/performance
// Computes the full performance overview across ALL resolved + unresolved
// pattern snapshots. Shows per-outcome hit rates, streaks, and best patterns.
// ─────────────────────────────────────────────────────────────────────────────

/* Extracted get /api/pattern-intel/performance */


// ─────────────────────────────────────────────────────────────────────────────
// React Router catch-all — must be LAST route.
// Any non-API request (e.g. /dashboard, /history) returns index.html so
// React Router can handle the path on the client side.
// ─────────────────────────────────────────────────────────────────────────────
if (fs.existsSync(PUBLIC_DIR)) {
    app.use((req, res, next) => {
        // Only serve index.html for GET requests that are not API routes
        if (req.method !== 'GET' || req.path.startsWith('/api')) {
            return next();
        }
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
}

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[DEBUG] [Server] Express API running on port ${PORT}`);
    console.log(`[DEBUG] [Server] Endpoints:`);
    console.log(`[DEBUG] [Server]   GET /api/scores               → live vFootball odds`);
    console.log(`[DEBUG] [Server]   GET /api/vfootball/history     → paginated completed results`);
    console.log(`[DEBUG] [Server]   GET /api/debug/history-store   → accumulator stats`);

    // ── Startup: Auto-clean stale screenshots from prior runs ───────────────
    // Screenshots uploaded via gemini_extractor direct path don't get their hashes
    // marked, so they accumulate and show as "pending" on each restart.
    // On startup we mark ALL existing files as processed so the counter starts at 0.
    setTimeout(() => {
        try {
            const screenshotDir = path.join(__dirname, 'testdownloadpage');
            if (!fs.existsSync(screenshotDir)) return;
            const pngFiles = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png'));
            if (pngFiles.length === 0) return;

            console.log(`[Startup Cleanup] Found ${pngFiles.length} PNG(s) left over from prior runs — marking as processed.`);
            let marked = 0;
            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);

            for (const fname of pngFiles) {
                const fpath = path.join(screenshotDir, fname);
                const metaPath = fpath.replace('.png', '.meta.json');
                const stat = fs.statSync(fpath);

                // Mark hash as processed so isNew → false immediately
                try {
                    markImageProcessed(getFileHash(fpath));
                    marked++;
                } catch (e) {
                    console.warn(`[Startup Cleanup] Could not hash ${fname}:`, e.message);
                }

                // Delete orphaned files (no meta + older than 2h = failed extraction with no data)
                if (!fs.existsSync(metaPath) && stat.mtimeMs < twoHoursAgo) {
                    try {
                        fs.unlinkSync(fpath);
                        console.log(`[Startup Cleanup] 🗑️ Removed orphaned: ${fname}`);
                    } catch (_) {}
                }
            }
            console.log(`[Startup Cleanup] ✅ Marked ${marked} screenshot hash(es) as processed. Pending counter now accurate.`);
        } catch (err) {
            console.warn('[Startup Cleanup] Non-fatal error during cleanup:', err.message);
        }
    }, 2000); // Run 2s after startup to not block boot
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN (Prevents orphaned Chrome processes during nodemon reloads)
// ─────────────────────────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
    console.log(`\n[DEBUG] [Server] Received ${signal}, initiating graceful shutdown...`);
    try {
        await stopContinuousScraper();
    } catch (e) {
        console.error('[DEBUG] [Server] Error stopping scraper:', e.message);
    }
    
    server.close(() => {
        console.log('[DEBUG] [Server] Express connections closed.');
        process.exit(0);
    });

    // Force exit if taking too long
    setTimeout(() => {
        console.error('[DEBUG] [Server] Could not close gracefully in time, forcing exit.');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Nodemon reload
