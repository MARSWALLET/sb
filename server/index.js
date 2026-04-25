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
app.get('/api/health', (req, res) => {
    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins  = Math.floor((uptimeSec % 3600) / 60);
    const secs  = uptimeSec % 60;
    const uptimeStr = `${hours}h ${mins}m ${secs}s`;

    const scraperActive = globalData !== null && Array.isArray(globalData) && globalData.length > 0;
    const matchCount = scraperActive
        ? globalData.reduce((acc, g) => acc + (g.matches?.length || 0), 0)
        : 0;

    console.log(`[DEBUG] [/api/health] uptime=${uptimeStr} mem=${memMB}MB scraper=${scraperActive}`);
    res.json({
        success: true,
        status:  'ok',
        uptime:  uptimeStr,
        uptimeSec,
        memoryMB: parseFloat(memMB),
        nodeVersion: process.version,
        env:     process.env.NODE_ENV || 'development',
        scraper: {
            active:     scraperActive,
            liveLeagues: globalData ? globalData.map(g => g.league) : [],
            liveMatches: matchCount,
        },
        timestamp: new Date().toISOString(),
    });
});

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
app.get('/api/scraper-diag', async (req, res) => {
    const livePage = getLivePage();
    if (!livePage) {
        console.warn('[DEBUG] [/api/scraper-diag] No live page available — scraper not running yet.');
        return res.status(503).json({
            success: false,
            error: 'Live scraper page not available. The scraper may still be initialising — wait ~10 seconds and retry.',
        });
    }

    try {
        console.log('[DEBUG] [/api/scraper-diag] Running DOM diagnostic on live scraper page...');

        // Candidate selectors to test (same list as debug_live_page.js + new ones from scraper)
        const CANDIDATES = [
            '[data-event-id]', '[data-game-id]', '[data-market]',
            '.m-list', '.m-list > li', '.m-list .m-list-item',
            '[class*="match"]', '[class*="event-item"]', '[class*="sport-event"]',
            '[class*="game"]', '[class*="odds"]', '[class*="virtual"]',
            '.betslip-item', '.match-item', '.event-item',
        ];

        const diagResult = await livePage.evaluate((candidates) => {
            // Selector match counts
            const selectorResults = {};
            for (const sel of candidates) {
                const count = document.querySelectorAll(sel).length;
                if (count > 0) {
                    selectorResults[sel] = {
                        count,
                        firstText: document.querySelector(sel)?.innerText?.substring(0, 150)?.replace(/\n/g, ' | ') || '',
                    };
                } else {
                    selectorResults[sel] = { count: 0, firstText: '' };
                }
            }

            // Top unique class names
            const classNames = new Set();
            document.querySelectorAll('[class]').forEach(el => {
                el.className.split(' ').forEach(c => { if (c.trim()) classNames.add(c.trim()); });
            });

            // Body text preview
            const bodyPreview = document.body?.innerText?.substring(0, 600) || '';

            return {
                selectorResults,
                classNames: [...classNames].slice(0, 100),
                bodyPreview,
                pageTitle: document.title,
                url: location.href,
            };
        }, CANDIDATES);

        console.log(`[DEBUG] [/api/scraper-diag] Done. ${Object.values(diagResult.selectorResults).filter(r => r.count > 0).length} selectors matched.`);
        res.json({ success: true, ...diagResult, timestamp: new Date().toISOString() });

    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [/api/scraper-diag] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /   — Human Friendly Index / API Directory
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-status-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const listener = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    aiStatusEmitter.on('status', listener);

    req.on('close', () => {
        aiStatusEmitter.removeListener('status', listener);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/live-stream  — SSE push endpoint for live vFootball odds
//
// Replaces frontend polling of /api/scores every 5s with a push model:
// the server broadcasts immediately on each scraper update.
//
// Falls back cleanly if SSE is not supported (the old /api/scores is kept).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/live-stream', (req, res) => {
    console.log('[DEBUG] [/api/live-stream] New SSE client connected.');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering in production
    res.flushHeaders();

    // Send a heartbeat comment every 30s to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 30000);

    // Send the current cached data immediately so client doesn't wait for next poll
    if (globalData !== null) {
        const initial = { data: globalData, status: 'live', timestamp: Date.now() };
        res.write(`data: ${JSON.stringify(initial)}\n\n`);
        console.log('[DEBUG] [/api/live-stream] Sent initial cached data to new client.');
    } else {
        const initializing = { data: [], status: 'initializing', timestamp: Date.now() };
        res.write(`data: ${JSON.stringify(initializing)}\n\n`);
    }

    // Subscribe to future broadcasts from the scraper
    const listener = (payload) => {
        try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (writeErr) {
            console.warn('[DEBUG] [/api/live-stream] Write failed (client disconnected):', writeErr.message);
        }
    };
    liveScoresEmitter.on('update', listener);

    // Clean up on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        liveScoresEmitter.removeListener('update', listener);
        console.log('[DEBUG] [/api/live-stream] SSE client disconnected. Cleaned up listener.');
    });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Live Sports Dashboard</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --primary: #3b82f6;
                        --primary-hover: #2563eb;
                        --bg-deep: #0f172a;
                        --glass-bg: rgba(30, 41, 59, 0.7);
                        --glass-border: rgba(255, 255, 255, 0.1);
                        --text-main: #f8fafc;
                        --text-muted: #94a3b8;
                    }
                    body {
                        font-family: 'Inter', sans-serif;
                        background: radial-gradient(circle at top right, #1e1b4b, var(--bg-deep) 40%);
                        color: var(--text-main);
                        margin: 0;
                        padding: 40px 20px;
                        min-height: 100vh;
                        display: flex;
                        justify-content: center;
                    }
                    .container {
                        max-width: 900px;
                        width: 100%;
                    }
                    .glass-panel {
                        background: var(--glass-bg);
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                        border: 1px solid var(--glass-border);
                        border-radius: 20px;
                        padding: 40px;
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                        margin-bottom: 30px;
                    }
                    h1 {
                        font-size: 2.5rem;
                        font-weight: 800;
                        background: linear-gradient(to right, #60a5fa, #c084fc);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        margin-top: 0;
                        margin-bottom: 10px;
                    }
                    p {
                        color: var(--text-muted);
                        line-height: 1.6;
                    }
                    .grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                        gap: 15px;
                        margin-top: 30px;
                    }
                    .btn {
                        background: rgba(255, 255, 255, 0.05);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        color: white;
                        padding: 16px;
                        border-radius: 12px;
                        font-size: 1rem;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.3s ease;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 8px;
                    }
                    .btn:hover {
                        background: var(--primary);
                        border-color: var(--primary-hover);
                        transform: translateY(-3px);
                        box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.5);
                    }
                    /* Loading State */
                    .loader-container {
                        display: none;
                        text-align: center;
                        padding: 40px;
                    }
                    .spinner {
                        width: 40px;
                        height: 40px;
                        border: 4px solid rgba(255,255,255,0.1);
                        border-top-color: var(--primary);
                        border-radius: 50%;
                        animation: spin 1s infinite linear;
                        margin: 0 auto 15px auto;
                    }
                    @keyframes spin { 100% { transform: rotate(360deg); } }
                    
                    /* Image Result */
                    #result-container {
                        display: none;
                        margin-top: 30px;
                        text-align: center;
                    }
                    #result-img {
                        max-width: 100%;
                        border-radius: 12px;
                        border: 1px solid var(--glass-border);
                        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                    }
                    
                    /* How it works */
                    .how-it-works {
                        background: rgba(0, 0, 0, 0.2);
                        border-radius: 12px;
                        padding: 20px;
                        margin-top: 30px;
                        border-left: 4px solid var(--primary);
                    }
                    .how-it-works h4 { margin-top: 0; color: #fff; }
                    .how-it-works ul { margin-bottom: 0; padding-left: 20px; color: var(--text-muted); line-height: 1.8;}
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="glass-panel">
                        <h1>vFootball Screenshot Capture</h1>
                        <p>Select a league below to instantly spin up the background browser, navigate to the specific live category, and capture a full-page encrypted screenshot.</p>
                        
                        <div class="grid">
                            <button class="btn" onclick="captureLeague('England League')">🏴󠁧󠁢󠁥󠁮󠁧󠁿 England</button>
                            <button class="btn" onclick="captureLeague('Spain League')">🇪🇸 Spain</button>
                            <button class="btn" onclick="captureLeague('Italy League')">🇮🇹 Italy</button>
                            <button class="btn" onclick="captureLeague('Germany League')">🇩🇪 Germany</button>
                            <button class="btn" onclick="captureLeague('France League')">🇫🇷 France</button>
                        </div>

                        <div id="loader" class="loader-container">
                            <div class="spinner"></div>
                            <p id="loader-text">Launching Chrome, navigating to SportyBet, selecting category... (Please wait 5-10s)</p>
                        </div>

                        <div style="margin-top: 30px; text-align: center;">
                            <label for="history-date" style="font-weight: 600; color: var(--text-muted);">Optional Historical Date:</label>
                            <input type="date" id="history-date" style="margin-left: 10px; padding: 10px; border-radius: 8px; border: 1px solid var(--glass-border); background: rgba(0,0,0,0.3); color: white; color-scheme: dark;">
                        </div>

                        <div id="result-container" class="glass-panel" style="margin-top: 30px; padding: 20px;">
                            <img id="result-img" alt="Scraped Result">
                        </div>

                        <div id="telemetry-panel" class="glass-panel" style="display: none; margin-top: 20px; padding: 20px; text-align: center; border-color: var(--primary);">
                            <h3 style="color: var(--primary); margin-top: 0; font-size: 1.2rem;">AI Extraction Telemetry</h3>
                            <div style="display: flex; justify-content: space-around; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;">
                                <div style="background: rgba(0,0,0,0.3); padding: 10px 15px; border-radius: 8px;"><strong>Key:</strong> <span id="tel-key" style="color: #fbbf24;">--</span></div>
                                <div style="background: rgba(0,0,0,0.3); padding: 10px 15px; border-radius: 8px;"><strong>Duration:</strong> <span id="tel-duration" style="color: #4ade80;">--</span></div>
                            </div>
                            <div style="display: flex; justify-content: space-around; gap: 10px; flex-wrap: wrap; font-size: 0.85rem; color: #cbd5e1;">
                                <div style="background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);"><strong>RPM:</strong> <span id="tel-rpm">-- / 5</span></div>
                                <div style="background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);"><strong>TPM:</strong> <span id="tel-tpm">-- / 250K</span></div>
                                <div style="background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);"><strong>RPD Today:</strong> <span id="tel-rpd">--</span> <span style="opacity: 0.6;">/ 20</span></div>
                            </div>
                        </div>

                        <div id="error-banner" class="glass-panel" style="display: none; margin-top: 30px; padding: 20px; border-color: #ef4444; background: rgba(239, 68, 68, 0.1);">
                            <h4 style="color: #ef4444; margin-top: 0;">Error Occurred</h4>
                            <p id="error-text" style="color: #f8fafc; font-size: 0.9rem; margin-bottom: 0;"></p>
                        </div>
                        
                        <div class="how-it-works">
                            <h4>How this tool works</h4>
                            <ul>
                                <li><strong>1-Tap Trigger:</strong> Clicking a button sends a secure request to the Node API.</li>
                                <li><strong>Headless Emulation:</strong> The server opens a robust stealth browser that bypasses WAF exactly like humans.</li>
                                <li><strong>UI Navigation:</strong> It specifically searches the DOM, clicks "Football", "vFootball", and precisely opens the "Select Category" dropdown.</li>
                                <li><strong>Timed Screenshots:</strong> A high-resolution UI snapshot is saved to the server as a unique file, then instantly pushed back to you via base64 for preview.</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <script>
                    async function captureLeague(league) {
                        const loader = document.getElementById('loader');
                        const resultContainer = document.getElementById('result-container');
                        const resultImg = document.getElementById('result-img');
                        const loaderText = document.getElementById('loader-text');
                        const dateInput = document.getElementById('history-date').value;

                        // Update UI
                        resultContainer.style.display = 'none';
                        document.getElementById('telemetry-panel').style.display = 'none';
                        loader.style.display = 'block';
                        loaderText.innerText = \`Navigating to \${league}... please wait up to 15 seconds.\`

                        try {
                            const params = new URLSearchParams({ league });
                            if (dateInput) { params.append('date', dateInput); }
                            
                            const response = await fetch(\`/api/vfootball/screenshot-results?\${params.toString()}\`);
                            const data = await response.json();

                            if (data.success && data.base64Image) {
                                resultImg.src = data.base64Image;
                                resultContainer.style.display = 'block';
                                if (data.tokenStats) {
                                    document.getElementById('telemetry-panel').style.display = 'block';
                                    document.getElementById('tel-key').innerText = data.tokenStats.keyIndex + ' of ' + data.tokenStats.totalKeys;
                                    document.getElementById('tel-duration').innerText = (data.tokenStats.durationMs / 1000).toFixed(2) + 's';
                                    document.getElementById('tel-rpm').innerText = (data.tokenStats.rpm || 0) + ' / 5';
                                    document.getElementById('tel-tpm').innerText = (data.tokenStats.tpm || 0).toLocaleString() + ' / 250K';
                                    
                                    const rpdScore = data.tokenStats.rpd || 0;
                                    const rpdEl = document.getElementById('tel-rpd');
                                    rpdEl.innerText = rpdScore;
                                    rpdEl.style.color = rpdScore >= 20 ? '#ef4444' : '#cbd5e1';
                                }
                            } else {
                                alert('Error capturing screenshot: ' + (data.error || 'Unknown error'));
                            }
                        } catch (err) {
                            console.error('[Database Index Debug/Error Details]: Network error:', err);
                            alert('Network critical error occurred while fetching screenshot. Check console.');
                        } finally {
                            loader.style.display = 'none';
                        }
                    }
                </script>
            </body>
        </html>
    `);
});

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
app.get('/api/scores', (req, res) => {
    try {
        if (!globalData) {
            console.log('[DEBUG] [/api/scores] Data not ready yet — scraper still initialising');
            return res.json({ success: true, data: [], status: 'initializing' });
        }
        console.log(`[DEBUG] [/api/scores] Serving cached data with ${globalData[0]?.matches?.length ?? 0} matches`);
        res.json({ success: true, cached: true, data: globalData });
    } catch (error) {
        console.error('[Database Index Debug/Error Details]: [/api/scores] Unexpected error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch live scores', details: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scraper/reload
// Forces the background scraper to close its Chrome instance and cleanly restart.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scraper/reload', async (req, res) => {
    try {
        console.log('[DEBUG] [/api/scraper/reload] Reload requested via API');
        await reloadContinuousScraper();
        res.json({ success: true, message: 'Scraper background reload initiated' });
    } catch (err) {
        console.error('[/api/scraper/reload] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
app.get('/api/vfootball/history', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/debug/history-store  — Internal debug endpoint
// Shows how many matches are accumulated in the history ring buffer.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/debug/history-store', (req, res) => {
    try {
        const info = getHistoryStoreInfo();
        console.log('[DEBUG] [/api/debug/history-store] Store stats:', info);
        res.json({ success: true, ...info });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/debug/live-list  — Trigger a fresh live_list scrape and return raw data
// Useful for diagnosing what the scraper actually sees on the live list page.
// Returns: { leagues[], totalMatches, capturedAt }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/debug/live-list', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/vfootball/sync-all
// Orchestrates a high-speed native sync for all primary leagues.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/vfootball/sync-all', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/screenshot-results
// Captures a screenshot of the requested league's results and runs OCR.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/screenshot-results', async (req, res) => {
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


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/history-logs
// Returns historical batch upload statuses from Database (history_logs collection).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/history-logs', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/results
// Public endpoint — reads from Database Firestore using database_reader.
// Query params: ?page=1&pageSize=5&league=England+-+Virtual&dateFrom=...&dateTo=...
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/public/results', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/available-dates
// Returns a list of unique available dates in the database for the dropdown.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/available-dates', async (req, res) => {
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
app.get('/api/ai/strategy-history', async (req, res) => {
    try {
        const history = await fetchStrategyHistory();
        res.json({ success: true, history });
    } catch (err) {
        console.error('[/api/ai/strategy-history]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-provider
// Returns active prediction AI provider + capability status for all providers
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-provider', (req, res) => {
    try {
        const status = getPredictionProviderStatus();
        console.log(`[/api/ai-provider GET] Active: ${status.active} | ${status.providers.filter(p => p.available).length}/${status.providers.length} ready`);
        res.json({ success: true, ...status });
    } catch (err) {
        console.error('[/api/ai-provider GET] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-provider
// Body: { provider: 'deepseek' | 'gemini' | 'claude' }
// Switches global AI provider for all future predictions (persists for session)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ai-provider', (req, res) => {
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
app.get('/api/vfootball/daily-tips', async (req, res) => {
    try {
        const { date, league } = req.query;
        if (!date || !league) return res.status(400).json({ success: false, error: 'date and league are required' });

        const tip = await getDailyTip(date, league);
        if (tip) {
            return res.json({ success: true, tipData: tip.tipData, cached: true });
        } else {
            return res.json({ success: true, tipData: null, cached: false });
        }
    } catch (err) {
        console.error('[/api/vfootball/daily-tips]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/behaviour-patterns
// Returns saved behaviour pattern signals from Database for a league.
// Optionally runs a live streak profile across all teams in the league.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/behaviour-patterns', async (req, res) => {
    try {
        const { league, mode } = req.query;
        console.log(`[/api/vfootball/behaviour-patterns] league=${league || 'ALL'} mode=${mode || 'history'}`);

        if (mode === 'streak-profile') {
            // Return current win/loss streak profile for all teams in a league
            if (!league) return res.status(400).json({ success: false, error: 'league is required for streak-profile mode' });
            console.log(`[BPE API] 📊 Running live streak profile for ${league}...`);
            const profile = await computeLeagueStreakProfile(league);
            return res.json({ success: true, streakProfile: profile, league, generatedAt: new Date().toISOString() });
        }

        // Default: return saved behaviour signal history from Firestore
        const history = await fetchBehaviourSignals(league || null, 20);
        res.json({ success: true, history, league: league || 'ALL' });
    } catch (err) {
        console.error('[/api/vfootball/behaviour-patterns]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/behaviour-patterns/analyse
// Runs a live behaviour analysis on a given set of upcoming fixtures.
// Compares with previous screenshot results if matchData arrays are provided.
// Body: { league, fixtures: [{homeTeam, awayTeam, gameTime}], latestMatches?, previousMatches? }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vfootball/behaviour-patterns/analyse', async (req, res) => {
    try {
        const { league, fixtures, latestMatches, previousMatches } = req.body;
        if (!league || !fixtures || !Array.isArray(fixtures)) {
            return res.status(400).json({ success: false, error: 'league and fixtures[] are required' });
        }
        console.log(`[BPE API] 🧠 Ad-hoc behaviour analysis: ${fixtures.length} fixtures in ${league}`);

        // Run pattern detection
        const signals = await detectBehaviourPatterns(fixtures, league);

        // Optional: compare two screenshot result sets if provided
        let comparisonReport = null;
        if (Array.isArray(latestMatches) && Array.isArray(previousMatches) && latestMatches.length > 0) {
            console.log('[BPE API] 🔍 Running screenshot comparison analysis...');
            comparisonReport = compareScreenshotResults(latestMatches, previousMatches);
        }

        // Save signals to Database for dashboard history
        const today = todayDDMMYYYY();
        await saveBehaviourSignals(signals, league, today).catch(e =>
            console.error('[BPE API] Save error (non-fatal):', e.message)
        );

        res.json({
            success: true,
            signals,
            totalSignals: signals.reduce((sum, s) => sum + (s.signals?.length || 0), 0),
            promptInjection: buildBehaviourPromptInjection(signals),
            comparisonReport,
            league,
            analyzedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('[/api/vfootball/behaviour-patterns/analyse]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/league-baselines
// Returns all cached League DNA baselines from MongoDB (used by UI panels)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/league-baselines', async (req, res) => {
    try {
        const { LeagueBaseline } = require('./db_init');
        const { league } = req.query;
        console.log(`[/api/vfootball/league-baselines] Fetching baselines — league=${league || 'ALL'}`);

        const query = league ? { _id: league } : {};
        const baselines = await LeagueBaseline.find(query).lean();

        // Sort by match count descending (most data first)
        baselines.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));

        const lastComputed = baselines.length > 0
            ? baselines.reduce((latest, bl) => {
                const d = new Date(bl.lastComputed || 0);
                return d > latest ? d : latest;
            }, new Date(0))
            : null;

        console.log(`[/api/vfootball/league-baselines] Returning ${baselines.length} baselines.`);
        res.json({ success: true, baselines, count: baselines.length, lastComputed });
    } catch (err) {
        console.error('[/api/vfootball/league-baselines] Error:', err.message);
        res.status(500).json({ success: false, error: `Failed to load baselines: ${err.message}` });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vfootball/league-baselines/compute
// Triggers a full DNA baseline recompute from the last N days of MongoDB data
// Body: { daysBack?: number } (default: 7)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/vfootball/league-baselines/compute', async (req, res) => {
    try {
        const { daysBack = 7 } = req.body || {};
        console.log(`[/api/league-baselines/compute] 🧬 Triggering DNA recompute (last ${daysBack} days)...`);
        broadcastAiStatus('progress', `🧬 Computing League DNA Baselines from last ${daysBack} days...`);

        const baselines = await computeAllLeagueBaselines(Number(daysBack));

        broadcastAiStatus('success', `✅ League DNA computed for ${baselines.length} leagues.`);
        console.log(`[/api/league-baselines/compute] ✅ Computed ${baselines.length} baselines.`);

        res.json({
            success: true,
            computed: baselines.length,
            leagues: baselines.map(b => b.league),
            summary: baselines.map(b => ({
                league: b.league,
                matchCount: b.matchCount,
                over1_5: b.stats?.over1_5Percent,
                over2_5: b.stats?.over2_5Percent,
                btts: b.stats?.bttsPercent,
                homeWin: b.stats?.homeWinPercent,
                draw: b.stats?.drawPercent,
                topScore: b.topScores?.[0]?.score,
            }))
        });
    } catch (err) {
        console.error('[/api/league-baselines/compute] Error:', err.message);
        broadcastAiStatus('error', `DNA compute failed: ${err.message}`);
        res.status(500).json({ success: false, error: `Baseline compute failed: ${err.message}` });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/daily-tips/history
// Fetches the entire logged history of daily tips (upcoming predictions).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/daily-tips/history', async (req, res) => {
    try {
        const { league } = req.query;
        const history = await getAllDailyTips(league);
        res.json({ success: true, history });
    } catch (err) {
        console.error('[/api/vfootball/daily-tips/history]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});
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
app.get('/api/vfootball/league-intelligence/:league', async (req, res) => {
    try {
        const { league } = req.params;
        const decoded = decodeURIComponent(league);
        const intelDoc = await getLeagueIntelligence(decoded);

        if (intelDoc) {
            res.json({ success: true, data: intelDoc.merged || intelDoc.profile || intelDoc, rawDoc: intelDoc });
        } else {
            res.json({ success: true, data: null });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vfootball/team-form
// Returns recent W/D/L form for a specific team in a league.
// Query params: league, team, limit (optional, default 10)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/team-form', async (req, res) => {
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


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-strategy
// Returns the currently active AI prediction strategy.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-strategy', async (req, res) => {
    try {
        const strategy = await getStrategy();
        res.json({ success: true, strategy });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-memory
// Returns the entire AI memory log (used for admin / user display).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-memory', async (req, res) => {
    try {
        const log = await getLog();
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/ai-memory/:id
// Deletes a specific entry by ID, or pass ?clearAll=true to wipe the whole log.
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/ai-memory/:id', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/screenshot-preview/:filename
// Serves a screenshot PNG directly as an image for UI thumbnails and previews.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/screenshot-preview/:filename', (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/screenshots
// Lists all PNG screenshots in testdownloadpage/, newest first.
// Each entry includes: filename, absolutePath, sizeBytes, capturedAt, isNew
// isNew = true if the file's MD5 hash is NOT in processed_images_hash.json
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/screenshots', (req, res) => {
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
app.post('/api/reset-visual-hashes', (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/db-stream
// Real-time SSE stream that notifies clients when the database has been updated
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/db-stream', (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync-local-to-database
// Pushes ALL records from extracted_league_data.json to Database.
// This is the recovery path for data that was extracted but never uploaded
// (e.g. due to past pipeline errors). Streams SSE progress back to the UI.
// Optional body: { leagueFilter: "Germany - Virtual" } to filter by league.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/sync-local-to-database', async (req, res) => {
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

app.post('/api/extract-and-upload', async (req, res) => {

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


// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/screenshots/:filename
// Deletes a specific screenshot PNG (and its .meta.json if present).
// Validates filename to prevent path traversal attacks.
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/screenshots/:filename', (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/screenshots/process-pending
// Loops through all pending .png files in the server directory
// processes them explicitly and uploads to Database.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/screenshots/process-pending', async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-provider  — returns the currently configured AI provider
// POST /api/ai-provider — updates the active provider (claude | openai)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-provider', (req, res) => {
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

app.post('/api/ai-provider', express.json(), (req, res) => {
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

app.delete('/api/admin/league/:leagueName', async (req, res) => {
    try {
        const { leagueName } = req.params;
        const { date } = req.query; // optional date DD/MM/YYYY
        console.log(`[DEBUG] [DELETE /api/admin/league] Request to delete league: ${leagueName}${date ? ` on date ${date}` : ''}`);

        if (!leagueName) {
            return res.status(400).json({ success: false, error: 'League name is required' });
        }

        const stats = await deleteLeagueData(leagueName, date);
        console.log(`[Admin] ✅ Deleted league ${leagueName} (date: ${date || 'ALL'}):`, stats);
        
        const scopeStr = date ? `for date ${date}` : 'and all historical records';
        res.json({ 
            success: true, 
            message: `Successfully removed ${leagueName} ${scopeStr}.`, 
            stats 
        });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [DELETE /api/admin/league]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
app.get('/api/pattern-intel', async (req, res) => {
    try {
        const leagueFilter = req.query.league || null;
        const minPct = parseFloat(req.query.minPct) || 80;
        const minSamples = parseInt(req.query.minSamples) || 3;

        console.log(`[PatternIntel] 🧠 Computing pattern intel — league=${leagueFilter || 'ALL'} minPct=${minPct}% minSamples=${minSamples}`);

        const allDocs = await getCachedDocs();
        console.log(`[PatternIntel] Loaded ${allDocs.length} total match records from cache`);

        // ── Step 1: Group all docs into per-team chronological histories ──────
        const teamMatchMap = {}; // { [league]: { [team]: [...matchRecords sorted by date] } }

        let minDate = null, maxDate = null;

        for (const m of allDocs) {
            if (!m.score || !/^\d+[:\-]\d+$/.test(m.score.trim())) continue;
            const lg = m.league || 'Unknown';
            if (leagueFilter && lg !== leagueFilter) continue;

            const parts = m.date ? m.date.split('/') : null;
            const time = m.time ? m.time.split(':') : ['0','0'];
            const parsedDate = parts && parts.length === 3
                ? new Date(parts[2], parts[1]-1, parts[0], parseInt(time[0])||0, parseInt(time[1])||0)
                : new Date(0);

            if (parsedDate.getTime() !== 0) {
                if (!minDate || parsedDate < minDate) minDate = parsedDate;
                if (!maxDate || parsedDate > maxDate) maxDate = parsedDate;
            }

            if (!teamMatchMap[lg]) teamMatchMap[lg] = {};

            const addEntry = (team, isHome) => {
                if (!team) return;
                if (!teamMatchMap[lg][team]) teamMatchMap[lg][team] = [];
                teamMatchMap[lg][team].push({ ...m, isHome, parsedDate });
            };
            addEntry(m.homeTeam, true);
            addEntry(m.awayTeam, false);
        }

        // Sort each team's matches chronologically
        for (const lg of Object.keys(teamMatchMap)) {
            for (const team of Object.keys(teamMatchMap[lg])) {
                teamMatchMap[lg][team].sort((a, b) => a.parsedDate - b.parsedDate);
            }
        }

        // ── Step 2: Compute pattern statistics ────────────────────────────────
        // patternStore[lg][score][role][team] = { total, nextWin, nextLoss, nextDraw, nextOver15, nextOver25, nextGG, nextHomeOver05, nextAwayOver05, triggers: [] }
        const patternStore = {};

        for (const lg of Object.keys(teamMatchMap)) {
            patternStore[lg] = {};
            for (const team of Object.keys(teamMatchMap[lg])) {
                const matches = teamMatchMap[lg][team];
                for (let i = 0; i < matches.length - 1; i++) {
                    const cur = matches[i];
                    const nxt = matches[i+1];
                    const score = cur.score.replace('-', ':').trim();
                    const role = cur.isHome ? 'Home' : 'Away';

                    if (!patternStore[lg][score]) patternStore[lg][score] = {};
                    if (!patternStore[lg][score][role]) patternStore[lg][score][role] = {};
                    if (!patternStore[lg][score][role][team]) {
                        patternStore[lg][score][role][team] = {
                            total: 0, nextWin: 0, nextLoss: 0, nextDraw: 0,
                            nextOver15: 0, nextOver25: 0, nextGG: 0,
                            nextHomeOver05: 0, nextAwayOver05: 0,
                            triggers: []
                        };
                    }

                    const st = patternStore[lg][score][role][team];
                    st.total++;

                    const np = nxt.score.replace('-', ':').split(':').map(Number);
                    const ngf = nxt.isHome ? np[0] : np[1];
                    const nga = nxt.isHome ? np[1] : np[0];
                    const ntg = ngf + nga;

                    if (ngf > nga) st.nextWin++;
                    else if (ngf < nga) st.nextLoss++;
                    else st.nextDraw++;
                    if (ntg > 1.5) st.nextOver15++;
                    if (ntg > 2.5) st.nextOver25++;
                    if (ngf > 0 && nga > 0) st.nextGG++;
                    if (np[0] > 0) st.nextHomeOver05++;
                    if (np[1] > 0) st.nextAwayOver05++;

                    // Store the trigger (current match) and the next match together
                    st.triggers.push({
                        team,
                        triggerDate: cur.date,
                        triggerTime: cur.time,
                        triggerScore: cur.score,
                        triggerHomeTeam: cur.homeTeam,
                        triggerAwayTeam: cur.awayTeam,
                        triggerRole: role,
                        nextDate: nxt.date,
                        nextTime: nxt.time,
                        nextScore: nxt.score,
                        nextHomeTeam: nxt.homeTeam,
                        nextAwayTeam: nxt.awayTeam,
                        nextIsHome: nxt.isHome,
                        parsedDate: cur.parsedDate
                    });
                }
            }
        }

        // ── Step 3: Filter patterns that hit ≥ minPct% ──────────────────────
        const elitePatterns = [];

        for (const lg of Object.keys(patternStore).sort()) {
            for (const score of Object.keys(patternStore[lg]).sort()) {
                for (const role of ['Home', 'Away']) {
                    if (!patternStore[lg][score][role]) continue;
                    for (const team of Object.keys(patternStore[lg][score][role])) {
                        const st = patternStore[lg][score][role][team];
                        if (!st || st.total < minSamples) continue;

                        const pct = (k) => Math.round((st[k] / st.total) * 100);
                        const eliteOutcomes = [];

                        const checkAdd = (key, label, emoji) => {
                            const p = pct(key);
                            if (p >= minPct) {
                                eliteOutcomes.push({
                                    key, label, emoji, pct: p,
                                    hit: st[key], failed: st.total - st[key]
                                });
                            }
                        };

                        checkAdd('nextWin',       'Win',             '🏆');
                        checkAdd('nextLoss',      'Loss',            '❌');
                        checkAdd('nextDraw',      'Draw',            '🤝');
                        checkAdd('nextOver15',    'Over 1.5',        '⚽');
                        checkAdd('nextOver25',    'Over 2.5',        '🔥');
                        checkAdd('nextGG',        'GG (BTTS)',       '🥅');
                        checkAdd('nextHomeOver05','Home Scores',     '🏠');
                        checkAdd('nextAwayOver05','Away Scores',     '✈️');

                        if (eliteOutcomes.length === 0) continue;

                        // Sort triggers by date descending — most recent first
                        st.triggers.sort((a, b) => b.parsedDate - a.parsedDate);

                        // Most recent trigger (the match we want to act on)
                        const mostRecent = st.triggers[0] || null;

                        elitePatterns.push({
                            league: lg,
                            score,
                            role,
                            team,
                            sampleSize: st.total,
                            eliteOutcomes,
                            mostRecentTrigger: mostRecent,
                            recentTriggers: st.triggers.slice(0, 5) // show 5 for context
                        });
                    }
                }
            }
        }

        // ── Step 4: Find LIVE ACTIVE Predictions for Today ─────────────────────
        // We only show a pattern if a team's ABSOLUTE LATEST MATCH (played today)
        // matches an elite pattern. This means their "next match" hasn't happened yet,
        // making this a true live prediction for their upcoming fixture!
        
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        const todayStr = `${dd}/${mm}/${yyyy}`; // DD/MM/YYYY

        const activeLivePatterns = [];

        for (const lg of Object.keys(teamMatchMap)) {
            for (const team of Object.keys(teamMatchMap[lg])) {
                const matches = teamMatchMap[lg][team];
                if (matches.length === 0) continue;

                // The absolute latest match this team played
                const latestMatch = matches[matches.length - 1];

                // Only care if their latest match was played TODAY
                if (latestMatch.date !== todayStr) continue;

                const score = latestMatch.score.replace('-', ':').trim();
                const role = latestMatch.isHome ? 'Home' : 'Away';

                // Do they have an elite historical pattern for this score/role?
                const st = patternStore[lg]?.[score]?.[role]?.[team];
                if (!st || st.total < minSamples) continue;

                const pct = (k) => Math.round((st[k] / st.total) * 100);
                const eliteOutcomes = [];

                const checkAdd = (key, label, emoji) => {
                    const p = pct(key);
                    if (p >= minPct) {
                        eliteOutcomes.push({
                            key, label, emoji, pct: p,
                            hit: st[key], failed: st.total - st[key]
                        });
                    }
                };

                checkAdd('nextWin',       'Win',             '🏆');
                checkAdd('nextLoss',      'Loss',            '❌');
                checkAdd('nextDraw',      'Draw',            '🤝');
                checkAdd('nextOver15',    'Over 1.5',        '⚽');
                checkAdd('nextOver25',    'Over 2.5',        '🔥');
                checkAdd('nextGG',        'GG (BTTS)',       '🥅');
                checkAdd('nextHomeOver05','Home Scores',     '🏠');
                checkAdd('nextAwayOver05','Away Scores',     '✈️');

                // If they have elite outcomes, this is an ACTIVE LIVE PREDICTION!
                if (eliteOutcomes.length > 0) {
                    const mostRecent = {
                        team,
                        triggerDate: latestMatch.date,
                        triggerTime: latestMatch.time,
                        triggerScore: latestMatch.score,
                        triggerHomeTeam: latestMatch.homeTeam,
                        triggerAwayTeam: latestMatch.awayTeam,
                        triggerRole: role,
                        // No next match info because it hasn't happened yet!
                    };

                    // Re-sort historical triggers descending to show recent context
                    // Only include triggers that have a resolved next match (exclude today's live one)
                    st.triggers.sort((a, b) => b.parsedDate - a.parsedDate);
                    const resolvedTriggers = st.triggers.filter(tr => tr.nextScore);

                    activeLivePatterns.push({
                        league: lg,
                        score,
                        role,
                        team,
                        sampleSize: st.total,
                        eliteOutcomes,
                        mostRecentTrigger: mostRecent,
                        recentTriggers: resolvedTriggers.slice(0, 5) // show 5 historical examples with results
                    });
                }
            }
        }

        console.log(`[PatternIntel] ✅ Found ${elitePatterns.length} total elite patterns — ${activeLivePatterns.length} LIVE predictions right now (${todayStr})`);

        // Sort live patterns by their trigger time — most recently triggered first
        activeLivePatterns.sort((a, b) => {
            const tA = a.mostRecentTrigger?.triggerTime || '00:00';
            const tB = b.mostRecentTrigger?.triggerTime || '00:00';
            return tB.localeCompare(tA); // latest time first
        });
        console.log(`[PatternIntel] 🕐 Patterns sorted by trigger time. First: ${activeLivePatterns[0]?.team} @ ${activeLivePatterns[0]?.mostRecentTrigger?.triggerTime}`);

        // ── Auto-save snapshot to MongoDB for historical browsing ──────────────
        if (activeLivePatterns.length > 0) {
            PatternSnapshot.bulkWrite(activeLivePatterns.map(p => {
                const safe = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '');
                const id = `${todayStr}_${safe(p.league)}_${safe(p.team)}_${safe(p.score)}_${p.role}`;
                return {
                    updateOne: {
                        filter: { _id: id },
                        update: { $set: { snapshotDate: todayStr, ...p, savedAt: new Date() }, $setOnInsert: { resolved: false, outcomeResults: {} } },
                        upsert: true,
                    }
                };
            }), { ordered: false }).catch(e => console.warn('[PatternSnapshot] ⚠️ Auto-save failed (non-fatal):', e.message));
        }

        res.json({
            success: true,
            today: todayStr,
            totalPatterns: activeLivePatterns.length,
            totalAllTime: elitePatterns.length,
            dataRange: {
                from: minDate ? minDate.toDateString() : 'Unknown',
                to: maxDate ? maxDate.toDateString() : 'Unknown'
            },
            patterns: activeLivePatterns,
            config: { minPct, minSamples }
        });

    } catch (err) {
        console.error('[PatternIntel] ❌ Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai-predict-pattern
// Uses the active AI to write a natural language prediction for the next fixture
// based on the statistical pattern provided.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ai-predict-pattern', express.json(), async (req, res) => {
    try {
        const { pattern } = req.body;
        if (!pattern || !pattern.team || !pattern.score) {
            return res.status(400).json({ success: false, error: 'Pattern data is required' });
        }

        const { callPredictionAI, getActivePredictionProvider } = require('./prediction_ai');
        const { computeTeamForm, getLeagueBaseline } = require('./db_reader');
        const { getLeagueIntelligence } = require('./ai_memory');
        
        const activeProvider = getActivePredictionProvider();

        const [teamForm, leagueBaseline, leagueIntel] = await Promise.all([
            computeTeamForm(pattern.league, pattern.team),
            getLeagueBaseline(pattern.league),
            getLeagueIntelligence(pattern.league)
        ]);

        const prompt = `
You are an elite, world-class sports betting algorithmic analyst. 
Your goal is to synthesize multiple data points to guarantee an extraordinary, highly profitable betting prediction.

1. PATTERN TRIGGER (PRIMARY SIGNAL)
Team: ${pattern.team}
League: ${pattern.league}
Event: ${pattern.team} just played a match ending in ${pattern.score} as the ${pattern.role} team.
When this exact scenario happens, historical data for their NEXT match shows:
${pattern.eliteOutcomes.map(o => `- ${o.label}: ${o.pct}% probability (Hits: ${o.hit}, Fails: ${o.failed})`).join('\n')}
(Sample Size: ${pattern.sampleSize} historical matches)

2. CURRENT TEAM FORM (LAST 10 MATCHES)
Streak: ${teamForm.streak}
Win Rate: ${Math.round((teamForm.wins/(teamForm.matchesAnalysed||1))*100)}% (W${teamForm.wins} D${teamForm.draws} L${teamForm.losses})
Avg Goals Scored: ${teamForm.goalsScored} / Avg Conceded: ${teamForm.goalsConceded}
Over 2.5 Hit Rate: ${teamForm.over2_5_percent}% / BTTS Hit Rate: ${teamForm.btts_percent}%

3. LEAGUE DNA & TACTICAL INTELLIGENCE
League Baseline Avg Goals: ${leagueBaseline?.stats?.avgGoals || 'N/A'}
League Over 2.5 Rate: ${leagueBaseline?.stats?.over2_5Percent || 'N/A'}%
AI Tactical Intel: ${leagueIntel?.tacticalSummary || 'No tactical intel available.'}

INSTRUCTIONS:
Synthesize the Pattern Trigger with the Team Form and League DNA to provide a true expert edge. 
Do NOT just blindly repeat the stats. Cross-reference the pattern with their current actual form and league tendencies to validate or challenge the primary signal.
Write a very brief, punchy, expert-level betting recommendation (2-3 sentences max).
Focus on the most mathematically sound and logical outcome.
Return ONLY the recommendation text, no formatting, no JSON, no preamble.
`;

        console.log(`[PatternIntel] 🤖 Asking ${activeProvider} to predict pattern for ${pattern.team}...`);
        
        const result = await callPredictionAI(prompt, activeProvider, {
            temperature: 0.7,
            maxTokens: 150
        });

        res.json({ success: true, prediction: result.content.trim(), provider: activeProvider });

    } catch (err) {
        console.error('[PatternIntel] ❌ AI Prediction Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/upcoming-ai-analysis
// Analyzes the best active patterns against real-time upcoming fixtures using AI.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/pattern-intel/upcoming-ai-analysis', async (req, res) => {
    try {
        console.log('[Upcoming AI] 🤖 Generating consolidated AI analysis for best upcoming fixtures...');
        const minPct = 80;
        
        // 1. Fetch current active patterns
        const port = process.env.PORT || 3001;
        const patternRes = await fetch(`http://localhost:${port}/api/pattern-intel?minPct=${minPct}`);
        const patternJson = await patternRes.json();
        
        if (!patternJson.success) throw new Error(patternJson.error || 'Failed to fetch pattern intel');
        
        let patterns = patternJson.patterns || [];
        
        // 2. Filter top patterns (must have elite outcomes > 80%)
        patterns = patterns.filter(p => p.eliteOutcomes && p.eliteOutcomes.some(o => o.pct >= minPct));
        
        // Sort by highest probability outcome
        patterns.sort((a, b) => {
            const maxA = Math.max(...a.eliteOutcomes.map(o => o.pct));
            const maxB = Math.max(...b.eliteOutcomes.map(o => o.pct));
            return maxB - maxA;
        });
        
        // 3. Cross-reference STRICTLY with the live list.
        // Patterns are derived from completed results — the "next match" for each pattern
        // team MUST be what is currently live. We never fall back to upcoming/betslip fixtures
        // (globalData) because those haven't started yet and would give wrong predictions.
        const liveListGames = await scrapeLiveListOnDemand();
        const liveMatchCount = liveListGames.reduce((acc, g) => acc + (g.matches?.length || 0), 0);
        console.log(`[Upcoming AI] Live list scraped: ${liveListGames.length} league groups, ${liveMatchCount} total live matches.`);

        if (!liveListGames || liveListGames.length === 0 || liveMatchCount === 0) {
            console.log('[Upcoming AI] Live list is empty — waiting for next match round.');
            return res.json({
                success: true,
                message: 'The live list is empty right now. Waiting for the next match round to start (usually within 5 minutes).',
                analyses: []
            });
        }

        const upcomingMatches = [];
        const topPatterns = patterns.slice(0, 15); // Don't check too many

        for (const pattern of topPatterns) {
            let foundFixture = null;

            // STRICTLY search the live list only — no globalData fallback
            for (const group of liveListGames) {
                const pCountry = pattern.league.split(' ')[0];
                // Match by exact league name, or by the country prefix (e.g. "England"), or catch-all virtual groups
                if (
                    group.league !== pattern.league &&
                    group.league !== 'vFootball Live Odds' &&
                    group.league !== 'vFootball Live' &&
                    (!group.league || !group.league.includes(pCountry))
                ) continue;

                const fixture = group.matches.find(m =>
                    m.home?.includes(pattern.team) ||
                    m.away?.includes(pattern.team) ||
                    pattern.team.includes(m.home) ||
                    pattern.team.includes(m.away)
                );

                if (fixture) {
                    foundFixture = fixture;
                    console.log(`[Upcoming AI] ✅ Pattern team "${pattern.team}" (${pattern.league}) is LIVE: ${fixture.home} vs ${fixture.away}`);
                    break;
                }
            }

            if (!foundFixture) {
                console.log(`[Upcoming AI] ⏳ Pattern team "${pattern.team}" (${pattern.league}) not found in live list — skipping this round.`);
                continue; // This team isn't playing yet — skip, don't pollute analysis
            }

            const isHome = foundFixture.home?.includes(pattern.team) || pattern.team.includes(foundFixture.home);
            const displayTime = foundFixture.time ? `${foundFixture.time} (LIVE)` : 'LIVE';

            upcomingMatches.push({
                pattern,
                fixture: {
                    time: displayTime,
                    code: foundFixture.code,
                    home: foundFixture.home,
                    away: foundFixture.away,
                    odds: foundFixture.score,
                    teamRole: isHome ? 'Home' : 'Away',
                    opponent: isHome ? foundFixture.away : foundFixture.home
                }
            });
        }

        // Take top 5 best live matches
        const finalMatches = upcomingMatches.slice(0, 5);
        console.log(`[Upcoming AI] ${finalMatches.length} live pattern matches found for AI analysis.`);

        if (finalMatches.length === 0) {
            return res.json({
                success: true,
                message: 'None of the elite pattern teams are currently live. The live list is active but no pattern team is playing right now — check back in a few minutes.',
                analyses: []
            });
        }
        
        // 4. Send to AI
        const { callPredictionAI, getActivePredictionProvider, parseAIJson } = require('./prediction_ai');
        const activeProvider = getActivePredictionProvider();
        
        const matchDataStr = finalMatches.map((m, i) => `
MATCH ${i+1}:
Team with Pattern: ${m.pattern.team} (${m.pattern.league})
Upcoming Fixture: ${m.fixture.home} vs ${m.fixture.away} (Time: ${m.fixture.time})
Odds string: ${m.fixture.odds}
Pattern Trigger: Just played ending in ${m.pattern.score} as ${m.pattern.role}.
Historical Next Match Outcomes (Sample: ${m.pattern.sampleSize}):
${m.pattern.eliteOutcomes.map(o => `- ${o.label}: ${o.pct}% probability`).join('\n')}
`).join('\n');

        const prompt = `
You are an elite sports betting algorithmic analyst. 
I am providing you with the top ${finalMatches.length} mathematically backed predictions for fixtures starting in the NEXT 5 MINUTES.
Your task is to analyze these upcoming fixtures based on the historical pattern data.

DATA:
${matchDataStr}

INSTRUCTIONS:
Return a JSON array of analysis objects. DO NOT return markdown blocks around the JSON, just the raw JSON array.
Each object in the array must have the following keys:
- "match": string (e.g. "Chelsea vs Arsenal")
- "time": string (The match starting time from the data provided)
- "team": string (The team the pattern is about)
- "league": string (The league name provided in the data, e.g. "England - Virtual")
- "pattern": string (Brief summary of the pattern trigger)
- "signal": string (The highest probability outcome, e.g. "Win (85%)")
- "analysis": string (A punchy 2-3 sentence expert explanation synthesizing the pattern against the specific opponent. Be extremely confident and professional.)
- "confidence": number (A score out of 100 based on the probability)
- "color": string (A hex color code representing the outcome type: e.g. Win=#00FF88, Goals=#00E5FF)
`;

        const result = await callPredictionAI(prompt, activeProvider, {
            temperature: 0.4,
            maxTokens: 2000
        });
        
        const analyses = parseAIJson(result.content);
        
        res.json({
            success: true,
            provider: activeProvider,
            analyses: Array.isArray(analyses) ? analyses : [analyses]
        });

    } catch (err) {
        console.error('[Upcoming AI] ❌ Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pattern-intel/save-snapshot
// Called automatically when /api/pattern-intel runs — persists today's live
// patterns into MongoDB so they can be browsed historically.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/pattern-intel/save-snapshot', express.json(), async (req, res) => {
    try {
        const { patterns, snapshotDate } = req.body;
        if (!patterns || !snapshotDate) {
            return res.status(400).json({ success: false, error: 'patterns and snapshotDate required' });
        }
        console.log(`[PatternSnapshot] 💾 Saving ${patterns.length} pattern snapshots for ${snapshotDate}...`);

        const ops = patterns.map(p => {
            const safe = (s) => s.replace(/[^a-zA-Z0-9]/g, '');
            const id = `${snapshotDate}_${safe(p.league)}_${safe(p.team)}_${safe(p.score)}_${p.role}`;
            return {
                updateOne: {
                    filter: { _id: id },
                    update: {
                        $set: {
                            snapshotDate,
                            league: p.league,
                            team: p.team,
                            score: p.score,
                            role: p.role,
                            sampleSize: p.sampleSize,
                            eliteOutcomes: p.eliteOutcomes,
                            mostRecentTrigger: p.mostRecentTrigger,
                            recentTriggers: p.recentTriggers || [],
                            savedAt: new Date(),
                        },
                        $setOnInsert: { resolved: false, outcomeResults: {} }
                    },
                    upsert: true,
                }
            };
        });

        if (ops.length > 0) await PatternSnapshot.bulkWrite(ops, { ordered: false });
        console.log(`[PatternSnapshot] ✅ Saved/updated ${ops.length} snapshots for ${snapshotDate}`);
        res.json({ success: true, saved: ops.length });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ Save error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/dates
// Returns all dates that have saved pattern snapshots, newest first.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/pattern-intel/dates', async (req, res) => {
    try {
        const dates = await PatternSnapshot.distinct('snapshotDate');
        // Sort DD/MM/YYYY descending
        dates.sort((a, b) => {
            const parse = d => { const [dd,mm,yyyy] = d.split('/'); return new Date(`${yyyy}-${mm}-${dd}`); };
            return parse(b) - parse(a);
        });
        console.log(`[PatternSnapshot] 📅 Found ${dates.length} snapshot dates`);
        res.json({ success: true, dates });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ dates error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/history?date=DD/MM/YYYY
// Returns all saved pattern snapshots for a given date.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/pattern-intel/history', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ success: false, error: 'date query param required' });
        console.log(`[PatternSnapshot] 📖 Fetching history for ${date}...`);
        const docs = await PatternSnapshot.find({ snapshotDate: date }).lean();
        console.log(`[PatternSnapshot] ✅ Found ${docs.length} snapshots for ${date}`);
        res.json({ success: true, date, patterns: docs });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ history error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pattern-intel/performance
// Computes the full performance overview across ALL resolved + unresolved
// pattern snapshots. Shows per-outcome hit rates, streaks, and best patterns.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/pattern-intel/performance', async (req, res) => {
    try {
        console.log('[PatternSnapshot] 📊 Computing performance overview...');
        const allDocs = await PatternSnapshot.find({}).lean();

        // ── Auto-resolve: check if team's next match exists in vfootball_results ──
        const allResults = await getCachedDocs();
        const todayStr = todayDDMMYYYY();
        let autoResolved = 0;

        for (const snap of allDocs) {
            if (snap.resolved) continue;
            // Find the next match for this team AFTER snapshotDate
            const parseDate = (d) => { if (!d) return new Date(0); const [dd,mm,yyyy] = d.split('/'); return new Date(`${yyyy}-${mm}-${dd}`); };
            const triggerDate = parseDate(snap.snapshotDate);

            const teamMatches = allResults.filter(m =>
                m.league === snap.league &&
                (m.homeTeam === snap.team || m.awayTeam === snap.team) &&
                m.score && /^\d+[:\-]\d+$/.test(m.score.trim())
            );

            const laterMatches = teamMatches.filter(m => parseDate(m.date) > triggerDate)
                .sort((a, b) => parseDate(a.date) - parseDate(b.date));

            if (laterMatches.length === 0) continue; // still pending

            const nextMatch = laterMatches[0];
            const parts = nextMatch.score.replace('-', ':').split(':').map(Number);
            const isHome = nextMatch.homeTeam === snap.team;
            const gf = isHome ? parts[0] : parts[1];
            const ga = isHome ? parts[1] : parts[0];
            const tg = gf + ga;

            const resolvedOutcomes = {
                win: gf > ga,
                loss: gf < ga,
                draw: gf === ga,
                over15: tg > 1.5,
                over25: tg > 2.5,
                gg: gf > 0 && ga > 0,
                homeScores: parts[0] > 0,
                awayScores: parts[1] > 0,
            };

            const keyMap = { Win: 'win', Loss: 'loss', Draw: 'draw', 'Over 1.5': 'over15', 'Over 2.5': 'over25', 'GG (BTTS)': 'gg', 'Home Scores': 'homeScores', 'Away Scores': 'awayScores' };
            const outcomeResults = {};
            (snap.eliteOutcomes || []).forEach(o => {
                const k = keyMap[o.label];
                if (k !== undefined) outcomeResults[o.label] = resolvedOutcomes[k];
            });

            await PatternSnapshot.findByIdAndUpdate(snap._id, {
                $set: {
                    resolved: true,
                    resolvedDate: nextMatch.date,
                    resolvedScore: nextMatch.score,
                    resolvedOutcomes,
                    outcomeResults,
                }
            });
            Object.assign(snap, { resolved: true, resolvedDate: nextMatch.date, resolvedScore: nextMatch.score, resolvedOutcomes, outcomeResults });
            autoResolved++;
        }

        if (autoResolved > 0) console.log(`[PatternSnapshot] ✅ Auto-resolved ${autoResolved} pending snapshots`);

        // ── Compute global statistics ──────────────────────────────────────────
        const resolved = allDocs.filter(d => d.resolved);
        const pending  = allDocs.filter(d => !d.resolved);

        // Per-outcome aggregate stats
        const outcomeStats = {};
        const outcomeKeys = ['Win', 'Loss', 'Draw', 'Over 1.5', 'Over 2.5', 'GG (BTTS)', 'Home Scores', 'Away Scores'];
        outcomeKeys.forEach(k => { outcomeStats[k] = { predictions: 0, hits: 0, misses: 0 }; });

        for (const snap of resolved) {
            const results = snap.outcomeResults || {};
            for (const [label, hit] of Object.entries(results)) {
                if (!outcomeStats[label]) outcomeStats[label] = { predictions: 0, hits: 0, misses: 0 };
                outcomeStats[label].predictions++;
                if (hit === true)  outcomeStats[label].hits++;
                if (hit === false) outcomeStats[label].misses++;
            }
        }

        const outcomeSummary = Object.entries(outcomeStats)
            .filter(([, s]) => s.predictions > 0)
            .map(([label, s]) => ({
                label,
                predictions: s.predictions,
                hits: s.hits,
                misses: s.misses,
                hitRate: s.predictions > 0 ? Math.round((s.hits / s.predictions) * 100) : 0,
            }))
            .sort((a, b) => b.hitRate - a.hitRate);

        // Per-date summary
        const byDate = {};
        for (const snap of resolved) {
            const d = snap.snapshotDate;
            if (!byDate[d]) byDate[d] = { date: d, total: 0, hits: 0, misses: 0 };
            byDate[d].total++;
            const r = snap.outcomeResults || {};
            const allHit  = Object.values(r).every(v => v === true);
            const anyMiss = Object.values(r).some(v => v === false);
            if (allHit)  byDate[d].hits++;
            if (anyMiss) byDate[d].misses++;
        }
        const dateSummary = Object.values(byDate).sort((a, b) => {
            const parse = d => { const [dd,mm,yy] = d.split('/'); return new Date(`${yy}-${mm}-${dd}`); };
            return parse(b.date) - parse(a.date);
        });

        // Best performing patterns (score+role combinations)
        const patternPerf = {};
        for (const snap of resolved) {
            const key = `${snap.score}_${snap.role}_${snap.league}`;
            if (!patternPerf[key]) patternPerf[key] = { score: snap.score, role: snap.role, league: snap.league, total: 0, hits: 0 };
            patternPerf[key].total++;
            const r = snap.outcomeResults || {};
            if (Object.values(r).every(v => v === true)) patternPerf[key].hits++;
        }
        const topPatterns = Object.values(patternPerf)
            .filter(p => p.total >= 2)
            .map(p => ({ ...p, hitRate: Math.round((p.hits / p.total) * 100) }))
            .sort((a, b) => b.hitRate - a.hitRate)
            .slice(0, 10);

        const totalPredictions = resolved.reduce((s, snap) => s + Object.keys(snap.outcomeResults || {}).length, 0);
        const totalHits = resolved.reduce((s, snap) => s + Object.values(snap.outcomeResults || {}).filter(v => v === true).length, 0);

        res.json({
            success: true,
            overview: {
                totalSnapshots: allDocs.length,
                resolvedSnapshots: resolved.length,
                pendingSnapshots: pending.length,
                totalPredictions,
                totalHits,
                overallHitRate: totalPredictions > 0 ? Math.round((totalHits / totalPredictions) * 100) : 0,
            },
            outcomeSummary,
            dateSummary,
            topPatterns,
        });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ performance error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
