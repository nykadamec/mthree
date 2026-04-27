require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { randomUUID } = require('crypto');

const app = express();
const PORT = 7766;
const DOWNLOAD_DIR = path.join(__dirname, '..', 'download');
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, `jobs_${new Date().toISOString().slice(0,10)}.log`);
const jobLog = (msg) => {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  console.error(`[JOB] ${msg}`);
};

jobLog('=== MThree Server Start ===');
jobLog(`DOWNLOAD_DIR: ${DOWNLOAD_DIR}`);
jobLog(`GROQ_API_KEY: ${GROQ_API_KEY ? 'set' : 'MISSING'}`);

const jobs = new Map();
let currentJobId = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(CLIENT_DIR, 'dist')));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// ─── Helpers ─────────────────────────────────────────────────────────────────
function checkFFmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const mi = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getFileSize(filepath) {
  try { return formatFileSize(fs.statSync(filepath).size); } catch { return null; }
}

function getFileMtime(filepath) {
  try { return fs.statSync(filepath).mtime.toISOString(); } catch { return null; }
}

function extname(filepath) {
  const base = path.basename(filepath);
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

function basename(filepath) {
  return path.basename(filepath);
}

function groqChat(messages, model = 'llama-4-scout-17b-16e-instruct') {
  return new Promise((resolve, reject) => {
    if (!GROQ_API_KEY) { reject(new Error('GROQ_API_KEY not set')); return; }
    const body = JSON.stringify({ model, messages, temperature: 0.3 });
    const options = {
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// VTT timestamp helpers
function parseVttTime(vttTime) {
  const [h, m, s] = vttTime.split(':');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
}

function formatVttTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(6,'0')}`;
}

function verboseJsonToVtt(verboseJson, chunkOffset = 0) {
  let cueNum = 1;
  let vtt = '';
  for (const seg of verboseJson.segments || []) {
    const start = formatVttTime(seg.start + chunkOffset);
    const end = formatVttTime(seg.end + chunkOffset);
    vtt += `${cueNum}\n${start} --> ${end}\n${seg.text.trim()}\n\n`;
    cueNum++;
  }
  return vtt;
}

function groqTranscribe(filePath) {
  return new Promise((resolve, reject) => {
    if (!GROQ_API_KEY) { reject(new Error('GROQ_API_KEY not set')); return; }
    const fileData = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const footer = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);
    const options = {
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed); // verbose_json object with segments
        } catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── File type detection ─────────────────────────────────────────────────────
function getFileType(ext) {
  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'];
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  return 'other';
}

// ─── startFfmpeg(job) ────────────────────────────────────────────────────────
function startFfmpeg(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  currentJobId = jobId;
  job.state = 'running';
  job.startedAt = Date.now();

  const outputPath = path.join(DOWNLOAD_DIR, job.filename);
  jobLog(`[${jobId}] Starting: ${job.url}`);

  const args = ['-y', '-i', job.url,
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
    '-progress', 'pipe:1', outputPath];

  if (job.outTime && job.outTime > 0) {
    args.splice(2, 0, '-ss', String(job.outTime));
  }

  const ffmpeg = spawn('ffmpeg', args);
  job.process = ffmpeg;

  let duration = null;
  let lastPct = -1;

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString();
    if (!duration) {
      const m = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) {
        const [, h, mi, s, ms] = m.map(Number);
        duration = h * 3600 + mi * 60 + s + ms / 100;
        job.durationEstimate = duration;
        jobLog(`[${jobId}] Duration: ${formatTime(duration)}`);
      }
    }
  });

  ffmpeg.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line || !duration) return;
    const timeMs = line.match(/out_time_ms=(\d+)/);
    if (timeMs) {
      const currentTime = parseInt(timeMs[1]) / 1_000_000;
      if (currentTime > 0) {
        job.outTime = currentTime;
        const pct = Math.min(98, Math.round((currentTime / duration) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          job.progress = pct;
          job.message = `${formatTime(currentTime)} / ${formatTime(duration)}`;
        }
      }
    }
    const sizeMatch = line.match(/total_size=(\d+)/);
    if (sizeMatch) job.totalBytes = parseInt(sizeMatch[1]);
  });

  ffmpeg.on('close', (code) => {
    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }
    if (code === 0) {
      j.state = 'done'; j.progress = 100; j.message = 'Done';
      j.downloadUrl = `/downloads/${j.filename}`;
      j.fileSize = getFileSize(outputPath);
      jobLog(`[${jobId}] Done: ${j.filename} (${j.fileSize})`);
      setTimeout(() => { jobs.delete(jobId); }, 100);
    } else if (j.retries < 2) {
      j.retries++; j.state = 'queued'; j.progress = 0; j.message = `Retry ${j.retries}/3`;
      jobLog(`[${jobId}] Retry ${j.retries}/3 (code ${code})`);
      setTimeout(() => processNextJob(), 2000);
    } else {
      j.state = 'error'; j.message = 'Failed after 3 attempts';
      jobLog(`[${jobId}] Error: code ${code}`);
    }
    delete j.process; currentJobId = null; processNextJob();
  });

  ffmpeg.on('error', (err) => {
    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }
    jobLog(`[${jobId}] FFmpeg error: ${err.message}`);
    if (j.retries < 2) {
      j.retries++; j.state = 'queued'; j.progress = 0; j.message = `Retry ${j.retries}/3`;
      setTimeout(() => processNextJob(), 2000);
    } else {
      j.state = 'error'; j.message = 'Failed: network error';
    }
    delete j.process; currentJobId = null; processNextJob();
  });
}

// ─── startExtractMp3(job) ───────────────────────────────────────────────────
function startExtractMp3(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  currentJobId = jobId;
  job.state = 'running';
  job.startedAt = Date.now();
  job.message = 'Extracting MP3...';

  const inputPath = path.join(DOWNLOAD_DIR, job.sourceFile);
  const mp3Filename = job.sourceFile.replace(/\.[^.]+$/, '.mp3');
  const outputPath = path.join(DOWNLOAD_DIR, mp3Filename);

  jobLog(`[${jobId}] Extracting MP3: ${job.sourceFile} -> ${mp3Filename}`);

  // Get duration for progress
  const probe = spawn('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', inputPath
  ]);
  let duration = 0;
  let probeDone = false;

  probe.stdout.on('data', (data) => {
    try {
      const info = JSON.parse(data.toString());
      duration = parseFloat(info.format?.duration) || 0;
    } catch {}
  });
  probe.on('close', () => { probeDone = true; });

  const ffmpeg = spawn('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
    '-progress', 'pipe:1', outputPath
  ]);
  job.process = ffmpeg;

  let lastPct = -1;
  let ffmpegDone = false;

  const checkDone = setInterval(() => {
    if (!probeDone || !ffmpegDone) return;
    clearInterval(checkDone);

    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }

    if (fs.existsSync(outputPath)) {
      j.state = 'done'; j.progress = 100; j.message = 'Done';
      j.downloadUrl = `/downloads/${mp3Filename}`;
      j.fileSize = getFileSize(outputPath);
      jobLog(`[${jobId}] MP3 extracted: ${mp3Filename} (${j.fileSize})`);
    } else {
      j.state = 'error'; j.message = 'Extraction failed';
      jobLog(`[${jobId}] MP3 extraction failed`);
    }
    delete j.process; currentJobId = null; processNextJob();
  }, 500);

  ffmpeg.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line || !duration) return;
    const timeMs = line.match(/out_time_ms=(\d+)/);
    if (timeMs) {
      const currentTime = parseInt(timeMs[1]) / 1_000_000;
      if (currentTime > 0 && duration > 0) {
        job.outTime = currentTime;
        const pct = Math.min(98, Math.round((currentTime / duration) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          job.progress = pct;
          job.message = `Extracting: ${formatTime(currentTime)} / ${formatTime(duration)}`;
        }
      }
    }
  });

  ffmpeg.on('close', (code) => {
    ffmpegDone = true;
    const j = jobs.get(jobId);
    if (j && code !== 0) {
      j.state = 'error'; j.message = 'FFmpeg error';
      delete j.process; currentJobId = null; processNextJob();
    }
  });

  ffmpeg.on('error', (err) => {
    ffmpegDone = true;
    clearInterval(checkDone);
    const j = jobs.get(jobId);
    if (j) { j.state = 'error'; j.message = err.message; delete j.process; }
    currentJobId = null; processNextJob();
    jobLog(`[${jobId}] FFmpeg error: ${err.message}`);
  });
}

// ─── startTranscribe(job) ───────────────────────────────────────────────────
function startTranscribe(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  currentJobId = jobId;
  job.state = 'running';
  job.startedAt = Date.now();
  job.message = 'Preparing...';
  job.progress = 0;

  const inputPath = path.join(DOWNLOAD_DIR, job.sourceFile);
  const vttFilename = job.sourceFile.replace(/\.[^.]+$/, '') + '.en.vtt';
  const outputPath = path.join(DOWNLOAD_DIR, vttFilename);
  const chunkDir = path.join(DOWNLOAD_DIR, `.chunks_${jobId}`);
  const chunkListFile = path.join(chunkDir, 'list.txt');

  jobLog(`[${jobId}] Transcribing (chunked): ${job.sourceFile}`);

  // 1. Get duration
  const getDuration = () => new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', inputPath]);
    let out = '';
    p.stdout.on('data', c => out += c);
    p.on('close', () => { try { resolve(parseFloat(JSON.parse(out).format?.duration) || 0); } catch { resolve(0); } });
  });

  // 2. Split into ~5min chunks using FFmpeg
  const splitChunks = async (duration) => {
    if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });
    const chunkDuration = 300; // 5 minutes per chunk
    const chunks = [];
    let start = 0, i = 0;
    while (start < duration) {
      const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(3,'0')}.mp3`);
      const end = Math.min(start + chunkDuration, duration);
      await new Promise((res) => {
        const p = spawn('ffmpeg', ['-y', '-i', inputPath, '-ss', String(start), '-t', String(end - start), '-vn', '-c:a', 'libmp3lame', '-q:a', '2', chunkPath]);
        p.on('close', res);
        p.on('error', res);
      });
      if (fs.existsSync(chunkPath)) chunks.push(chunkPath);
      start = end;
      i++;
    }
    return chunks;
  };

  // 3. Transcribe all chunks sequentially and merge VTT with offset timestamps
  const transcribeChunks = async (chunks, chunkDuration) => {
    const allVttParts = [];
    const total = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      if (jobs.get(jobId)?.state !== 'running') break;
      job.progress = Math.round((i / total) * 80);
      job.message = `Transcribing chunk ${i + 1}/${total}...`;
      try {
        const verboseJson = await groqTranscribe(chunks[i]);
        const offset = i * chunkDuration;
        const vtt = verboseJsonToVtt(verboseJson, offset);
        allVttParts.push(vtt);
      } catch (err) {
        jobLog(`[${jobId}] Chunk ${i} error: ${err.message}`);
      }
    }
    return allVttParts.join('');
  };

  // 4. Cleanup
  const cleanup = () => {
    try { if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true }); } catch {}
  };

  (async () => {
    try {
      const duration = await getDuration();
      if (!duration) throw new Error('Could not determine audio duration');
      job.message = 'Splitting into chunks...';
      const chunks = await splitChunks(duration);
      if (chunks.length === 0) throw new Error('No audio chunks created');
      job.progress = 5;
      job.message = `Transcribing ${chunks.length} chunk(s)...`;
      const fullVtt = 'WEBVTT\n\n' + await transcribeChunks(chunks, 300);
      cleanup();
      const j2 = jobs.get(jobId);
      if (!j2) { currentJobId = null; return; }
      if (!fullVtt.trim()) { j2.state = 'error'; j2.message = 'No speech detected'; }
      else {
        fs.writeFileSync(outputPath, fullVtt, 'utf-8');
        j2.state = 'done'; j2.progress = 100; j2.message = 'Done';
        j2.downloadUrl = `/downloads/${vttFilename}`;
        j2.fileSize = getFileSize(outputPath);
        jobLog(`[${jobId}] Transcribed: ${vttFilename} (${fullVtt.length} chars)`);
      }
    } catch (err) {
      cleanup();
      const j2 = jobs.get(jobId);
      if (j2) { j2.state = 'error'; j2.message = err.message || 'Transcription failed'; }
      jobLog(`[${jobId}] Transcription error: ${err.message}`);
    }
    delete jobs.get(jobId)?.process;
    currentJobId = null;
    processNextJob();
  })();
}

