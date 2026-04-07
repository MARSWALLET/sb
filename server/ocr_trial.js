const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

async function runTrial() {
  const imagePath = path.join(__dirname, 'testdownloadpage', 'screenshot_testdate_1775514268389.png');
  console.log(`Analyzing image: ${imagePath}...`);
  
  try {
    const { data: { text } } = await Tesseract.recognize(
      imagePath,
      'eng',
      { logger: m => console.log(m) }
    );
    
    console.log('--- OCR RAW TEXT ---');
    console.log(text);
    
    fs.writeFileSync('ocr_output.txt', text);
    console.log('Saved raw output to ocr_output.txt');
  } catch (error) {
    console.error('OCR Error:', error);
  }
}

runTrial();
