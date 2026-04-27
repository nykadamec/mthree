const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = 7766;
const DOWNLOAD_DIR = path.join(__dirname, '..', 'download');
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const LOG_DIR = path.join(__dirname, '..', 'logs');

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
jobLog(`LOG_FILE: ${LOG_FILE}`);
jobLog(`PID: ${process.pid}`);

const jobs = new Map();
let currentJobId = null;

app.use(cors());
app.use(express.json());

const distPath = path.join(CLIENT_DIR, 'dist');
if (fs.existsSync(distPath)) app.use(express.static(distPath));
app.use('/downloads', express.static(DOWNLOAD_DIR));

function checkFFmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function parseTime(timeStr) {
  const m = timeStr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return null;
  const [, h, mi, s, ms] = m.map(Number);
  return h * 3600 + mi * 60 + s + ms / 100;
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

// ─── startFfmpeg(job) ───────────────────────────────────────────────────────
// Handles FFmpeg spawning, progress tracking, and job state transitions.
// Uses time-based progress (out_time_ms / duration) from -progress pipe:1.
// Size watcher only updates job.totalBytes (for resume), NOT progress.
function startFfmpeg(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  currentJobId = jobId;
  job.state = 'running';
  job.startedAt = Date.now();

  const outputPath = path.join(DOWNLOAD_DIR, job.filename);

  jobLog(`[${jobId}] Starting: ${job.url}`);
  if (job.outTime) jobLog(`[${jobId}] Resuming from: ${formatTime(job.outTime)}s`);

  const args = ['-y', '-i', job.url,
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
    '-progress', 'pipe:1', outputPath];

  if (job.outTime && job.outTime > 0) {
    args.splice(2, 0, '-ss', String(job.outTime));
  }

  const ffmpeg = spawn('ffmpeg', args);
  job.process = ffmpeg;

  let duration = null;          // total duration in seconds
  let lastPct = -1;

  // Watch file size every 5s — only updates job.totalBytes, NOT progress
  const sizeWatch = setInterval(() => {
    try {
      if (fs.existsSync(outputPath)) {
        job.totalBytes = fs.statSync(outputPath).size;
      }
    } catch {}
  }, 5000);

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
    clearInterval(sizeWatch);
    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }

    if (code === 0) {
      j.state = 'done';
      j.progress = 100;
      j.message = 'Done';
      j.downloadUrl = `/downloads/${j.filename}`;
      j.fileSize = getFileSize(outputPath);
      jobLog(`[${jobId}] Done: ${j.filename} (${j.fileSize})`);
      setTimeout(() => { jobs.delete(jobId); jobLog(`[${jobId}] Removed`); }, 100);
    } else if (j.retries < 2) {
      j.retries++;
      j.state = 'queued';
      j.progress = 0;
      j.message = `Retry ${j.retries}/3`;
      jobLog(`[${jobId}] Retry ${j.retries}/3 (code ${code})`);
      setTimeout(() => processNextJob(), 2000);
    } else {
      j.state = 'error';
      j.message = 'Failed after 3 attempts';
      jobLog(`[${jobId}] Error: code ${code}`);
    }

    delete j.process;
    currentJobId = null;
    processNextJob();
  });

  ffmpeg.on('error', (err) => {
    clearInterval(sizeWatch);
    const j = jobs.get(jobId);
    if (!j) { currentJobId = null; return; }

    jobLog(`[${jobId}] FFmpeg error: ${err.message}`);
    if (j.retries < 2) {
      j.retries++;
      j.state = 'queued';
      j.progress = 0;
      j.message = `Retry ${j.retries}/3`;
      setTimeout(() => processNextJob(), 2000);
    } else {
      j.state = 'error';
      j.message = 'Failed: network error';
    }
    delete j.process;
    currentJobId = null;
    processNextJob();
  });
}

// ─── processNextJob ───────────────────────────────────────────────────────────
function processNextJob() {
  if (currentJobId) return;
  for (const [id, job] of jobs) {
    if (job.state === 'queued') { startFfmpeg(id); return; }
  }
}

// ─── POST /api/download ──────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { url, filename } = req.body;
  if (!url || !url.includes('.m3u8')) return res.status(400).json({ error: 'Invalid .m3u8 URL' });
  if (!await checkFFmpeg()) return res.status(500).json({ error: 'FFmpeg not found' });

  const jobId = randomUUID();
  const finalFilename = filename?.trim()
    ? filename.trim().replace(/\.mp4$/, '') + '.mp4'
    : `download_${jobId.slice(0, 8)}.mp4`;

  const job = {
    id: jobId, url, filename: finalFilename,
    state: 'queued', progress: 0, message: 'Queued', retries: 0,
    createdAt: Date.now(), downloadUrl: null, fileSize: null,
    outTime: null, totalBytes: null, durationEstimate: null,
  };
  jobs.set(jobId, job);
  jobLog(`[${jobId}] Queued: ${url} -> ${finalFilename}`);
  res.json({ jobId, filename: finalFilename });
  processNextJob();
});