// ─── startTranslate(job) ─────────────────────────────────────────────────────
function startTranslate(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  currentJobId = jobId;
  job.state = 'running';
  job.startedAt = Date.now();
  job.message = 'Translating...';
  job.progress = 0;

  const inputPath = path.join(DOWNLOAD_DIR, job.sourceFile);
  // Try .en.txt first (plain text), fall back to .en.vtt (subtitles)
  const enTxt = inputPath.replace(/\.[^.]+$/, '') + '.en.txt';
  const enVtt = inputPath.replace(/\.[^.]+$/, '') + '.en.vtt';
  const sourcePath = fs.existsSync(enTxt) ? enTxt : (fs.existsSync(enVtt) ? enVtt : null);
  const txtFilename = job.sourceFile.replace(/\.[^.]+$/, '') + '.cz.txt';
  const outputPath = path.join(DOWNLOAD_DIR, txtFilename);

  jobLog(`[${jobId}] Translating: ${job.sourceFile} -> ${txtFilename} (source: ${sourcePath || 'not found'})`);

  let translated = false;
  const progressTick = setInterval(() => {
    const j = jobs.get(jobId);
    if (!j || j.state !== 'running') { clearInterval(progressTick); return; }
    if (!translated) {
      j.progress = Math.min(j.progress + 5, 90);
      j.message = `Translating... ${j.progress}%`;
    }
  }, 500);

  // Read source transcript (English VTT or TXT)
  let sourceText = '';
  if (!sourcePath) {
    clearInterval(progressTick);
    const j = jobs.get(jobId);
    if (j) { j.state = 'error'; j.message = 'English transcript not found — run transcription first'; }
    currentJobId = null; processNextJob();
    return;
  }
  // Strip VTT cues if source is .vtt (keep only text lines)
  const isVtt = sourcePath && sourcePath.endsWith('.vtt');
  try {
    sourceText = fs.readFileSync(sourcePath, 'utf-8').trim();
    if (isVtt) {
      sourceText = sourceText.split('\n')
        .filter(line => !(/^\d+$/.test(line.trim())) && !line.includes('-->'))
        .join('\n').replace(/^WEBVTT.*$/mg, '').replace(/^\s*$/gm, '').trim();
    }
  } catch (err) {
    clearInterval(progressTick);
    const j = jobs.get(jobId);
    if (j) { j.state = 'error'; j.message = 'Source file not found'; }
    currentJobId = null; processNextJob();
    return;
  }

  if (!sourceText) {
    clearInterval(progressTick);
    const j = jobs.get(jobId);
    if (j) { j.state = 'error'; j.message = 'Source file is empty'; }
    currentJobId = null; processNextJob();
    return;
  }

  groqChat([
    {
      role: 'system',
      content: 'You are an expert translator. Translate the following English text to Czech. Preserve the original meaning exactly, including any names, technical terms, and punctuation. Only output the translation, nothing else. If the text is empty or meaningless, output "No content".',
    },
    { role: 'user', content: sourceText },
  ]).then((result) => {
    translated = true;
    clearInterval(progressTick);
    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }

    if (result.error) {
      j.state = 'error'; j.message = result.error.message || 'Translation failed';
      jobLog(`[${jobId}] Translation error: ${j.message}`);
    } else {
      const translation = result.choices[0].message.content.trim();
      fs.writeFileSync(outputPath, translation, 'utf-8');
      j.state = 'done'; j.progress = 100; j.message = 'Done';
      j.downloadUrl = `/downloads/${txtFilename}`;
      j.fileSize = getFileSize(outputPath);
      jobLog(`[${jobId}] Translated: ${txtFilename} (${translation.length} chars)`);
    }
    delete j.process; currentJobId = null; processNextJob();
  }).catch((err) => {
    translated = true;
    clearInterval(progressTick);
    const j = jobs.get(jobId);
    if (j) { j.state = 'error'; j.message = err.message || 'Translation failed'; }
    currentJobId = null; processNextJob();
    jobLog(`[${jobId}] Translation error: ${err.message}`);
  });
}

