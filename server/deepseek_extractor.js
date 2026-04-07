require('dotenv').config();
const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Initialize Deepseek AI using the OpenAI client
// Note: Official Deepseek API does not currently have native Vision (image input). 
// Therefore, we use local Tesseract OCR to read text, and Deepseek AI to flawlessly organize it into JSON.
const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

// System Paths
const PROCESSED_DB_PATH = path.join(__dirname, 'processed_images_hash.json');
const OUTPUT_DATA_PATH = path.join(__dirname, 'extracted_league_data.json');

// --- HASH LOGIC (Zero AI Tokens Wasted) ---
// We create an MD5 hash of the image file. If the hash exists in our DB, we completely skip the process.
function getFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('md5');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

function isImageProcessed(hash) {
    if (!fs.existsSync(PROCESSED_DB_PATH)) return false;
    const db = JSON.parse(fs.readFileSync(PROCESSED_DB_PATH));
    return db.includes(hash);
}

function markImageProcessed(hash) {
    let db = [];
    if (fs.existsSync(PROCESSED_DB_PATH)) {
        db = JSON.parse(fs.readFileSync(PROCESSED_DB_PATH));
    }
    if (!db.includes(hash)) {
        db.push(hash);
        fs.writeFileSync(PROCESSED_DB_PATH, JSON.stringify(db, null, 2));
    }
}

// --- IMAGE PRE-PROCESSING ---
// Tesseract struggles with white text on dark background (score badges). We use Jimp to invert & enhance contrast.
async function preprocessImageForOCR(imagePath) {
    const image = await Jimp.read(imagePath);
    // Invert colors to make white text black, helping Tesseract read the scores accurately
    image.invert().greyscale().contrast(0.6); 
    const tempPath = path.join(__dirname, `temp_ocr_${Date.now()}.png`);
    await image.writeAsync(tempPath);
    return tempPath;
}

// --- CORE EXTRACTION PROCESS ---
async function processScreenshot(imagePath, leagueName) {
    if (!process.env.DEEPSEEK_API_KEY) {
        console.error("\n❌ ERROR: DEEPSEEK_API_KEY is missing from your environment.");
        console.log("👉 How to run: DEEPSEEK_API_KEY=\"your_key\" node deepseek_extractor.js \"England - Virtual\"\n");
        return;
    }

    if (!fs.existsSync(imagePath)) {
        console.error(`❌ Image not found at: ${imagePath}`);
        return;
    }

    const hash = getFileHash(imagePath);

    // AI TOKEN OPTIMIZATION: Check Hash DB before doing any heavy lifting
    if (isImageProcessed(hash)) {
        console.log(`[⏭️] Skipping image: ${path.basename(imagePath)} - Hash matches a previously extracted image.`);
        console.log(`[💰] 0 Deepseek Tokens Consumed.`);
        return; 
    }

    console.log(`\n[🚀] New Target Identified: ${path.basename(imagePath)}`);
    console.log(`[🏆] Assigned League Database Value: ${leagueName}\n`);
    
    // Step 1: Preprocess Image
    console.log(`[1/3] 🖼️  Preprocessing image via Jimp (inverting colors to fix score readability)...`);
    const tempImagePath = await preprocessImageForOCR(imagePath);

    // Step 2: Run Local OCR
    console.log(`[2/3] 📖  Running Tesseract.js (Local OCR) to extract raw text...`);
    const { data: { text } } = await Tesseract.recognize(tempImagePath, 'eng', { logger: () => {} });
    
    // Delete temp file to keep system clean
    if (fs.existsSync(tempImagePath)) fs.unlinkSync(tempImagePath);

    // Step 3: Deepseek Text Structuring
    console.log(`[3/3] 🧠  Sending raw OCR text to Deepseek AI for perfect Database JSON structuring...`);
    
    const prompt = `
    You are an expert data organizer. I have extracted raw OCR text from a SportyBet virtual football results table. 
    It is messy. Extract the match results into a clean JSON array. 
    
    CRITICAL: The target league is specifically: "${leagueName}". 
    You MUST inject the property "league": "${leagueName}" perfectly into EVERY single match object in the array.
    
    The columns in the raw text represent: Time, Game ID, and Match Result (Home Team, Score, Away Team). 
    Extract an array of JSON objects exactly matching this structure for every row you find:
    [
      {
        "time": "23:48",
        "gameId": "32001",
        "homeTeam": "ARS",
        "awayTeam": "BOU",
        "score": "0:1",
        "league": "${leagueName}"
      }
    ]

    Raw OCR Text data to parse:
    ===
    ${text}
    ===

    Return ONLY a valid JSON array. Never return markdown blocks (\`\`\`json) or conversational text.
    `;

    try {
        const response = await deepseek.chat.completions.create({
            model: "deepseek-chat", // Deepseek's flagship text model
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1 // Using low temperature for strict data formatting
        });

        const rawResult = response.choices[0].message.content.trim();
        let jsonStr = rawResult.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        let extractedData = {};
        try {
            extractedData = JSON.parse(jsonStr);
        } catch (jsonErr) {
            console.error("[❌] Deepseek returned invalid JSON format.");
            console.log(rawResult);
            return;
        }

        // Step 4: Save to Final Output File
        let allData = [];
        if (fs.existsSync(OUTPUT_DATA_PATH)) {
            allData = JSON.parse(fs.readFileSync(OUTPUT_DATA_PATH));
        }
        allData = allData.concat(extractedData);
        fs.writeFileSync(OUTPUT_DATA_PATH, JSON.stringify(allData, null, 2));

        // Step 5: Mark Image as Processed (Protects AI tokens next time)
        markImageProcessed(hash);
        
        console.log(`\n[✅] SUCCESS! Extracted and organized ${extractedData.length} match records.`);
        console.log(`[💾] Data safely appended to ./server/${path.basename(OUTPUT_DATA_PATH)}`);
        console.log(`[🔒] Database locked. Image hash recorded in ./server/${path.basename(PROCESSED_DB_PATH)}`);

    } catch (error) {
        console.error("\n[❌] Failed during AI processing:", error.message);
    }
}

// Ensure the user inputs the league dynamically
const defaultImage = path.join(__dirname, 'testdownloadpage', 'screenshot_testdate_1775514268389.png');
const leagueNameArg = process.argv[2] || "England - Virtual";

processScreenshot(defaultImage, leagueNameArg);
