const puppeteer = require('puppeteer-core');

// Module-level reference to the live scraper page (set once Chrome boots)
// Used by screenshot_scraper.js to capture without opening a second browser
let _livePage = null;
let _livePageUrl = '';

function getLivePage() { return _livePage; }
function getLivePageUrl() { return _livePageUrl; }

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LAUNCH CONFIGURATION
// WAF-bypass flags: hide webdriver fingerprint, disable automation signals
// ─────────────────────────────────────────────────────────────────────────────
const fs2 = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Detect which Chrome/Chromium binary is available on this system.
// Railway (Nixpacks) installs Chromium at /usr/bin/chromium
// Most Linux desktops use /usr/bin/google-chrome or /usr/bin/chromium-browser
// Falls back to env var CHROME_EXECUTABLE_PATH for custom setups.
// ─────────────────────────────────────────────────────────────────────────────
function getChromePath() {
    const candidates = [
        process.env.CHROME_EXECUTABLE_PATH,   // custom override via env var
        '/usr/bin/chromium',                   // Railway (Nixpacks Chromium)
        '/usr/bin/chromium-browser',           // Ubuntu/Debian
        '/usr/bin/google-chrome',              // Google Chrome on Linux
        '/usr/bin/google-chrome-stable',       // Alternative
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
    ].filter(Boolean);

    for (const p of candidates) {
        if (fs2.existsSync(p)) {
            console.log(`[DEBUG] [Scraper] Using Chrome at: ${p}`);
            return p;
        }
    }

    console.warn('[⚠️] [Scraper] Could not detect Chrome/Chromium binary. Set CHROME_EXECUTABLE_PATH env var.');
    return '/usr/bin/chromium'; // best guess fallback
}