// ─── processNextJob ───────────────────────────────────────────────────────────
function processNextJob() {
  if (currentJobId) return;
  for (const [id, job] of jobs) {
    if (job.state === 'queued') {
      const t = job.type;
      if (t === 'download') startFfmpeg(id);
      else if (t === 'extract-mp3') startExtractMp3(id);
      else if (t === 'transcribe') startTranscribe(id);
      else if (t === 'translate') startTranslate(id);
      return;
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/files — list files in download folder
app.get('/api/files', (req, res) => {
  if (!fs.existsSync(DOWNLOAD_DIR)) return res.json({ files: [] });
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => !f.startsWith('.'))
    .map(name => {
      const ext = extname(name);
      const filePath = path.join(DOWNLOAD_DIR, name);
      const stats = fs.statSync(filePath);
      return {
        name,
        size: formatFileSize(stats.size),
        sizeBytes: stats.size,
        mtime: stats.mtime.toISOString(),
        type: getFileType(ext),
        ext,
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json({ files });
});

// POST /api/download
app.post('/api/download', async (req, res) => {
  const { url, filename } = req.body;
  if (!url || !url.includes('.m3u8')) return res.status(400).json({ error: 'Invalid .m3u8 URL' });
  if (!await checkFFmpeg()) return res.status(500).json({ error: 'FFmpeg not found' });

  const jobId = randomUUID();
  const finalFilename = filename?.trim()
    ? filename.trim().replace(/\.mp4$/, '') + '.mp4'
    : `download_${jobId.slice(0, 8)}.mp4`;

  const job = {
    id: jobId, type: 'download', url, filename: finalFilename,
    state: 'queued', progress: 0, message: 'Queued', retries: 0,
    createdAt: Date.now(), downloadUrl: null, fileSize: null,
    outTime: null, totalBytes: null, durationEstimate: null,
  };
  jobs.set(jobId, job);
  jobLog(`[${jobId}] Queued: ${url} -> ${finalFilename}`);
  res.json({ jobId, filename: finalFilename });
  processNextJob();
});

// POST /api/extract-mp3
app.post('/api/extract-mp3', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  const inputPath = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });
  const ext = extname(filename);
  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'];
  if (!videoExts.includes(ext)) return res.status(400).json({ error: 'Not a video file' });

  const jobId = randomUUID();
  const job = {
    id: jobId, type: 'extract-mp3', sourceFile: filename,
    filename: filename.replace(/\.[^.]+$/, '.mp3'),
    state: 'queued', progress: 0, message: 'Queued', retries: 0,
    createdAt: Date.now(), downloadUrl: null, fileSize: null,
  };
  jobs.set(jobId, job);
  jobLog(`[${jobId}] MP3 extraction queued: ${filename}`);
  res.json({ jobId });
  processNextJob();
});

// POST /api/transcribe
app.post('/api/transcribe', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  const inputPath = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });
  const ext = extname(filename);
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'mkv', 'avi', 'mov'];
  if (!audioExts.includes(ext)) return res.status(400).json({ error: 'Unsupported audio/video file' });

  const jobId = randomUUID();
  const job = {
    id: jobId, type: 'transcribe', sourceFile: filename,
    filename: filename.replace(/\.[^.]+$/, '') + '.en.txt',
    state: 'queued', progress: 0, message: 'Queued', retries: 0,
    createdAt: Date.now(), downloadUrl: null, fileSize: null,
  };
  jobs.set(jobId, job);
  jobLog(`[${jobId}] Transcription queued: ${filename}`);
  res.json({ jobId });
  processNextJob();
});

