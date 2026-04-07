const { captureLeagueResults } = require('./screenshot_scraper');

async function test() {
   console.log("Testing screenshot scraper...");
   try {
       const res = await captureLeagueResults("England League");
       console.log("Result:", res.success, res.error);
       if (res.success) {
           console.log("Text snippet:", res.rawText.substring(0, 500));
       }
   } catch(e) {
       console.error("Uncaught error:", e);
   }
}

test();
