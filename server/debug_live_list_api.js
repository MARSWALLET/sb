/**
 * debug_live_list_api.js
 * Calls the running server's API to check the live list via the existing scraper instance.
 * Run with: node debug_live_list_api.js [port]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = process.argv[2] || process.env.PORT || 3001;
const OUTPUT_FILE = path.join(__dirname, 'live_list_dump.json');

async function main() {
    console.log(`[Debug] 🌐 Calling server on port ${PORT}...`);

    try {
        // 1. Check live scores (globalData) from the running scraper
        const scoresRes = await fetch(`http://localhost:${PORT}/api/scores`);
        const scoresJson = await scoresRes.json();
        console.log(`[Debug] /api/scores — success: ${scoresJson.success}, groups: ${scoresJson.data?.length || 0}`);
        scoresJson.data?.forEach(g => {
            console.log(`  📂 "${g.league}" — ${g.matches?.length || 0} match(es)`);
            g.matches?.forEach((m, i) => console.log(`    [${i+1}] ${m.time} | ${m.home} vs ${m.away} | Code: ${m.code}`));
        });

        // 2. Trigger and check the AI upcoming analysis which internally calls scrapeLiveListOnDemand
        console.log('\n[Debug] 🤖 Calling /api/pattern-intel/upcoming-ai-analysis to trigger live list scrape...');
        const aiRes = await fetch(`http://localhost:${PORT}/api/pattern-intel/upcoming-ai-analysis`);
        const aiJson = await aiRes.json();
        console.log(`[Debug] AI Upcoming — success: ${aiJson.success}`);
        if (aiJson.message) console.log(`[Debug] Message: ${aiJson.message}`);
        if (aiJson.analyses?.length) {
            console.log(`[Debug] Analyses returned: ${aiJson.analyses.length}`);
            aiJson.analyses.forEach((a, i) => {
                console.log(`  [${i+1}] ${a.match} | ${a.time} | ${a.league} | Signal: ${a.signal}`);
            });
        }

        // Save dump
        const dump = {
            capturedAt: new Date().toISOString(),
            port: PORT,
            scores: scoresJson,
            aiUpcoming: aiJson,
        };
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dump, null, 2));
        console.log(`\n[Debug] 💾 Full dump saved to: ${OUTPUT_FILE}`);

    } catch (err) {
        console.error('[Debug] ❌ Error:', err.message);
        console.error('[Debug] Is the server running on port', PORT, '?');
    }
}

main();