// ─── POST /api/pause/:jobId ─────────────────────────────────────────────────
app.post('/api/pause/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.state !== 'running') return res.status(400).json({ error: 'Not running' });

  job.state = 'paused';
  if (job.process) { job.process.kill('SIGTERM'); delete job.process; }
  jobLog(`[${job.id}] Paused at ${formatTime(job.outTime || 0)}s`);
  res.json({ ok: true });
});

// ─── POST /api/resume/:jobId ─────────────────────────────────────────────────
app.post('/api/resume/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.state !== 'paused') return res.status(400).json({ error: 'Not paused' });

  job.state = 'resuming';
  jobLog(`[${job.id}] Resuming from ${formatTime(job.outTime || 0)}s`);

  // If outTime is 0, just restart as a fresh job
  if (!job.outTime || job.outTime === 0) {
    job.outTime = null;
    job.totalBytes = null;
    job.durationEstimate = null;
    job.state = 'queued';
    processNextJob();
    return res.json({ ok: true });
  }

  const outputPath = path.join(DOWNLOAD_DIR, job.filename);

  // Try to resume with -ss. If file doesn't exist, start from 0.
  if (!fs.existsSync(outputPath)) {
    jobLog(`[${job.id}] Output file gone, starting from 0`);
    job.outTime = null;
    job.totalBytes = null;
    job.state = 'queued';
    processNextJob();
    return res.json({ ok: true });
  }

  const args = ['-y', '-ss', String(job.outTime), '-i', job.url,
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
    '-progress', 'pipe:1', outputPath];

  const ffmpeg = spawn('ffmpeg', args);
  job.process = ffmpeg;

  let duration = job.durationEstimate || null;
  let lastPct = -1;

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString();
    if (!duration) {
      const m = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (m) {
        const [, h, mi, s, ms] = m.map(Number);
        duration = h * 3600 + mi * 60 + s + ms / 100;
        job.durationEstimate = duration;
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
    const j = jobs.get(job.id);
    if (!j) { currentJobId = null; return; }

    if (code === 0) {
      j.state = 'done';
      j.progress = 100;
      j.message = 'Done';
      j.downloadUrl = `/downloads/${j.filename}`;
      j.fileSize = getFileSize(outputPath);
      jobLog(`[${job.id}] Done: ${j.filename} (${j.fileSize})`);
      setTimeout(() => { jobs.delete(job.id); }, 100);
    } else {
      // Resume failed — probably segment expired, offer restart from 0
      j.state = 'paused';
      j.message = 'Segment expired';
      jobLog(`[${job.id}] Resume failed (code ${code})`);
      delete j.process;
      currentJobId = null;
      res.json({ ok: false, reason: 'segment_expired' });
      return;
    }
    delete j.process;
    currentJobId = null;
    processNextJob();
    res.json({ ok: true });
  });

  ffmpeg.on('error', (err) => {
    const j = jobs.get(job.id);
    if (j) { j.state = 'paused'; j.message = 'Resume error'; delete j.process; }
    currentJobId = null;
    jobLog(`[${job.id}] Resume error: ${err.message}`);
    res.json({ ok: false, reason: 'error', message: err.message });
  });

  res.json({ ok: true });
});

// ─── GET /api/queue ───────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  const all = Array.from(jobs.values()).map(({ process, ...j }) => j);
  res.json({ jobs: all });
});

// ─── DELETE /api/job/:jobId ──────────────────────────────────────────────────
app.delete('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) {
    if ((job.state === 'running' || job.state === 'paused' || job.state === 'resuming') && job.process) {
      job.process.kill('SIGTERM');
      delete job.process;
    }
    job.state = 'cancelled';
    job.message = 'Cancelled';
    jobLog(`[${job.id}] Cancelled`);
    jobs.delete(req.params.jobId);
  }
  if (currentJobId === req.params.jobId) { currentJobId = null; processNextJob(); }
  res.json({ ok: true });
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/downloads')) return next();
  const idx = path.join(distPath, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(200).send('<html><body><h1>MThree Running</h1></body></html>');
});

app.listen(PORT, () => {
  jobLog(`MThree running on http://localhost:${PORT}`);
  jobLog(`Download dir: ${DOWNLOAD_DIR}`);
});
