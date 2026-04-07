const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function buildLaunchOptions() {
    return {
        executablePath: '/usr/bin/google-chrome',
        headless: false, // We set this to false so you can visually confirm
        args: [
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1366,768',
        ],
    };
}

async function testVFootballScraper() {
    console.log("[1/5] 🚀 Initializing Puppeteer cluster...");
    console.log("      --> Launching Chromium in non-headless mode so you can see it.");
    
    const browser = await puppeteer.launch(buildLaunchOptions());

    try {
        const page = await browser.newPage();
        
        console.log("[2/5] 🌐 Navigating to SportyBet live results...");
        await page.goto('https://www.sportybet.com/ng/liveResult/', { 
            waitUntil: 'networkidle2', // Wait until network is fully quiet
            timeout: 60000 
        });

        console.log("[3/5] 🔍 Looking for the Football sport dropdown...");
        // Wait an extra bit for React/Vue components to render fully
        await new Promise(r => setTimeout(r, 3000));
        
        let clicked = false;

        // Use evaluate to find and click instead of deprecated page.$x
        const clickedFootball = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span, div'));
            const fb = spans.find(el => el.textContent.trim() === 'Football' && el.children.length === 0);
            if (fb) {
                fb.click();
                return true;
            }
            return false;
        });
        
        if (clickedFootball) {
            console.log("      --> Found Football dropdown. Clicking...");
            
            // Wait for dropdown animation to open
            await new Promise(r => setTimeout(r, 1000));
            
            console.log("      --> Looking for 'vFootball' option...");
            // Now click the vFootball text
            const clickedVFootball = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('span, div, li, a'));
                const vfb = els.find(el => el.textContent.trim() === 'vFootball' && el.children.length === 0);
                if (vfb) {
                    vfb.click();
                    return true;
                }
                return false;
            });

            if (clickedVFootball) {
                console.log("      --> Successfully clicked 'vFootball'!");
                clicked = true;
            } else {
                console.error("      --> ERROR: Found dropdown but could not find 'vFootball' option.");
            }
        } else {
             console.error("      --> ERROR: Could not find the initial 'Football' dropdown element.");
        }

        if (!clicked) {
            console.log("      --> Attempting fallback: looking for native <select> element just in case...");
            try {
                // Sometimes mobile view or basic view uses a select element
                const val = await page.evaluate(() => {
                    const selects = Array.from(document.querySelectorAll('select'));
                    for (let s of selects) {
                        for (let opt of Array.from(s.options)) {
                            if (opt.text.includes('vFootball')) return { val: opt.value, sel: s };
                        }
                    }
                    return null;
                });
                if (val) {
                    await page.select('select', val.val);
                    console.log("      --> Selected via native dropdown!");
                    clicked = true;
                }
            } catch (err) {
                 console.log("      --> Fallback also failed.", err.message);
            }
        }

        if (clicked) {
            console.log("[4/5] ⏳ Waiting 5 seconds for historical vFootball results to load from their API...");
            await new Promise(r => setTimeout(r, 5000));

            console.log("[5/5] 📄 Extracting HTML and saving the page...");
            const resultsHTML = await page.evaluate(() => {
                const resultsTable = document.querySelector('.m-table');
                if (resultsTable) {
                    return resultsTable.innerHTML;
                }
                return "[WARNING] Could not find '.m-table'.";
            });

            const fullHTML = await page.content();

            // Ensure the download directory exists
            const downloadPath = path.join(__dirname, 'testdownloadpage');
            if (!fs.existsSync(downloadPath)) {
                fs.mkdirSync(downloadPath, { recursive: true });
            }

            const timedatenow = Date.now();

            // Save the extracted results HTML
            fs.writeFileSync(path.join(downloadPath, `results_${timedatenow}.html`), resultsHTML);
            console.log(`      --> Saved extracted results to testdownloadpage/results_${timedatenow}.html`);

            // Save the full page HTML
            fs.writeFileSync(path.join(downloadPath, `full_page_${timedatenow}.html`), fullHTML);
            console.log(`      --> Saved full page to testdownloadpage/full_page_${timedatenow}.html`);

            // Optionally take a screenshot using the exact process on test_vfootball
            await page.screenshot({ path: path.join(downloadPath, `screenshot_${timedatenow}.png`), fullPage: true });
            console.log(`      --> Saved page screenshot to testdownloadpage/screenshot_${timedatenow}.png`);
            
            console.log("\n✅ Test completed successfully and files downloaded!");
        }

    } catch (error) {
        console.error("\n[Firebase Index Debug/Error Details]: ❌ FATAL ERROR during scraping:", error);
    } finally {
        console.log("\n⚠️ Browser is kept open for your verification. You can close it manually, or press CTRL+C to terminate the script.");
        // Intentionally NOT calling browser.close() so you can visually verify the screen
        // await browser.close();
    }
}

testVFootballScraper();
