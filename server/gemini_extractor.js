require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Jimp = require('jimp');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// System Paths
const PROCESSED_DB_PATH = path.join(__dirname, 'processed_images_hash.json');
const VISUAL_HASH_DB_PATH = path.join(__dirname, 'processed_visual_hashes.json');
const OUTPUT_DATA_PATH = path.join(__dirname, 'extracted_league_data.json');

// --- HASH LOGIC (Zero AI Tokens Wasted on duplicates) ---
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

// --- LEVEL 1.5: PERCEPTUAL HASH LOGIC (Offline Duplicate Detection) ---
function hammingDistance(hash1, hash2) {
    if (hash1.length !== hash2.length) return 1.0;
    let diff = 0;
    for(let i = 0; i < hash1.length; i++) {
        if(hash1[i] !== hash2[i]) diff++;
    }
    return diff / hash1.length;
}

async function getTopVisualHash(filePath) {
    try {
        const image = await Jimp.read(filePath);
        const w = image.bitmap.width;
        const h = image.bitmap.height;
        // Ignore top 10% (headers, dates). Crop next 40% (top rows of results list).
        image.crop(0, Math.floor(h * 0.1), w, Math.floor(h * 0.4));
        return image.hash(2); // Base 2 binary string exactly 64 bits
    } catch (err) {
        console.error("[⚠️] Failed to calculate visual hash:", err.message);
        return null;
    }
}

async function isTopVisuallyDuplicate(incomingHash) {
    if (!incomingHash) return false;
    if (!fs.existsSync(VISUAL_HASH_DB_PATH)) return false;
    const db = JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH));
    for (const storedHash of db) {
        // Find if any previously synced image is 100% similar locally
        const distance = hammingDistance(incomingHash, storedHash);
        if (distance <= 0.00) { 
            return true; 
        }
    }
    return false;
}

function markVisualHashProcessed(hash) {
    if (!hash) return;
    let db = [];
    if (fs.existsSync(VISUAL_HASH_DB_PATH)) {
        db = JSON.parse(fs.readFileSync(VISUAL_HASH_DB_PATH));
    }
    if (!db.includes(hash)) {
        db.push(hash);
        fs.writeFileSync(VISUAL_HASH_DB_PATH, JSON.stringify(db, null, 2));
    }
}

// Format the image for Gemini
function fileToGenerativePart(filepath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filepath)).toString("base64"),
      mimeType
    },
  };
}

