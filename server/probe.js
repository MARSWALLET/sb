const puppeteer = require('puppeteer-core');

(async () => {
    console.log('[PROBE] Launching browser...');
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        // Anti-bot bypass
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        // Setup API interception to catch the actual result URL
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('sportybet.com') && response.request().resourceType() === 'xhr') {
                if (url.includes('liveResult') || url.includes('game') || url.includes('result') || url.includes('match') || url.includes('virtual')) {
                    console.log('\n[NETWORK CAUGHT] API Request to:', url);
                    try {
                        const json = await response.json();
                        console.log('[NETWORK PREVIEW]', JSON.stringify(json).substring(0, 300));
                    } catch(e) {}
                }
            }
        });

        console.log('[PROBE] Navigating to https://www.sportybet.com/ng/liveResult/ ...');
        await page.goto('https://www.sportybet.com/ng/liveResult/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        console.log('[PROBE] Page loaded. Waiting 8s for Vue interface to mount completely...');
        await new Promise(r => setTimeout(r, 8000));
        
        // Take a picture of the initial state
        await page.screenshot({ path: '/tmp/sportybet_step1_initial.png' });
        
        // The dropdowns use class .m-select-list. 
        // Typically Date is index 0, Category is index 1 or 2.
        
        console.log('[PROBE] Changing DATE to Today...');
        await page.evaluate(async () => {
            const selects = document.querySelectorAll('.m-select-list');
            if (selects.length > 0) {
                // Click to open date dropdown
                selects[0].click();
            }
        });
        await new Promise(r => setTimeout(r, 2000)); // wait for animation
        
        await page.evaluate(async () => {
            // Find "Today" or the first date in the dropdown list
            const dateList = Array.from(document.querySelectorAll('ul.m-list li'));
            if (dateList.length > 0) {
                dateList[0].click(); // Normally index 0 is Today
            }
        });
        await new Promise(r => setTimeout(r, 3000));
        
        console.log('[PROBE] Changing CATEGORY to vFootball/Virtuals...');
        await page.evaluate(async () => {
            const selects = document.querySelectorAll('.m-select-list');
            if (selects.length > 1) {
                // Click to open category dropdown
                selects[1].click();
            }
        });
        await new Promise(r => setTimeout(r, 2000));
        
        await page.evaluate(async () => {
            const catList = Array.from(document.querySelectorAll('ul.m-list li'));
            // Search for vFootball or Virtuals
            const virtualTab = catList.find(li => li.innerText.toLowerCase().includes('virtual') || li.innerText.toLowerCase().includes('vfootball'));
            if (virtualTab) {
                virtualTab.click();
            }
        });
        
        console.log('[PROBE] Category selected. Waiting 6 seconds for results to fetch and render...');
        await new Promise(r => setTimeout(r, 6000));
        
        // Take a picture of the final state
        await page.screenshot({ path: '/tmp/sportybet_step2_final.png' });
        console.log('[PROBE] Screenshots saved. Extracting DOM...');
        
        const finalHtml = await page.evaluate(() => document.body.innerText);
        const matches = finalHtml.split('\\n').filter(line => line.includes(':')).slice(0, 15); // get some scores
        
        console.log('\n--- FINAL EXTRACTED TEXT FROM PAGE ---');
        console.log(matches.join('\n'));
        console.log('-------------------------------------\n');

    } catch (err) {
        console.error('[PROBE ERROR]', err);
    } finally {
        await browser.close();
        console.log('[PROBE] Done.');
    }
})();
