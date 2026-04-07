// ─────────────────────────────────────────────────────────────────────────────
// screenshot_scraper.js
//
// Based on the exact working approach from test_vfootball.js.
// Uses headless: false (own browser, system network stack)
// Navigates to liveResult/ → Football → vFootball → league tab
// Screenshots the .m-table and parses its HTML for match rows.
// ─────────────────────────────────────────────────────────────────────────────

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { getLivePage, getLivePageUrl } = require('./scraper');

// Re-use the same Chrome auto-detection from scraper.js
function getChromePath() {
    const candidates = [
        process.env.CHROME_EXECUTABLE_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return '/usr/bin/chromium';
}

function buildLaunchOptions() {
    return {
        executablePath: getChromePath(),
        headless: true, // use headless on Railway (no display server)
        args: [
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1366,768',
        ],
    };
}

// Maps league name to the text that appears in the league tab buttons on liveResult/
const LEAGUE_TAB_TEXT = {
    'England League': 'England',
    'Spain League':   'Spain',
    'Italy League':   'Italy',
    'Germany League': 'Germany',
    'France League':  'France',
};

// Maps dashboard league name → clean database league name (stored in every match record)
const DB_LEAGUE_MAP = {
    'England League': 'England - Virtual',
    'Spain League':   'Spain - Virtual',
    'Italy League':   'Italy - Virtual',
    'Germany League': 'Germany - Virtual',
    'France League':  'France - Virtual',
};

async function captureLeagueResults(leagueName, targetDate = null) {
    console.log(`[Screenshot Service] [1/6] 🚀 Starting capture for: ${leagueName}`);
    console.log(`[Screenshot Service]       Using exact test_vfootball.js approach (headless: false)`);

    const browser = await puppeteer.launch(buildLaunchOptions());

    try {
        const page = await browser.newPage();

        // ── Step 2: Navigate to liveResult/ (exactly like test_vfootball.js) ──
        console.log(`[Screenshot Service] [2/6] 🌐 Navigating to SportyBet live results...`);
        await page.goto('https://www.sportybet.com/ng/liveResult/', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // ── Step 3: Parse Optional Date Target ─────────────────────
        let tDateStr = null;
        let tDayNum = null;
        if (targetDate) {
            const d = new Date(targetDate);
            if (!isNaN(d.getTime())) {
                const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                tDateStr = `${shortMonths[d.getMonth()]} ${d.getFullYear()}`;
                tDayNum = d.getDate().toString();
            }
        }

        console.log(`[Screenshot Service] [3/6] 🔍 Handling Date Selection: ${tDateStr ? tDateStr + ' Day ' + tDayNum : 'Default/Today'}...`);
        await new Promise(r => setTimeout(r, 3000)); // wait for React to mount

        if (tDateStr && tDayNum) {
            const clickedPicker = await page.evaluate(() => {
                const firstSelectList = document.querySelector('.m-select-list');
                if (firstSelectList) {
                    const selectIndex = firstSelectList.querySelector('.select-index');
                    if (selectIndex) {
                        selectIndex.click();
                        return true;
                    }
                }
                return false;
            });
            
            if (clickedPicker) {
                await new Promise(r => setTimeout(r, 1500));
                await page.evaluate(async (targetMonth, targetDayNum) => {
                    const sleep = ms => new Promise(r => setTimeout(r, ms));
                    const calendar = document.querySelector('.vdp-datepicker__calendar');
                    if (!calendar) return;
                    
                    let attempts = 0;
                    while (attempts < 24) {
                        const headerSpans = Array.from(calendar.querySelectorAll('header span'));
                        const titleSpan = headerSpans.length >= 3 ? headerSpans[1] : headerSpans[0];
                        if (titleSpan && titleSpan.textContent.trim().includes(targetMonth)) break;
                        
                        const prevBtn = calendar.querySelector('header .prev') || headerSpans[0];
                        if (prevBtn) {
                            prevBtn.click();
                            await sleep(400);
                        }
                        attempts++;
                    }
                    await sleep(800);
                    const cells = Array.from(document.querySelectorAll('.vdp-datepicker__calendar .cell.day:not(.disabled):not(.blank)'));
                    const cell = cells.find(c => c.textContent.trim() === targetDayNum);
                    if (cell) cell.click();
                }, tDateStr, tDayNum);
                
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        // ── Step 4: Find and click vFootball ─────────────────────
        console.log(`[Screenshot Service] [4/6] 📱 Finding and clicking vFootball...`);
        await page.evaluate(() => {
            const sportSelects = document.querySelectorAll('.m-select-list');
            // The SECOND dropdown is typically the Sport selector
            if (sportSelects.length > 1) {
                const selectIndex = sportSelects[1].querySelector('.select-index, .active');
                if (selectIndex) selectIndex.click(); 
            }
        });
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate(() => {
            const options = Array.from(document.querySelectorAll('.option .list a, .option .list li, span'));
            const vfb = options.find(o => o.textContent.trim() === 'vFootball');
            if (vfb) vfb.click();
        });
        await new Promise(r => setTimeout(r, 5000));

        // ── Step 5: Click Category (League) ─────────────────────
        const leagueTabText = LEAGUE_TAB_TEXT[leagueName] || leagueName.replace(' League', '');
        console.log(`[Screenshot Service] [5/6] 🏆 Clicking Category dropdown for "${leagueTabText}"...`);
        
        await page.evaluate(() => {
            const sportSelects = document.querySelectorAll('.m-select-list');
            // The THIRD dropdown is typically the Category selector
            if (sportSelects.length > 2) {
                 const selectIndex = sportSelects[2].querySelector('.select-index, .active');
                 if (selectIndex) selectIndex.click(); 
            } else {
                 const allSelectIndexes = Array.from(document.querySelectorAll('.select-index, .active'));
                 const cat = allSelectIndexes.find(el => el.textContent.trim().includes('Category'));
                 if(cat) cat.click();
            }
        });
        await new Promise(r => setTimeout(r, 1500));
        
        await page.evaluate((tabText) => {
            const options = Array.from(document.querySelectorAll('.option .list a, .option .list li'));
            const target = options.find(o => o.textContent.trim().includes(tabText));
            if (target) {
                target.click();
            } else {
                 const rawEls = Array.from(document.querySelectorAll('span, li, a, div'));
                 const direct = rawEls.find(el => el.textContent.trim() === tabText && el.children.length === 0);
                 if(direct) direct.click();
            }
        }, leagueTabText);
        await new Promise(r => setTimeout(r, 6000));
        // ── Step 6: Screenshot full browser page (like test_vfootball) ──────────
        console.log(`[Screenshot Service] [6/6] 📸 Screenshotting full page and extracting data...`);

        const downloadPath = path.join(__dirname, 'testdownloadpage'); // using same folder as test_vfootball
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
        }

        const timedatenow = Date.now();
        const screenshotPath = path.join(downloadPath, `screenshot_${timedatenow}.png`);
        const metaPath = path.join(downloadPath, `screenshot_${timedatenow}.meta.json`);

        // Exact same process as test_vfootball to generate screenshot
        console.log(`[Screenshot Service]      --> Saving full page screenshot to ${screenshotPath}`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // ── Write companion metadata file (allows auto league detection everywhere)
        const meta = {
            league: leagueName,
            dbLeague: DB_LEAGUE_MAP[leagueName] || leagueName,
            capturedAt: timedatenow,
            capturedAtISO: new Date(timedatenow).toISOString(),
            date: targetDate || null,
            filename: `screenshot_${timedatenow}.png`,
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        console.log(`[Screenshot Service]      --> Metadata saved: league="${meta.dbLeague}"`);

        // Read the saved file to serve as base64 in the API response
        let imageBuffer = fs.readFileSync(screenshotPath);
        console.log(`[Screenshot Service] ✅ Got full page screenshot`);

        // Parse match rows from the .m-table HTML (the table the test script confirmed works)
        const matchData = await page.evaluate(() => {
            const table = document.querySelector('.m-table');
            if (!table) return [];

            const rows = Array.from(table.querySelectorAll('tr, [class*="row"], [class*="item"]'));
            const results = [];

            for (const row of rows) {
                const cells = Array.from(row.querySelectorAll('td, [class*="cell"], span, div'))
                    .map(c => c.textContent.trim())
                    .filter(t => t.length > 0);

                if (cells.length >= 3) {
                    // Try to detect home vs away pattern (e.g. "ARS 2-1 CHE")
                    const rowText = cells.join(' ');
                    const scoreMatch = rowText.match(/([A-Z]{2,5})\s+(\d+[-:]\d+)\s+([A-Z]{2,5})/);
                    if (scoreMatch) {
                        results.push({
                            time: cells[0] || '--',
                            home: scoreMatch[1],
                            away: scoreMatch[3],
                            odds: scoreMatch[2],
                        });
                    } else if (cells.length >= 2) {
                        results.push({
                            time: cells[0] || '--',
                            home: cells[1] || 'TBD',
                            away: cells[2] || 'TBD',
                            odds: cells[3] || '-',
                        });
                    }
                }
            }
            return results;
        });

        await browser.close();

        console.log(`[Screenshot Service] ✅ Done! ${matchData.length} rows extracted for ${leagueName}`);

        const rawText = matchData.map(m => `${m.time}  ${m.home} vs ${m.away}  ${m.odds}`).join('\n');

        return {
            success: true,
            league: leagueName,
            dbLeague: meta.dbLeague,
            screenshotPath: screenshotPath,
            base64Image: `data:image/png;base64,${imageBuffer.toString('base64')}`,
            rawText: rawText || 'Results table captured — see screenshot.',
            matchData,
        };

    } catch (err) {
        console.error(`[Firebase Index Debug/Error Details]: [Screenshot Service] ❌ Fatal error:`, err.message);
        try { await browser.close(); } catch (_) {}
        return { success: false, error: err.message };
    }
}

module.exports = { captureLeagueResults };
