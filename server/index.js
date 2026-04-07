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
const { startContinuousScraper, getHistoricalResults, getHistoryStoreInfo } = require('./scraper');
const { captureLeagueResults } = require('./screenshot_scraper');
const { uploadMatchesToFirebase } = require('./firebase_uploader');
const { fetchResultsFromFirebase, fetchTodayResultsFromFirebase, todayDDMMYYYY } = require('./firebase_reader');
const { saveAnalysis, getRecentContext, getLog, deleteEntry, getEntryById, clearLog } = require('./ai_memory');


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
// GET /   — Human Friendly Index / API Directory
// ─────────────────────────────────────────────────────────────────────────────
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
                            } else {
                                alert('Error capturing screenshot: ' + (data.error || 'Unknown error'));
                            }
                        } catch (err) {
                            console.error('[Firebase Index Debug/Error Details]: Network error:', err);
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
// Global live data cache (written every 5s by the continuous scraper)
// ─────────────────────────────────────────────────────────────────────────────
let globalData = null;

// Start the single long-lived Chrome window immediately on server boot
console.log('[DEBUG] [Server] Booting vFootball Terminal API...');
startContinuousScraper((newData) => {
    globalData = newData;
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
        console.error('[Firebase Index Debug/Error Details]: [/api/scores] Unexpected error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch live scores', details: error.message });
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
        console.error('[Firebase Index Debug/Error Details]: [/api/vfootball/history] Error:', error);
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
// GET /api/vfootball/screenshot-results
// Captures a screenshot of the requested league's results and runs OCR.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/vfootball/screenshot-results', async (req, res) => {
    try {
        const league = req.query.league || 'England League';
        const targetDate = req.query.date || null;
        console.log(`[DEBUG] [/api/vfootball/screenshot-results] Request for league: ${league}, targetDate: ${targetDate}`);
        
        // This process takes 5-15s because it drives a browser and runs Tesseract OCR
        const result = await captureLeagueResults(league, targetDate);

        if (!result.success) {
            return res.status(500).json(result);
        }

        res.json({
            success: true,
            league: result.league,
            base64Image: result.base64Image,
            rawText: result.rawText,
            matchData: result.matchData || [],
            screenshotPath: result.screenshotPath || null,
        });
    } catch (error) {
        console.error('[Firebase Index Debug/Error Details]: [/api/vfootball/screenshot-results] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/results
// Public endpoint — reads from Firebase Firestore using firebase_reader.
// Query params: ?page=1&pageSize=5&league=England+-+Virtual&dateFrom=...&dateTo=...
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/public/results', async (req, res) => {
    try {
        const { page = 1, pageSize = 5, league, dateFrom, dateTo } = req.query;
        console.log(`[DEBUG] [/api/public/results] query=`, req.query);

        const data = await fetchResultsFromFirebase({ league, dateFrom, dateTo, page: Number(page), pageSize: Number(pageSize) });
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('[Firebase Index Debug/Error Details]: [/api/public/results]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

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

        // Fetch matches from Firebase
        let matches = [];
        if (scope === 'today') {
            matches = await fetchTodayResultsFromFirebase(league);
        } else {
            // For a specific date or a range, we fetch the first 1000 items
            const result = await fetchResultsFromFirebase({ league, dateFrom, dateTo, page: 1, pageSize: 100 });
            matches = result.dates.flatMap(d => Object.values(d.leagues).flat());
        }

        if (!matches || matches.length === 0) return res.status(400).json({ success: false, error: 'No matches found in Firebase for this range.' });

        // Limit the context size to avoid blowing up token limit
        const analyzeMatches = matches.slice(0, 100);
        const matchSummary = analyzeMatches.map(m => `${m.date} | ${m.time} | ${m.homeTeam} ${m.score} ${m.awayTeam} (${m.league})`).join('\n');

        // Fetch past context from memory
        const memoryContext = getRecentContext(5);

        const prompt = `You are an expert virtual football (vFootball) analyst. Analyze the following match results and provide deep tactical and statistical insights.

Context: Analyzed Scope: ${scope} (${dateLabel})
Matches: ${analyzeMatches.length} recent games (from a total of ${matches.length} matching the filter).
${memoryContext}
Current Matches:
${matchSummary}

Provide a comprehensive analysis in valid JSON format with exactly these fields:
{
  "summary": "2-3 sentence executive summary of the day's results",
  "keyInsights": ["insight 1", "insight 2", "insight 3", "insight 4"],
  "topScorers": [{"team": "XXX", "goalsScored": 0, "goalsConceded": 0}],
  "goalDistribution": {"0-0": 0, "1-0 or 0-1": 0, "2-1 or 1-2": 0, "2+ goals each": 0, "3+ goal winners": 0},
  "winnerStats": {"homeWins": 0, "awayWins": 0, "draws": 0},
  "highestScoring": {"teams": "HOME vs AWAY", "score": "X:Y", "totalGoals": 0},
  "lowestScoring": {"teams": "HOME vs AWAY", "score": "X:Y"},
  "avgGoalsPerMatch": 0.0,
  "prediction": "Brief prediction/pattern note for next session based on trends. Use past MEMORY if relevant.",
  "dominantTeams": ["team1", "team2"],
  "formRating": {"label": "e.g. High-scoring day / Defensive session", "score": 7}
}

Return ONLY valid JSON. No markdown, no code blocks.`;

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
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('[Firebase Index Debug/Error Details]: [/api/analyze] DeepSeek error:', errText);
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

        // Save to AI memory
        saveAnalysis({ scope, dateLabel, dateFrom, dateTo, league, matchCount: analyzeMatches.length, analysis, tokensUsed });

        res.json({ success: true, analysis, tokensUsed });
    } catch (err) {
        console.error('[Firebase Index Debug/Error Details]: [/api/analyze]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai-memory
// Returns the entire AI memory log (used for admin / user display).
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/ai-memory', (req, res) => {
    try {
        const log = getLog();
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/ai-memory/:id
// Deletes a specific entry by ID, or pass ?clearAll=true to wipe the whole log.
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/ai-memory/:id', (req, res) => {
    try {
        if (req.query.clearAll === 'true') {
            clearLog();
            return res.json({ success: true, message: 'Log cleared perfectly' });
        }
        deleteEntry(req.params.id);
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
        console.error('[Firebase Index Debug/Error Details]: [/api/screenshot-preview]', err);
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
                    try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (_) {}
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
        console.error('[Firebase Index Debug/Error Details]: [/api/screenshots]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/extract-and-upload (Server-Sent Events)
//
// Accepts: { imagePath, leagueName } in query params or POST body
// Streams back real-time status messages as SSE events.
// Full pipeline: MD5 Check → Visual Hash Check → Gemini Extract → Upload to Firebase
// ─────────────────────────────────────────────────────────────────────────────

// --- Inline extractor state (mirrors gemini_extractor.js) ---
const PROCESSED_DB_PATH = path.join(__dirname, 'processed_images_hash.json');
const VISUAL_HASH_DB_PATH = path.join(__dirname, 'processed_visual_hashes.json');
const OUTPUT_DATA_PATH = path.join(__dirname, 'extracted_league_data.json');

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
        image.crop(0, Math.floor(h * 0.1), w, Math.floor(h * 0.4));
        return image.hash(2);
    } catch (e) { return null; }
}
async function isTopVisuallyDuplicate(hash) {
    if (!hash || !fs.existsSync(VISUAL_HASH_DB_PATH)) return false;
    const db = JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH));
    // Threshold: 0.00 = must be 100% identical. 
    // Small text differences (like new Match IDs) drop the similarity to ~98%.
    // Setting threshold to 0.05 was too aggressive and blocked legitimate new results.
    return db.some(stored => hammingDistance(hash, stored) <= 0.00);
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
        console.error('[Firebase Index Debug/Error Details]: [reset-visual-hashes]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync-local-to-firebase
// Pushes ALL records from extracted_league_data.json to Firebase.
// This is the recovery path for data that was extracted but never uploaded
// (e.g. due to past pipeline errors). Streams SSE progress back to the UI.
// Optional body: { leagueFilter: "Germany - Virtual" } to filter by league.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/sync-local-to-firebase', async (req, res) => {
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

        send(`📂 Found ${allData.length} records in local DB. Starting Firebase sync...`);
        const { uploaded, skipped } = await uploadMatchesToFirebase(allData, send);
        send(`✅ Sync complete! ${uploaded} documents written, ${skipped} skipped.`);
        done({ uploaded, skipped, total: allData.length });

    } catch (err) {
        console.error('[Firebase Index Debug/Error Details]: [sync-local-to-firebase]', err);
        fail(`Server error: ${err.message}`);
    }
});

app.post('/api/extract-and-upload', async (req, res) => {

    const { imagePath, leagueName, geminiApiKey, forceUpload } = req.body;
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
    console.log(`[DEBUG] [extract-and-upload] imagePath=${imagePath} league=${leagueName} force=${!!forceUpload}`);

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
        if (!imagePath || !leagueName) return fail('Missing imagePath or leagueName in request body.');
        if (!apiKey) return fail('GEMINI_API_KEY is missing. Pass it in the request or set it in .env');
        if (!fs.existsSync(imagePath)) return fail(`Image not found at: ${imagePath}`);

        send('init', `Target: ${path.basename(imagePath)} | League: ${leagueName}${forceUpload ? ' | ⚡ FORCE MODE — skipping hash checks' : ''}`);

        // ── Level 1: MD5 Check ────────────────────────────────────────────────
        // Always compute md5 so markImageProcessed(md5) can reference it at the end
        const md5 = getFileHash(imagePath);
        if (forceUpload) {
            send('md5', '⚡ Force Upload mode — MD5 check bypassed.');
        } else {
            send('md5', '🔍 Level 1: Checking MD5 file hash for exact duplicate...');
            if (isImageProcessed(md5)) {
                return done({ skipped: true, reason: '⏭️ Level 1 blocked: Exact same file was already extracted. 0 tokens used.', uploaded: 0, newRecords: 0 });
            }
            send('md5', '✅ Level 1 passed — new file fingerprint detected.');
        }

        // ── Level 1.5: Visual Hash Check ──────────────────────────────────────
        let visualHash = null;
        if (forceUpload) {
            send('visual', '⚡ Force Upload mode — Visual hash check bypassed.');
        } else {
            send('visual', '👁️ Level 1.5: Running offline perceptual image recognition (95% similarity threshold)...');
            visualHash = await getTopVisualHash(imagePath);
            if (await isTopVisuallyDuplicate(visualHash)) {
                return done({ skipped: true, reason: '⏭️ Level 1.5 blocked: Top match content is ≥95% visually identical to a previous sync. Use ⚡ Force Upload to override.', uploaded: 0, newRecords: 0 });
            }
            send('visual', '✅ Level 1.5 passed — visually distinct top content confirmed.');
        }

        // ── Gemini Vision Extraction ──────────────────────────────────────────
        send('gemini', '🧠 Sending to Gemini Vision AI for precision data extraction...');
        const genAI = new GoogleGenerativeAI(apiKey);
        const imagePart = { inlineData: { data: Buffer.from(fs.readFileSync(imagePath)).toString('base64'), mimeType: 'image/png' } };
        const prompt = `You are an expert data extraction bot. Extract virtual football match results from this table image into a clean JSON array.
        Columns: Time/Date, Game ID, Match Result (e.g. "ARS 0:1 BOU").
        CRITICAL: Set "league": "${leagueName}" on EVERY object.
        Return ONLY a valid JSON array:
        [{"time":"23:48","date":"05/04/2026","gameId":"32001","homeTeam":"ARS","awayTeam":"BOU","score":"0:1","league":"${leagueName}"}]`;

        const viableModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
        let result = null; let usedModel = '';
        let errors = [];
        for (const modelName of viableModels) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                
                let attempts = 0;
                while (attempts < 2) {
                    try {
                        result = await model.generateContent([prompt, imagePart]);
                        break;
                    } catch (e) {
                        if ((e.status === 429 || e.status === 503) && attempts < 1) {
                            send('gemini', `⏳ Gemini [${modelName}] hit quota/load (HTTP ${e.status}). Retrying in 3s...`);
                            await new Promise(r => setTimeout(r, 3000));
                            attempts++;
                        } else {
                            throw e;
                        }
                    }
                }
                
                usedModel = modelName;
                break;
            } catch (err) {
                console.warn(`[DEBUG] Gemini ${modelName} failed: ${err.message}`);
                let shortErr = err.message || "Unknown error";
                shortErr = shortErr.replace(/\[GoogleGenerativeAI Error\]: /, '')
                                   .replace(/Error fetching from https?:\/\/[^\s]+:\s*/, '')
                                   .trim()
                                   .substring(0, 100);
                errors.push(`${modelName}(${shortErr})`);
                
                // If this is the last model in the list, throw the aggregated errors
                if (modelName === viableModels[viableModels.length - 1]) {
                    throw new Error(`All models failed: ${errors.join(' | ')}`);
                }
            }
        }
        if (!result) return fail('All Gemini models returned 404/Error. Check your API key tier / region.');

        const raw = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        let extractedData;
        try { extractedData = JSON.parse(raw); }
        catch (e) { return fail(`Gemini returned invalid JSON. Raw response: ${raw.slice(0, 300)}...`); }

        send('gemini', `✅ Gemini [${usedModel}] extracted ${extractedData.length} match records.`);

        // ── Level 2: Game ID Deduplication ────────────────────────────────────
        send('dedup', '🔄 Level 2: Running Game ID deduplication against local database...');
        let allData = fs.existsSync(OUTPUT_DATA_PATH) ? JSON.parse(fs.readFileSync(OUTPUT_DATA_PATH)) : [];
        let newRecords = 0; let dupeCount = 0;
        extractedData.forEach(match => {
            const isDupe = allData.some(e => e.gameId === match.gameId && e.league === match.league);
            if (!isDupe) { allData.push(match); newRecords++; } else dupeCount++;
        });
        fs.writeFileSync(OUTPUT_DATA_PATH, JSON.stringify(allData, null, 2));
        markImageProcessed(md5);
        markVisualHashProcessed(visualHash);
        send('dedup', `✅ Dedup complete: ${newRecords} new records saved, ${dupeCount} duplicates discarded.`);

        if (newRecords === 0) {
            const localDbCount = allData.length;
            return done({
                skipped: false,
                reason: `⚠️ All ${dupeCount} extracted records already exist in local DB. Firebase upload skipped. Use "🔄 Sync Local DB → Firebase" below to push all ${localDbCount} local records to Firebase.`,
                uploaded: 0,
                newRecords: 0,
                localDbCount,
                canSyncLocalDb: true,
            });
        }

        // ── Firebase Upload ───────────────────────────────────────────────────
        send('firebase', `🔥 Uploading ${newRecords} new records to Firebase Firestore...`);
        const newMatchData = allData.slice(allData.length - newRecords);
        const { uploaded, skipped } = await uploadMatchesToFirebase(newMatchData, (msg) => send('firebase', msg));

        send('firebase', `✅ Firebase upload complete! ${uploaded} documents written, ${skipped} skipped.`);
        done({ skipped: false, uploaded, newRecords, dupeCount, model: usedModel });

    } catch (err) {
        console.error('[Firebase Index Debug/Error Details]: [/api/extract-and-upload]', err);
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
        console.error('[Firebase Index Debug/Error Details]: [DELETE /api/screenshots]', err);
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[DEBUG] [Server] Express API running on port ${PORT}`);
    console.log(`[DEBUG] [Server] Endpoints:`);
    console.log(`[DEBUG] [Server]   GET /api/scores               → live vFootball odds`);
    console.log(`[DEBUG] [Server]   GET /api/vfootball/history     → paginated completed results`);
    console.log(`[DEBUG] [Server]   GET /api/debug/history-store   → accumulator stats`);
});
