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
    // Clear out the previous profile to avoid bloating /tmp with orphaned data between crashes
    try {
        fs2.rmSync('/tmp/sportybet_scraper_profile', { recursive: true, force: true });
    } catch (e) {
        // ignore errors if it doesn't exist yet
    }

    return {
        executablePath: getChromePath(),
        headless: 'new',
        userDataDir: '/tmp/sportybet_scraper_profile',
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
const MAX_HISTORY_SLOTS = 2000;   // max individual match entries stored
const MATCHES_PER_PAGE = 20;     // matches returned per /history page

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

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: We no longer derive/fabricate scores from odds.
// The in-memory history store marks completions as "Pending Result".
// Real scores are ONLY sourced from the Screenshot → Gemini → Firebase pipeline.
// This prevents showing simulated data as if it were real match results.
// ─────────────────────────────────────────────────────────────────────────────
function deriveFinalScore(_match) {
    // Always return pending — do NOT fabricate scores from odds probabilities.
    // Real results arrive via the screenshot capture + Gemini extraction pipeline.
    return 'Pending Result';
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

        if (dateStr === today.toISOString().slice(0, 10)) return 'Today';
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
//
// Extraction cascade (tried in order, first with results wins):
//   A: [data-event-id] attributes  — most semantic, works on new DOM
//   B: .m-list container scan      — confirmed present by debug_live_page.js
//   C: [class*="match"] containers — original approach, still works on some layouts
//   D: body.innerText parser        — last resort text-based fallback
// ─────────────────────────────────────────────────────────────────────────────

// Module-scoped scraper controller — fixes the scoping bug in stopContinuousScraper
// where `browser` and `shouldRestart` were only defined inside startContinuousScraper
const _scraperCtrl = { browser: null, shouldStop: false };

async function startContinuousScraper(updateCallback) {
    _scraperCtrl.shouldStop = false;

    // ─── Outer restart loop — fully relaunches Chrome on fatal frame detach ────
    while (!_scraperCtrl.shouldStop) {
        console.log('[DEBUG] [Live Scraper] 🚀 Launching fresh Chrome instance...');

        let browser;
        let page;

        try {
            browser = await puppeteer.launch(buildLaunchOptions());
            _scraperCtrl.browser = browser;
            page = await browser.newPage();
            _livePage = page;
            _livePageUrl = 'https://www.sportybet.com/ng/sport/vFootball?betslipMode=real';

            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            );
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            console.log('[DEBUG] [Live Scraper] Navigating to vFootball live odds page...');
            await page.goto(_livePageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            console.log('[DEBUG] [Live Scraper] Navigation complete. Starting 5-second poll loop...');

        } catch (launchErr) {
            console.error('[Firebase Index Debug/Error Details]: [Live Scraper] Browser launch/nav failed:', launchErr.message);
            try { if (browser) await browser.close(); } catch (_) { }
            _scraperCtrl.browser = null;
            _livePage = null;
            console.log('[DEBUG] [Live Scraper] ⏳ Waiting 10s before retry...');
            await new Promise(r => setTimeout(r, 10000));
            continue; // retry the outer loop
        }

        // ─── Inner poll loop ────────────────────────────────────────────────
        let shouldRestart = false;
        while (!shouldRestart && !_scraperCtrl.shouldStop) {
            try {
                console.log('[DEBUG] [Live Scraper] Polling DOM for latest vFootball odds...');

                // ── APPROACH A: [data-event-id] attributes — most semantic ──────────
                // SportyBet sets data-event-id on match container divs in newer layouts
                const dataAttrMatches = await page.evaluate(() => {
                    const results = [];
                    const els = document.querySelectorAll('[data-event-id], [data-game-id]');
                    console.log('[DOM-EVAL A] data-event-id elements:', els.length);
                    els.forEach(el => {
                        const txt = el.innerText || '';
                        if (!txt || txt.length < 5) return;
                        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
                        // Extract time (HH:MM), teams and odds from text content
                        const timeMatch = txt.match(/(\d{2}:\d{2})/);
                        const time = timeMatch ? timeMatch[1] : '--:--';
                        const code = el.getAttribute('data-event-id') || el.getAttribute('data-game-id') || lines[0];
                        // Team names: find two consecutive non-numeric, non-odds lines
                        const teamLines = lines.filter(l => l.length > 1 && l.length < 40 && !/^\d+\.?\d*$/.test(l) && !/^\d{2}:\d{2}$/.test(l) && !l.startsWith('ID'));
                        const home = teamLines[0] || 'TBD';
                        const away = teamLines[1] || 'TBD';
                        const oddsLines = lines.filter(l => /^\d+\.\d+$/.test(l));
                        const [odd1 = '-', oddX = '-', odd2 = '-'] = oddsLines;
                        results.push({ time, code, home, away, score: `1(${odd1}) X(${oddX}) 2(${odd2})` });
                    });
                    return results;
                });
                console.log(`[DEBUG] [Live Scraper] Approach A (data-event-id): ${dataAttrMatches.length} matches`);

                // ── APPROACH B: .m-list containers (confirmed by debug_live_page.js) ──
                let mListMatches = [];
                if (dataAttrMatches.length === 0) {
                    mListMatches = await page.evaluate(() => {
                        const results = [];
                        // .m-list is the SportyBet generic sport event list
                        const containers = document.querySelectorAll('.m-list > li, .m-list .m-list-item, [class*="event-item"], [class*="sport-event"]');
                        console.log('[DOM-EVAL B] .m-list child elements:', containers.length);
                        containers.forEach(el => {
                            const txt = el.innerText || '';
                            if (!txt) return;
                            const idMatch = txt.match(/ID:\s*(\d+)/);
                            if (!idMatch) return;
                            const code = idMatch[1];
                            const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
                            const idIdx = lines.findIndex(l => l.startsWith('ID:'));
                            const timeMatch = txt.match(/(\d{2}:\d{2})/);
                            const time = timeMatch ? timeMatch[1] : '--:--';
                            const afterId = lines.slice(idIdx + 1).filter(l => l && l !== code);
                            const home = afterId[0] || 'TBD';
                            const away = afterId[1] || 'TBD';
                            const oddsLines = afterId.slice(2).filter(l => /^\d+\.\d+$/.test(l));
                            const [odd1 = '-', oddX = '-', odd2 = '-'] = oddsLines;
                            results.push({ time, code, home, away, score: `1(${odd1}) X(${oddX}) 2(${odd2})` });
                        });
                        return results;
                    });
                    console.log(`[DEBUG] [Live Scraper] Approach B (.m-list): ${mListMatches.length} matches`);
                }

                // ── APPROACH C: CSS Selector [class*="match"] — original approach ─────
                let domMatches = [];
                if (dataAttrMatches.length === 0 && mListMatches.length === 0) {
                    domMatches = await page.evaluate(() => {
                        const results = [];
                        const containers = document.querySelectorAll('[class*="match"]');
                        console.log('[DOM-EVAL C] [class*="match"] containers:', containers.length);
                        containers.forEach(el => {
                            const txt = el.innerText || '';
                            const idMatch = txt.match(/ID:\s*(\d+)/);
                            if (!idMatch) return;
                            const code = idMatch[1];
                            const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
                            const idIdx = lines.findIndex(l => l.startsWith('ID:'));
                            if (idIdx === -1) return;
                            const timeMatch = txt.match(/(\d{2}:\d{2})/);
                            const time = timeMatch ? timeMatch[1] : '--:--';
                            const afterId = lines.slice(idIdx + 1).filter(l => l && l !== code);
                            const home = afterId[0] || 'TBD';
                            const away = afterId[1] || 'TBD';
                            const oddsLines = afterId.slice(2).filter(l => /^\d+\.\d+$/.test(l));
                            const [odd1 = '-', oddX = '-', odd2 = '-'] = oddsLines;
                            results.push({ time, code, home, away, score: `1(${odd1}) X(${oddX}) 2(${odd2})` });
                        });
                        return results;
                    });
                    console.log(`[DEBUG] [Live Scraper] Approach C ([class*="match"]): ${domMatches.length} matches`);
                }

                // ── APPROACH D: body.innerText fallback ─────────────────────────────
                let textMatches = [];
                if (dataAttrMatches.length === 0 && mListMatches.length === 0 && domMatches.length === 0) {
                    console.log('[DEBUG] [Live Scraper] All DOM approaches empty — falling back to body.innerText parser...');
                    const pageContent = await page.evaluate(() => document.body.innerText);
                    const lines = pageContent.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i]?.trim() ?? '';
                        if (!line.startsWith('ID: ')) continue;
                        try {
                            const code = line.replace('ID: ', '').trim();
                            // Scan BACKWARDS past blank lines to find the time
                            let timeIdx = i - 1;
                            while (timeIdx >= 0 && !lines[timeIdx]?.trim()) timeIdx--;
                            const timeLine = lines[timeIdx]?.trim() ?? '';
                            const timeMatch = timeLine.match(/(\d{2}:\d{2})/);
                            const time = timeMatch ? timeMatch[1] : timeLine || '--:--';
                            // Skip blank lines AFTER the ID: line to find team names
                            let offset = 1;
                            while (i + offset < lines.length && !lines[i + offset]?.trim()) offset++;
                            const home = lines[i + offset]?.trim() || 'TBD';
                            const away = lines[i + offset + 1]?.trim() || 'TBD';
                            // Odds immediately follow team names
                            let oddStart = i + offset + 2;
                            const oddsFound = [];
                            while (oddsFound.length < 3 && oddStart < lines.length) {
                                const v = lines[oddStart]?.trim() ?? '';
                                if (/^\d+\.\d+$/.test(v)) oddsFound.push(v);
                                else if (v && !/^\d+$/.test(v) && oddsFound.length === 0) break;
                                oddStart++;
                            }
                            const [odd1 = '-', oddX = '-', odd2 = '-'] = oddsFound;
                            textMatches.push({ time, code, home, away, score: `1(${odd1}) X(${oddX}) 2(${odd2})` });
                        } catch (parseErr) {
                            console.warn('[DEBUG] [Live Scraper] Row parse skipped:', parseErr.message);
                        }
                    }
                    console.log(`[DEBUG] [Live Scraper] Approach D (body.innerText): ${textMatches.length} matches`);
                }

                // ── Use whichever approach yielded results and DEDUPLICATE ──────────
                const rawMatches = dataAttrMatches.length > 0 ? dataAttrMatches
                    : mListMatches.length > 0 ? mListMatches
                    : domMatches.length > 0 ? domMatches
                    : textMatches;

                // De-duplicate matches by code
                const uniqueMatchesMap = new Map();
                for (const m of rawMatches) {
                    if (!uniqueMatchesMap.has(m.code)) uniqueMatchesMap.set(m.code, m);
                }
                const allMatches = Array.from(uniqueMatchesMap.values());
                console.log(`[DEBUG] [Live Scraper] ✅ Raw: ${rawMatches.length} | Unique: ${allMatches.length}`);

                // ── Detect league from DOM ─────────────────────────────────────────
                const results = [];
                let leagueName = 'vFootball Live Odds';
                try {
                    const domLeague = await page.evaluate(() => {
                        const candidates = [
                            document.querySelector('[class*="category-name"]'),
                            document.querySelector('[class*="league-name"]'),
                            document.querySelector('[class*="sport-name"]'),
                            document.querySelector('[class*="header"] [class*="title"]'),
                        ];
                        for (const el of candidates) {
                            const t = el?.textContent?.trim();
                            if (t && t.length > 2 && t.length < 60) return t;
                        }
                        const title = document.title || '';
                        if (title.includes('England')) return 'England - Virtual';
                        if (title.includes('Italy'))   return 'Italy - Virtual';
                        if (title.includes('Spain'))   return 'Spain - Virtual';
                        if (title.includes('Germany')) return 'Germany - Virtual';
                        if (title.includes('France'))  return 'France - Virtual';
                        return null;
                    });
                    if (domLeague) leagueName = domLeague;
                } catch (leagueErr) {
                    console.warn('[DEBUG] [Live Scraper] League detection failed, using default:', leagueErr.message);
                }

                results.push({ league: leagueName, matches: allMatches });
                console.log(`[DEBUG] [Live Scraper] League: "${leagueName}" | Matches: ${allMatches.length}`);

                // Push live data to frontend & history store
                updateCallback(results);
                if (allMatches.length > 0) addMatchesToHistory(allMatches);

            } catch (pollErr) {
                console.error('[Firebase Index Debug/Error Details]: [Live Scraper] Poll error:', pollErr.message);

                // Detect permanent browser/frame death — trigger full browser restart
                const isFatalError =
                    pollErr.message.includes('detached Frame') ||
                    pollErr.message.includes('Execution context was destroyed') ||
                    pollErr.message.includes('Target closed') ||
                    pollErr.message.includes('Session closed') ||
                    pollErr.message.includes('Protocol error');

                if (isFatalError) {
                    console.log('[DEBUG] [Live Scraper] ☠️ Fatal browser error. Restarting Chrome in 5s...');
                    try { await browser.close(); } catch (_) { }
                    _scraperCtrl.browser = null;
                    _livePage = null;
                    await new Promise(r => setTimeout(r, 5000));
                    shouldRestart = true;
                    break;
                }
            }

            await new Promise(r => setTimeout(r, 5000));
        }
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

// ── Cleanup Helper ───────────────────────────────────────────────────────────
async function stopContinuousScraper() {
    _scraperCtrl.shouldStop = true;
    if (_scraperCtrl.browser) {
        console.log('[DEBUG] [Live Scraper] 🛑 Shutting down browser instance...');
        try { await _scraperCtrl.browser.close(); } catch (_) { }
        _scraperCtrl.browser = null;
    }
    _livePage = null;
    console.log('[DEBUG] [Live Scraper] 🛑 Scraper stopped.');
}

async function reloadContinuousScraper() {
    console.log('[DEBUG] [Live Scraper] 🔄 Manual reload triggered from UI. Closing browser to force restart...');
    if (_scraperCtrl.browser) {
        try { await _scraperCtrl.browser.close(); } catch (_) {}
        // The error caused by closing the browser will naturally be caught by the inner poll loop
        // as a 'Target closed' or 'Session closed' error, triggering a clean automatic restart.
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPE LIVE LIST ON DEMAND
// Scrapes the mobile live list to find matches currently playing, which are the 
// immediate next fixtures that pattern intelligence should predict.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeLiveListOnDemand() {
    if (!_scraperCtrl.browser) {
        console.warn('[Live Scraper OnDemand] No browser instance available.');
        return [];
    }
    
    let page;
    try {
        console.log('[Live Scraper OnDemand] Opening new page for live_list...');
        page = await _scraperCtrl.browser.newPage();
        await page.goto('https://www.sportybet.com/ng/m/sport/vFootball/live_list', { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        const content = await page.evaluate(() => document.body.innerText);
        const lines = content.split('\n');
        const grouped = {};
        
        let currentLeague = 'vFootball Live';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim() ?? '';
            
            // Try to detect league headers
            if (line.includes('England - Virtual')) currentLeague = 'England - Virtual';
            if (line.includes('Spain - Virtual')) currentLeague = 'Spain - Virtual';
            if (line.includes('Italy - Virtual')) currentLeague = 'Italy - Virtual';
            if (line.includes('Germany - Virtual')) currentLeague = 'Germany - Virtual';
            if (line.includes('France - Virtual')) currentLeague = 'France - Virtual';

            if (line.startsWith('ID ')) {
                const code = line.replace('ID ', '').trim();
                const time = lines[i - 1]?.trim() || '--:--';
                const league = lines[i + 1]?.trim() || currentLeague;
                const home = lines[i + 2]?.trim() || 'TBD';
                const away = lines[i + 3]?.trim() || 'TBD';
                const odd1 = lines[i + 4]?.trim() || '-';
                const oddX = lines[i + 5]?.trim() || '-';
                const odd2 = lines[i + 6]?.trim() || '-';
                
                if (!grouped[league]) grouped[league] = [];
                grouped[league].push({ time, code, home, away, score: `1(${odd1}) X(${oddX}) 2(${odd2})` });
            }
        }
        
        const results = Object.keys(grouped).map(league => ({ league, matches: grouped[league] }));
        console.log(`[Live Scraper OnDemand] Successfully scraped ${results.reduce((acc, curr) => acc + curr.matches.length, 0)} live matches across ${results.length} leagues.`);
        return results;
        
    } catch (err) {
        console.error('[Live Scraper OnDemand] Error scraping live_list:', err.message);
        return [];
    } finally {
        if (page) {
            try { await page.close(); } catch (_) {}
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    startContinuousScraper,
    stopContinuousScraper,
    reloadContinuousScraper,
    getHistoricalResults,
    getLivePage,
    getLivePageUrl,
    scrapeLiveListOnDemand,
    // Expose store info for debug endpoint
    getHistoryStoreInfo: () => ({
        totalEntries: historyStore.length,
        trackedCodes: matchFirstSeen.size,
        oldestEntry: historyStore[historyStore.length - 1]?.capturedAt ?? null,
        newestEntry: historyStore[0]?.capturedAt ?? null,
    }),
};
