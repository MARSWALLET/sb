const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// To run this: GEMINI_API_KEY=your_api_key node trial_vision_extractor.js
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function fileToGenerativePart(filepath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filepath)).toString("base64"),
      mimeType
    },
  };
}

async function extractTableFromImage() {
  if (!process.env.GEMINI_API_KEY) {
      console.error("\n❌ ERROR: GEMINI_API_KEY is missing from your environment.");
      console.log("👉 How to run: GEMINI_API_KEY=\"your_key_here\" node trial_vision_extractor.js");
      console.log("👉 Get a free API key instantly at: https://aistudio.google.com/app/apikey\n");
      return;
  }

  // We use Gemini 1.5 Flash as it's the fastest and best model for complex tabular vision OCR
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  
  // Dynamic path resolution
  const imagePath = path.join(__dirname, 'testdownloadpage', 'screenshot_testdate_1775514268389.png');
  
  if (!fs.existsSync(imagePath)) {
      console.error(`❌ Image not found at: ${imagePath}`);
      return;
  }

  const imagePart = fileToGenerativePart(imagePath, "image/png");

  const prompt = `
  You are an expert data extraction bot. 
  Extract the virtual football match results from this table image into a clean, structured JSON array.
  The image contains columns for Time/Date, Game ID, and Match Result.
  Notice that the Team names and Scores are formatted like "ARS 0:1 BOU".
  Return ONLY a valid JSON array and nothing else. Follow this exact structure:
  [
    {
      "time": "23:48",
      "date": "05/04/2026",
      "gameId": "32001",
      "homeTeam": "ARS",
      "awayTeam": "BOU",
      "homeScore": 0,
      "awayScore": 1
    }
  ]
  `;

  console.log(`\n[🚀] System processing image: ${path.basename(imagePath)}`);
  console.log(`[🧠] Sending to Google Gemini 1.5 Flash for Tabular Data OCR...`);

  try {
      const result = await model.generateContent([prompt, imagePart]);
      const responseText = result.response.text();
      
      // Cleanup any markdown code blocks returned by the LLM
      let jsonStr = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      const structuredData = JSON.parse(jsonStr);
      
      // Save it completely isolated from the current app flow
      const outputFile = path.join(__dirname, 'extracted_vfootball_images_data.json');
      fs.writeFileSync(outputFile, JSON.stringify(structuredData, null, 2));
      
      console.log(`[✅] Extraction Complete!`);
      console.log(`[💾] Saved ${structuredData.length} records to: ${outputFile}`);
      console.log(`\n--- PREVIEW OF ORGANIZED EXTRACTED DATA ---`);
      console.log(structuredData.slice(0, 3)); 
      if (structuredData.length > 3) {
          console.log(`... and ${structuredData.length - 3} more records successfully extracted.`);
      }

  } catch (error) {
      console.error("\n[❌] Error during extraction process. See details:");
      console.error(error.message);
  }
}

extractTableFromImage();
