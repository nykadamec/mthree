/**
 * Groq Speech-to-Text + Translation
 * Usage: node groq_stt.mjs <audio_file> [target_lang]
 * Example: node groq_stt.mjs audio.mp3 czech
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadavg } = require('os');

// ── Config ──────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'your-groq-api-key-here';
const MODEL_STT = 'distil-whisper-large-v3-en';  // English-only STT
const MODEL_LLM = 'llama-4-scout-17b-16e-instruct';  // Groq's LLM for translation

// ── Helpers ──────────────────────────────────────────────────────────────────
function groqChat(messages, model = MODEL_LLM) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.3 });
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function groqAudio(filePath, model = MODEL_STT) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const footer = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(header), fileData, Buffer.from(footer)
    ]);

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: node groq_stt.mjs <audio_file> [target_lang]');
    console.log('Example: node groq_stt.mjs audio.mp3 czech');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  if (!GROQ_API_KEY || GROQ_API_KEY === 'your-groq-api-key-here') {
    console.error('Set GROQ_API_KEY environment variable first.');
    process.exit(1);
  }

  const targetLang = process.argv[3] || 'czech';
  console.log(`\n🎤 Transcribing: ${path.basename(filePath)}`);
  console.log(`   Model: ${MODEL_STT}\n`);

  // Step 1: Speech → English text
  let transcript;
  try {
    const result = await groqAudio(filePath);
    if (result.error) throw new Error(result.error.message);
    transcript = result.text;
    console.log(`📝 English transcript:\n${transcript}\n`);
  } catch (err) {
    console.error(`STT Error: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Translate to target language
  const langMap = {
    czech: 'Czech', english: 'English', german: 'German',
    french: 'French', spanish: 'Spanish', slovak: 'Slovak',
  };
  const langName = langMap[targetLang] || targetLang;

  console.log(`🌐 Translating to ${langName}...`);
  console.log(`   Model: ${MODEL_LLM}\n`);

  try {
    const result = await groqChat([
      {
        role: 'system',
        content: `You are an expert translator. Translate the following English text to ${langName}. Preserve the original meaning exactly. Only output the translation, nothing else. If the text is empty or meaningless, output "No content".`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ]);
    if (result.error) throw new Error(result.error.message);
    const translation = result.choices[0].message.content.trim();
    console.log(`✨ ${langName} translation:\n${translation}\n`);

    // Save to .txt
    const txtPath = filePath.replace(/\.[^.]+$/, `_${targetLang}.txt`);
    fs.writeFileSync(txtPath, translation, 'utf-8');
    console.log(`💾 Saved to: ${txtPath}`);
  } catch (err) {
    console.error(`Translation Error: ${err.message}`);
    process.exit(1);
  }
}

main();