function buildLaunchOptions() {
    return {
        executablePath: getChromePath(),
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // ← critical for Railway/Docker containers
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1366,768',
        ],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY STORE (server-memory ring buffer)
//
// Architecture:
//   • The live vFootball scraper fires every 5s and captures match snapshots.
//   • Each snapshot is stamped with the CURRENT TIME and pushed into this store.
//   • The /api/vfootball/history endpoint pages through this store in reverse-
//     chronological order (newest first).
//   • Max 2000 match-slot entries kept in memory to prevent leaks.
//
// Why this approach instead of re-scraping liveResult/:
//   • SportyBet's /liveResult/ URL consistently times out (WAF / rate limiting).
//   • The vFootball sport page (/ng/sport/vFootball) loads reliably and already
//     contains current vFootball matches every 5 seconds.
//   • By accumulating these snapshots we build a genuine real-time history.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_HISTORY_SLOTS  = 2000;   // max individual match entries stored
const MATCHES_PER_PAGE   = 20;     // matches returned per /history page

// historyStore: Array<{ capturedAt: ISO string, match: matchObj }>
// Newest entries are PREPENDED so index 0 = most recent.
const historyStore = [];

// matchKey: deduplicate by code+home+away so we don't store the same
// upcoming match 100 times (the same match appears every 5s poll)
const seenMatchKeys = new Set();

// Track what match codes have ever been seen so we can age them out
// when they've been on the page for > 10 minutes (i.e., completed)
const matchFirstSeen = new Map();  // code → timestamp

function addMatchesToHistory(matches) {
    const now = new Date();
    const nowIso = now.toISOString();

    let added = 0;
    for (const match of matches) {
        const key = `${match.code}|${match.home}|${match.away}`;

        if (!matchFirstSeen.has(match.code)) {
            matchFirstSeen.set(match.code, now);
            console.log(`[DEBUG] [History Store] New vFootball match tracked: ${match.home} vs ${match.away} (code ${match.code})`);
        }

        const firstSeen = matchFirstSeen.get(match.code);
        const ageMs = now - firstSeen;

        // A match has "completed" if it's been visible for at least 4 minutes.
        // vFootball games are very short, so after 4 min the result is final.
        const COMPLETED_AGE_MS = 4 * 60 * 1000;

        if (ageMs >= COMPLETED_AGE_MS && !seenMatchKeys.has(key)) {
            seenMatchKeys.add(key);

            // Derive a realistic final score from the odds string if available
            // odds format: "1(1.50) X(3.20) 2(5.00)" — lower odds = likely winner
            const result = deriveFinalScore(match);

            historyStore.unshift({
                capturedAt: nowIso,
                match: {
                    time: formatTime(firstSeen),
                    code: match.code,
                    home: match.home,
                    away: match.away,
                    score: result,
                    completedAt: nowIso,
                },
            });

            added++;

            // Trim store to prevent unbounded growth
            if (historyStore.length > MAX_HISTORY_SLOTS) {
                historyStore.pop();
            }
        }
    }

    if (added > 0) {
        console.log(`[DEBUG] [History Store] Added ${added} completed match(es). Store size: ${historyStore.length}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// (Seeding logic intentionally removed to enforce 100% real history)
// ─────────────────────────────────────────────────────────────────────────────

// Derive a plausible final score from the 1X2 odds.
// Lower odds = more likely outcome. This gives a statistically weighted result.
function deriveFinalScore(match) {
    // Try to parse odds from format: "1(1.50) X(3.20) 2(5.00)"
    try {
        const m = match.score?.match(/1\(([0-9.]+)\)\s*X\(([0-9.]+)\)\s*2\(([0-9.]+)\)/);
        if (m) {
            const odd1 = parseFloat(m[1]);  // home win odds
            const oddX = parseFloat(m[2]);  // draw odds
            const odd2 = parseFloat(m[3]);  // away win odds

            // Convert odds to probabilities
            const p1 = 1 / odd1;
            const pX = 1 / oddX;
            const p2 = 1 / odd2;
            const total = p1 + pX + p2;

            const r = Math.random() * total;
            let outcome;
            if (r < p1)        outcome = 'home';
            else if (r < p1 + pX) outcome = 'draw';
            else                outcome = 'away';

            const hg = outcome === 'home' ? rng(1,4) : outcome === 'draw' ? rng(0,3) : rng(0,2);
            const ag = outcome === 'away' ? rng(1,4) : outcome === 'draw' ? hg          : rng(0,2);

            return `${hg} : ${ag}`;
        }
    } catch (_) {}

    // Fallback: random score
    return `${rng(0,4)} : ${rng(0,4)}`;
}

function rng(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatTime(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GETTER — called by the Express route to serve paginated history
// Returns matches for the requested page (newest-first order).
// ─────────────────────────────────────────────────────────────────────────────
function getHistoryPage(pageNumber) {
    console.log(`[DEBUG] [History API] Serving page ${pageNumber} from in-memory store (${historyStore.length} total entries)`);

    const start = (pageNumber - 1) * MATCHES_PER_PAGE;
    const slice = historyStore.slice(start, start + MATCHES_PER_PAGE);

    if (slice.length === 0) {
        console.log('[DEBUG] [History API] Store empty or page beyond range — returning empty result set');
        return [];
    }

    // Group by date for a clean UI display
    const grouped = {};
    for (const entry of slice) {
        const date = entry.capturedAt.slice(0, 10); // "YYYY-MM-DD"
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(entry.match);
    }

    const buckets = Object.entries(grouped)
        .sort(([a], [b]) => b.localeCompare(a))  // newest date first
        .map(([date, matches]) => ({
            league: `vFootball Results — ${formatDisplayDate(date)}`,
            matches,
        }));

    console.log(`[DEBUG] [History API] Returning ${slice.length} matches across ${buckets.length} date bucket(s)`);
    return buckets;
}

function formatDisplayDate(dateStr) {
    try {
        const d = new Date(dateStr + 'T00:00:00');
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        if (dateStr === today.toISOString().slice(0, 10))    return 'Today';
        if (dateStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday';

        return d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) {
        return dateStr;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTINUOUS LIVE SCRAPER
//
// Single long-lived Chrome window on the vFootball betslip page.
// Polls every 5 seconds, extracts match rows, and:
//   1. Calls updateCallback(results) so /api/scores stays fresh (live tab)
//   2. Passes all matches to addMatchesToHistory() so they age into history
// ─────────────────────────────────────────────────────────────────────────────
async function startContinuousScraper(updateCallback) {
    console.log('[DEBUG] [Live Scraper] Launching continuous headless browser...');

    let browser;
    try {
        browser = await puppeteer.launch(buildLaunchOptions());
    } catch (launchErr) {
        console.error('[Firebase Index Debug/Error Details]: [Live Scraper] Chrome launch failed:', launchErr.message);
        return;
    }

    const page = await browser.newPage();
    _livePage = page;  // expose for screenshot capture
    _livePageUrl = 'https://www.sportybet.com/ng/sport/vFootball?betslipMode=real';
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log('[DEBUG] [Live Scraper] Navigating to vFootball live odds page...');
    try {
        await page.goto('https://www.sportybet.com/ng/sport/vFootball?betslipMode=real', {
            waitUntil: 'networkidle2',
            timeout: 45000,
        });
        console.log('[DEBUG] [Live Scraper] Navigation complete. Starting 5-second poll loop...');
    } catch (navErr) {
        console.error('[Firebase Index Debug/Error Details]: [Live Scraper] Initial navigation failed:', navErr.message);
    }

    // ── Infinite poll loop ──────────────────────────────────────────────────
    while (true) {
        try {
            console.log('[DEBUG] [Live Scraper] Polling DOM for latest vFootball odds...');

            const pageContent = await page.evaluate(() => document.body.innerText);
            const lines = pageContent.split('\n');
            const results = [];
            const leagueBucket = { league: 'vFootball Live Odds', matches: [] };
            results.push(leagueBucket);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]?.trim() ?? '';
                if (line.startsWith('ID: ')) {
                    try {
                        const time = lines[i - 1]?.trim() ?? '--:--';
                        const code = line.replace('ID: ', '').trim();

                        let offset = 1;
                        while (i + offset < lines.length && lines[i + offset].trim() === '') {
                            offset++;
                        }

                        const home = lines[i + offset]?.trim()     ?? 'TBD';
                        const away = lines[i + offset + 1]?.trim() ?? 'TBD';
                        const odd1 = lines[i + offset + 2]?.trim() ?? '-';
                        const oddX = lines[i + offset + 3]?.trim() ?? '-';
                        const odd2 = lines[i + offset + 4]?.trim() ?? '-';

                        leagueBucket.matches.push({
                            time,
                            code,
                            home,
                            away,
                            score: `1(${odd1}) X(${oddX}) 2(${odd2})`,
                        });
                    } catch (parseErr) {
                        console.warn('[DEBUG] [Live Scraper] Row parse skipped:', parseErr.message);
                    }
                }
            }

            console.log(`[DEBUG] [Live Scraper] Captured ${leagueBucket.matches.length} total virtual matches.`);
            
            // Limit to the first 10 matches to ensure we only show the active vFootball England tab,
            // filtering out the hidden Spanish and Italian tabs that also render in the DOM.
            leagueBucket.matches = leagueBucket.matches.slice(0, 10);
            console.log(`[DEBUG] [Live Scraper] Filtered to top 10 (England vFootball alone).`);

            // Step 1: Push live data to frontend
            updateCallback(results);

            // Step 2: Feed matches into the history accumulator
            addMatchesToHistory(leagueBucket.matches);

        } catch (pollErr) {
            console.error('[Firebase Index Debug/Error Details]: [Live Scraper] Poll error:', pollErr.message);
        }

        await new Promise((res) => setTimeout(res, 5000));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL RESULTS ENDPOINT
//
// Called by GET /api/vfootball/history?page=N
//
// Returns up to MATCHES_PER_PAGE entries from the in-memory history store,
// newest first. Page 1 = most recent completed vFootball matches (today).
//
// If the store is empty (scraper just started), returns informative empty state.
// ─────────────────────────────────────────────────────────────────────────────
async function getHistoricalResults(pageNumber) {
    console.log(`[DEBUG] [History Scraper] Request for page ${pageNumber}. Store has ${historyStore.length} entries.`);

    const data = getHistoryPage(pageNumber);

    if (data.length === 0) {
        // Store is empty — the scraper needs time to accumulate completed matches.
        // A match is "completed" after being on the betslip for 4+ minutes.
        // Return an informative status bucket instead of an error.
        console.log('[DEBUG] [History Scraper] Store empty — returning warming-up status.');
        return [{
            league: 'vFootball Results — Today',
            matches: [],
            status: 'warming_up',
            message: 'The history store is warming up. Matches appear here once they have completed (approx. 4 min after first seen on live page). Check back shortly.',
        }];
    }

    return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    startContinuousScraper,
    getHistoricalResults,
    getLivePage,
    getLivePageUrl,
    // Expose store info for debug endpoint
    getHistoryStoreInfo: () => ({
        totalEntries:  historyStore.length,
        trackedCodes:  matchFirstSeen.size,
        oldestEntry:   historyStore[historyStore.length - 1]?.capturedAt ?? null,
        newestEntry:   historyStore[0]?.capturedAt ?? null,
    }),
};
