/**
 * debug_live_list.js
 * Run with: node debug_live_list.js
 * Scrapes the SportyBet vFootball live_list and writes the full result to live_list_dump.json
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'live_list_dump.json');

function getChromePath() {
    const candidates = [
        process.env.CHROME_EXECUTABLE_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return '/usr/bin/chromium';
}

async function main() {
    console.log('[Debug] 🚀 Launching browser...');
    const browser = await puppeteer.launch({
        executablePath: getChromePath(),
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1366,768'],
    });

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');

        const url = 'https://www.sportybet.com/ng/m/sport/vFootball/live_list';
        console.log(`[Debug] 🌐 Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Wait a moment for content to load
        await new Promise(r => setTimeout(r, 2000));

        const rawText = await page.evaluate(() => document.body.innerText);
        const lines = rawText.split('\n');

        console.log(`[Debug] 📄 Page text extracted — ${lines.length} lines total.`);
        console.log('[Debug] === FIRST 60 LINES PREVIEW ===');
        lines.slice(0, 60).forEach((l, i) => console.log(`  ${i + 1}: ${l}`));
        console.log('[Debug] === END PREVIEW ===\n');

        // Parse into grouped structure (same logic as scraper.js scrapeLiveListOnDemand)
        const grouped = {};
        let currentLeague = 'vFootball Live';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim() ?? '';

            if (line.includes('England - Virtual')) currentLeague = 'England - Virtual';
            if (line.includes('Spain - Virtual'))   currentLeague = 'Spain - Virtual';
            if (line.includes('Italy - Virtual'))   currentLeague = 'Italy - Virtual';
            if (line.includes('Germany - Virtual')) currentLeague = 'Germany - Virtual';
            if (line.includes('France - Virtual'))  currentLeague = 'France - Virtual';

            if (line.startsWith('ID ')) {
                const code = line.replace('ID ', '').trim();
                const time  = lines[i - 1]?.trim() || '--:--';
                const league = lines[i + 1]?.trim() || currentLeague;
                const home   = lines[i + 2]?.trim() || 'TBD';
                const away   = lines[i + 3]?.trim() || 'TBD';
                const odd1   = lines[i + 4]?.trim() || '-';
                const oddX   = lines[i + 5]?.trim() || '-';
                const odd2   = lines[i + 6]?.trim() || '-';

                if (!grouped[league]) grouped[league] = [];
                grouped[league].push({ time, code, home, away, odds: `1(${odd1}) X(${oddX}) 2(${odd2})` });
            }
        }

        const results = Object.keys(grouped).map(league => ({ league, matches: grouped[league] }));

        const totalMatches = results.reduce((acc, g) => acc + g.matches.length, 0);
        console.log(`[Debug] ✅ Parsed ${results.length} league group(s), ${totalMatches} total match(es).`);
        results.forEach(g => {
            console.log(`\n  📂 League: "${g.league}" — ${g.matches.length} match(es)`);
            g.matches.forEach((m, idx) => {
                console.log(`    [${idx + 1}] ${m.time} | ${m.home} vs ${m.away} | Code: ${m.code} | ${m.odds}`);
            });
        });

        // Write full dump to file
        const dump = {
            capturedAt: new Date().toISOString(),
            url,
            rawLineCount: lines.length,
            rawPreview: lines.slice(0, 100), // first 100 lines for reference
            parsed: results,
        };

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dump, null, 2));
        console.log(`\n[Debug] 💾 Full dump saved to: ${OUTPUT_FILE}`);

    } catch (err) {
        console.error('[Debug] ❌ Error:', err.message);
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
        console.log('[Debug] 🔒 Browser closed.');
    }
}

main();