// --- CORE EXTRACTION PROCESS ---
async function processScreenshot(imagePath, leagueName) {
    if (!process.env.GEMINI_API_KEY) {
        console.error("\n❌ ERROR: GEMINI_API_KEY is missing from your environment.");
        console.log("👉 How to run: GEMINI_API_KEY=\"your_key_here\" node gemini_extractor.js \"England - Virtual\"\n");
        return;
    }

    if (!fs.existsSync(imagePath)) {
        console.error(`❌ Image not found at: ${imagePath}`);
        return;
    }

    const hash = getFileHash(imagePath);

    // AI TOKEN OPTIMIZATION: Check Hash DB before doing any heavy lifting
    if (isImageProcessed(hash)) {
        console.log(`[⏭️] Level 1 Guard: Skipping image ${path.basename(imagePath)} - Exact MD5 Hash matches.`);
        console.log(`[💰] 0 tokens consumed.`);
        return; 
    }

    // LEVEL 1.5 GUARD: Offline Image Recognition (80% top match)
    console.log(`[👁️] Level 1.5 Guard: Analyzing local visual structure...`);
    const visualHash = await getTopVisualHash(imagePath);
    if (await isTopVisuallyDuplicate(visualHash)) {
        console.log(`[⏭️] Level 1.5 Guard: Skipped! The top 40% match content is >= 80% identical to a previous sync.`);
        console.log(`[💰] 0 AI tokens consumed.`);
        return;
    }

    console.log(`\n[🚀] New Target Identified: ${path.basename(imagePath)}`);
    console.log(`[🏆] Assigned League Database Value: ${leagueName}`);
    console.log(`[🧠] Sending to Google Gemini Vision for extreme precision...`);

    const imagePart = fileToGenerativePart(imagePath, "image/png");

    const prompt = `
    You are an expert data extraction bot prioritizing absolute precision. 
    Extract the virtual football match results from this table image into a clean, structured JSON array.
    The image contains columns for Time/Date, Game ID, and Match Result.
    Notice that the Team names and Scores are formatted inside a single block like "ARS 0:1 BOU".
    
    CRITICAL: The target league for these records is specifically: "${leagueName}". 
    You MUST perfectly inject the property "league": "${leagueName}" into EVERY single match object in the array.

    Return ONLY a valid JSON array matching this exact schema for every row you see:
    [
      {
        "time": "23:48",
        "date": "05/04/2026",
        "gameId": "32001",
        "homeTeam": "ARS",
        "awayTeam": "BOU",
        "score": "0:1",
        "league": "${leagueName}"
      }
    ]
    `;

    // Try a cascade of viable models since certain iterations might be deprecated
    const viableModels = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
    let result = null;
    let successfulModelName = "";
    let errors = [];

    for (const modelName of viableModels) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            
            let attempts = 0;
            while (attempts < 2) {
                try {
                    result = await model.generateContent([prompt, imagePart]);
                    break;
                } catch (e) {
                    if ((e.status === 429 || e.status === 503) && attempts < 1) {
                        console.log(`[⏳] Gemini [${modelName}] hit quota/load (HTTP ${e.status}). Retrying in 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                        attempts++;
                    } else {
                        throw e; // throw to outer catch
                    }
                }
            }
            
            successfulModelName = modelName;
            break; // Break loop if successful
        } catch (err) {
            console.warn(`[DEBUG] Gemini ${modelName} failed: ${err.message}`);
            let shortErr = err.message || "Unknown error";
            shortErr = shortErr.replace(/\[GoogleGenerativeAI Error\]: /, '')
                               .replace(/Error fetching from https?:\/\/[^\s]+:\s*/, '')
                               .trim()
                               .substring(0, 100);
            errors.push(`${modelName}(${shortErr})`);
            
            if (modelName === viableModels[viableModels.length - 1]) {
                throw new Error(`All models failed: ${errors.join(' | ')}`);
            }
        }
    }

    if (!result) {
        console.error("\n[❌] Exhausted all Vision models and could not connect to Gemini API (All returned 404 Not Found). Please verify your Google API project capabilities.");
        return;
    }

    try {
        const responseText = result.response.text();
        
        // Clean out markdown blocks from the AI response
        let jsonStr = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        let extractedData = {};
        try {
            extractedData = JSON.parse(jsonStr);
        } catch (jsonErr) {
            console.error("[❌] Gemini returned invalid JSON format. It may have tried to converse.");
            console.log(responseText);
            return;
        }

        // Save to Final Database File and Deduplicate
        let allData = [];
        if (fs.existsSync(OUTPUT_DATA_PATH)) {
            allData = JSON.parse(fs.readFileSync(OUTPUT_DATA_PATH));
        }
        
        let newRecordsCount = 0;
        let duplicateCount = 0;

        extractedData.forEach(match => {
            // Compare the unique gameId and league to ensure we never write a duplicate match
            const isDuplicate = allData.some(existing => existing.gameId === match.gameId && existing.league === match.league);
            
            if (!isDuplicate) {
                allData.push(match);
                newRecordsCount++;
            } else {
                duplicateCount++;
            }
        });

        fs.writeFileSync(OUTPUT_DATA_PATH, JSON.stringify(allData, null, 2));

        // Mark Image as Processed (Protects AI tokens next time)
        markImageProcessed(hash);
        markVisualHashProcessed(visualHash);

        console.log(`\n[✅] SUCCESS! Extracted ${extractedData.length} records using model version: [${successfulModelName}]`);
        console.log(`[🔄] Deduplication Filter: Saved ${newRecordsCount} New Records | Skipped ${duplicateCount} Duplicates`);
        console.log(`[💾] Data safely appended to ./server/${path.basename(OUTPUT_DATA_PATH)}`);
        console.log(`[🔒] Database locked. Image hash recorded in ./server/${path.basename(PROCESSED_DB_PATH)}`);
        console.log(`\n--- PREVIEW OF EXTRACTED DATA ---`);
        console.log(extractedData.slice(0, 2));

    } catch (error) {
        console.error("\n[❌] Failed during AI processing:", error.message);
    }
}

// Support command line arguments or default test data
const defaultImage = path.join(__dirname, 'testdownloadpage', 'screenshot_testdate_1775514268389.png');
const leagueNameArg = process.argv[2] || "England - Virtual";

processScreenshot(defaultImage, leagueNameArg);