// POST /api/translate
app.post('/api/translate', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  const inputPath = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const jobId = randomUUID();
  const job = {
    id: jobId, type: 'translate', sourceFile: filename,
    filename: filename.replace(/\.[^.]+$/, '') + '.cz.txt',
    state: 'queued', progress: 0, message: 'Queued', retries: 0,
    createdAt: Date.now(), downloadUrl: null, fileSize: null,
  };
  jobs.set(jobId, job);
  jobLog(`[${jobId}] Translation queued: ${filename}`);
  res.json({ jobId });
  processNextJob();
});

// POST /api/pause/:jobId
app.post('/api/pause/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.state !== 'running') return res.status(400).json({ error: 'Not running' });
  if (job.type !== 'download') return res.status(400).json({ error: 'Only downloads can be paused' });
  job.state = 'paused';
  if (job.process) { job.process.kill('SIGTERM'); delete job.process; }
  jobLog(`[${job.id}] Paused at ${formatTime(job.outTime || 0)}s`);
  res.json({ ok: true });
});

// POST /api/resume/:jobId
app.post('/api/resume/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.state !== 'paused') return res.status(400).json({ error: 'Not paused' });
  if (job.type !== 'download') return res.status(400).json({ error: 'Only downloads can be resumed' });

  job.state = 'queued';
  jobLog(`[${job.id}] Resuming from ${formatTime(job.outTime || 0)}s`);
  processNextJob();
  res.json({ ok: true });
});

// GET /api/queue
app.get('/api/queue', (req, res) => {
  const all = Array.from(jobs.values()).map(({ process, ...j }) => j);
  res.json({ jobs: all });
});

// DELETE /api/job/:jobId
app.delete('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) {
    if ((job.state === 'running' || job.state === 'paused' || job.state === 'resuming') && job.process) {
      job.process.kill('SIGTERM');
      delete job.process;
    }
    jobLog(`[${job.id}] Cancelled`);
    jobs.delete(req.params.jobId);
  }
  if (currentJobId === req.params.jobId) { currentJobId = null; processNextJob(); }
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/downloads')) return next();
  const idx = path.join(CLIENT_DIR, 'dist', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(200).send('<html><body><h1>MThree Running</h1></body></html>');
});

app.listen(PORT, () => {
  jobLog(`MThree running on http://localhost:${PORT}`);
  jobLog(`Download dir: ${DOWNLOAD_DIR}`);
});
