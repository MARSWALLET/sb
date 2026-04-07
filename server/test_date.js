const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function buildLaunchOptions() {
    return {
        executablePath: '/usr/bin/google-chrome',
        headless: false,
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

async function runDateTest() {
    console.log("[1] Launching Chromium...");
    const browser = await puppeteer.launch(buildLaunchOptions());

    try {
        const page = await browser.newPage();
        
        console.log("[2] Navigating to SportyBet live results...");
        await page.goto('https://www.sportybet.com/ng/liveResult/', { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });

        console.log("[3] Waiting 3 seconds for React to mount...");
        await new Promise(r => setTimeout(r, 3000));
        
        // Find and click Football first
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
            console.log("    ✅ Clicked 'Football' category.");
            await new Promise(r => setTimeout(r, 2000));
        }

        // Wait to see if vdp-datepicker is in the DOM already, or we need to click outer selector
        console.log("[4] Searching for Vue Date Picker...");
        
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
            console.log("    --> Clicked Date dropdown/wrapper. Waiting for calendar to appear...");
            await new Promise(r => setTimeout(r, 1500));
            
            // Navigate dynamically backward until the calendar header shows March 2025
            const selectionResult = await page.evaluate(async () => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const calendar = document.querySelector('.vdp-datepicker__calendar');
                if (!calendar) return "Failed to find calendar.";
                
                let result = [];
                let attempts = 0;
                
                while (attempts < 24) { // Max 24 months backward
                    // Find the middle header span which displays the month/year
                    const headerSpans = Array.from(calendar.querySelectorAll('header span'));
                    const titleSpan = headerSpans.length >= 3 ? headerSpans[1] : headerSpans[0];
                    
                    if (titleSpan) {
                        const currentTitle = titleSpan.textContent.trim();
                        if (currentTitle.includes('Mar') && currentTitle.includes('2025')) {
                            result.push("Successfully reached: " + currentTitle);
                            break;
                        }
                    }
                    
                    // Click previous button
                    const prevBtn = calendar.querySelector('header .prev') || headerSpans[0];
                    if (prevBtn) {
                        prevBtn.click();
                        await sleep(400); // wait for Vue DOM animation
                    }
                    attempts++;
                }
                
                return result.join(" ");
            });
            console.log("    ✅ Month Navigation Result:", selectionResult);
            await new Promise(r => setTimeout(r, 1000)); // wait for month animation

            const daySelectionResult = await page.evaluate(() => {
                const cells = Array.from(document.querySelectorAll('.vdp-datepicker__calendar .cell.day:not(.disabled):not(.blank)'));
                
                if (cells.length > 0) {
                    // Try to find the exact cell that has text component '2' (for 02/03/2025)
                    const targetCell = cells.find(c => c.textContent.trim() === '2');
                    
                    if (targetCell) {
                        targetCell.click();
                        return "Clicked exact past day: 2 (02/03/2025)";
                    } else {
                        return "Could not find cell with text '2'. Found available cells: " + cells.map(c => c.textContent.trim()).join(', ');
                    }
                }
                return "Failed to find any selectable day cells.";
            });
            console.log("    ✅ Day Selection Result:", daySelectionResult);
            
            if (daySelectionResult.includes("Clicked")) {
                console.log("    --> Waiting 5 seconds for React to fetch and load past match data...");
                await new Promise(r => setTimeout(r, 5000));
            }
            
            // Now click vFootball to see what loads for that past date!
            console.log("[5] Selecting 'vFootball' explicitly...");
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

            // Now click Italy League
            console.log("[6] Selecting 'Italy League' inherently...");
            await page.evaluate(() => {
                const sportSelects = document.querySelectorAll('.m-select-list');
                // The THIRD dropdown is typically the Category selector
                if (sportSelects.length > 2) {
                     const selectIndex = sportSelects[2].querySelector('.select-index, .active');
                     if (selectIndex) selectIndex.click(); 
                } else {
                     // Try fallback specifically hunting for "Select Category"
                     const allSelectIndexes = Array.from(document.querySelectorAll('.select-index, .active'));
                     const cat = allSelectIndexes.find(el => el.textContent.trim().includes('Category'));
                     if(cat) cat.click();
                }
            });
            await new Promise(r => setTimeout(r, 1500));
            
            const categorySelectResult = await page.evaluate(() => {
                // Click Italy League
                const options = Array.from(document.querySelectorAll('.option .list a, .option .list li'));
                const italy = options.find(o => o.textContent.trim().includes('Italy'));
                if (italy) {
                    italy.click();
                    return "Clicked Italy via standard list!";
                } else {
                     // try deep text match directly
                     const rawEls = Array.from(document.querySelectorAll('span, li, a, div'));
                     const direct = rawEls.find(el => el.textContent.trim() === 'Italy League' && el.children.length === 0);
                     if(direct) {
                         direct.click();
                         return "Clicked Italy via raw text match!";
                     }
                }
                return "Failed to find Italy League.";
            });
            console.log("    ✅ Category Select Result:", categorySelectResult);
            await new Promise(r => setTimeout(r, 6000));
            
        } else {
            console.log("    ❌ Could not find the Date picker.");
        }

        const timedatenow = Date.now();
        const screenshotPath = path.join(__dirname, 'testdownloadpage', `screenshot_testdate_${timedatenow}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`    ✅ Screenshot saved to ${screenshotPath}`);

    } catch (error) {
        console.error("❌ Fatal Error:", error);
    } finally {
        console.log("[6] Done. Browser stays open.");
    }
}

runDateTest();
