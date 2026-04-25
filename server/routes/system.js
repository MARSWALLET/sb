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

router.get('/api/health', (req, res) => {
    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins  = Math.floor((uptimeSec % 3600) / 60);
    const secs  = uptimeSec % 60;
    const uptimeStr = `${hours}h ${mins}m ${secs}s`;

    const scraperActive = globals.globalData !== null && Array.isArray(globals.globalData) && globals.globalData.length > 0;
    const matchCount = scraperActive
        ? globals.globalData.reduce((acc, g) => acc + (g.matches?.length || 0), 0)
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
            liveLeagues: globals.globalData ? globals.globalData.map(g => g.league) : [],
            liveMatches: matchCount,
        },
        timestamp: new Date().toISOString(),
    });
});

router.get('/api/scraper-diag', async (req, res) => {
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

router.get('/api/ai-status-stream', (req, res) => {
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

router.get('/api/live-stream', (req, res) => {
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
    if (globals.globalData !== null) {
        const initial = { data: globals.globalData, status: 'live', timestamp: Date.now() };
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

router.get('/', (req, res) => {
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

router.get('/api/scores', (req, res) => {
    try {
        if (!globals.globalData) {
            console.log('[DEBUG] [/api/scores] Data not ready yet — scraper still initialising');
            return res.json({ success: true, data: [], status: 'initializing' });
        }
        console.log(`[DEBUG] [/api/scores] Serving cached data with ${globals.globalData[0]?.matches?.length ?? 0} matches`);
        res.json({ success: true, cached: true, data: globals.globalData });
    } catch (error) {
        console.error('[Database Index Debug/Error Details]: [/api/scores] Unexpected error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch live scores', details: error.message });
    }
});

    return router;
};
