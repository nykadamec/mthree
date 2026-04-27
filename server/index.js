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

// Ensure directories exist
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Persistent job log — logs/jobs_YYYY-MM-DD.log
const LOG_FILE = path.join(LOG_DIR, `jobs_${new Date().toISOString().slice(0,10)}.log`);
const jobLog = (msg) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.error(`[JOB] ${msg}`);
};

jobLog('=== MThree Server Start ===');
jobLog(`DOWNLOAD_DIR: ${DOWNLOAD_DIR}`);
jobLog(`LOG_FILE: ${LOG_FILE}`);
jobLog(`PID: ${process.pid}`);

// In-memory job store
const jobs = new Map();
let currentJobId = null;

app.use(cors());
app.use(express.json());

// Serve static files (built frontend)
const distPath = path.join(CLIENT_DIR, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Serve API and downloads
app.use('/downloads', express.static(DOWNLOAD_DIR));

// FFmpeg availability check
function checkFFmpeg() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// Parse time from FFmpeg stderr "time=00:01:23.45"
function parseTime(timeStr) {
  const match = timeStr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return null;
  const [, h, m, s, ms] = match.map(Number);
  return h * 3600 + m * 60 + s + ms / 100;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getFileSize(filepath) {
  try {
    const stats = fs.statSync(filepath);
    return formatFileSize(stats.size);
  } catch {
    return null;
  }
}

// Process next queued job
function processNextJob() {
  if (currentJobId) return;

  let nextJob = null;
  for (const [id, job] of jobs) {
    if (job.state === 'queued') {
      nextJob = { id, ...job };
      break;
    }
  }
  if (!nextJob) return;

  currentJobId = nextJob.id;
  const job = jobs.get(currentJobId);
  job.state = 'running';
  job.startedAt = Date.now();

  const { url, filename } = job;
  const outputPath = path.join(DOWNLOAD_DIR, filename);

  jobLog(`[${currentJobId}] Starting: ${url}`);
  jobLog(`[${currentJobId}] Output: ${outputPath}`);

  // Delete existing file if present (FFmpeg won't overwrite)
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
    jobLog(`[${currentJobId}] Deleted existing file`);
  }

  const ffmpeg = spawn('ffmpeg', [
    '-y', // overwrite output file without asking
    '-i', url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outputPath,
  ]);

  job.process = ffmpeg;

  let durationEstimate = null;
  let lastLoggedProgress = -1;
  let lastFileSize = 0;
  let totalBytes = 0;

  // Watch output file size to estimate progress
  const sizeWatch = setInterval(() => {
    try {
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        const currentSize = stats.size;
        if (currentSize > lastFileSize) {
          lastFileSize = currentSize;
          // Update progress based on file size (rough estimate)
          if (durationEstimate && lastFileSize > 0) {
            const progress = Math.min(98, Math.round((lastFileSize / totalBytes) * 100));
            if (progress !== lastLoggedProgress) {
              jobLog(`[${currentJobId}] Progress: ${lastFileSize} / ${totalBytes} bytes = ${progress}%`);
              lastLoggedProgress = progress;
              job.progress = progress;
              job.message = `${progress}%`;
            }
          }
        }
      }
    } catch {}
  }, 1000);

  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString();
    // Duration header only appears with re-encoding; for stream copy use size-based estimation
    if (!durationEstimate) {
      const durMatch = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (durMatch) {
        const [, h, m, s, ms] = durMatch.map(Number);
        durationEstimate = h * 3600 + m * 60 + s + ms / 100;
        job.estimatedTotal = durationEstimate;
        jobLog(`[${currentJobId}] Duration from header: ${durationEstimate.toFixed(1)}s`);
      }
    }
  });

  ffmpeg.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    // Parse "out_time_ms=1234567" from -progress output
    const outTimeMatch = line.match(/out_time_ms=(\d+)/);
    if (outTimeMatch && durationEstimate) {
      const currentTime = parseInt(outTimeMatch[1]) / 1000000;
      if (currentTime > 0) {
        const progress = Math.min(98, Math.round((currentTime / durationEstimate) * 100));
        if (progress !== lastLoggedProgress) {
          jobLog(`[${currentJobId}] Progress: ${formatTime(currentTime)} / ${formatTime(durationEstimate)} = ${progress}%`);
          lastLoggedProgress = progress;
          job.progress = progress;
          job.message = `${formatTime(currentTime)} / ${formatTime(durationEstimate)}`;
        }
      }
    }
    // Parse total_size from -progress output
    const sizeMatch = line.match(/total_size=(\d+)/);
    if (sizeMatch) {
      totalBytes = parseInt(sizeMatch[1]);
    }
  });

  ffmpeg.on('close', (code) => {
    clearInterval(sizeWatch);
    const job = jobs.get(currentJobId);
    if (!job) { currentJobId = null; return; }

    if (code === 0) {
      job.state = 'done';
      job.progress = 100;
      job.message = 'Done';
      job.downloadUrl = `/downloads/${filename}`;
      job.fileSize = getFileSize(outputPath);
      jobLog(`[${currentJobId}] Done: ${filename} (${job.fileSize})`);
      // Remove from jobs map immediately
      setTimeout(() => {
        jobs.delete(currentJobId);
        jobLog(`[${currentJobId}] Removed from queue`);
      }, 100);
    } else if (job.retries < 2) {
      job.retries++;
      job.state = 'queued';
      job.progress = 0;
      job.message = `Retry ${job.retries}/3`;
      jobLog(`[${currentJobId}] Retry ${job.retries}/3 (exit code ${code})`);
      setTimeout(() => processNextJob(), 2000);
    } else {
      job.state = 'error';
      job.message = 'Failed after 3 attempts';
      jobLog(`[${currentJobId}] Error: exited with code ${code}`);
    }

    currentJobId = null;
    delete job.process;
    processNextJob();
  });

  ffmpeg.on('error', (err) => {
    const job = jobs.get(currentJobId);
    if (!job) { currentJobId = null; return; }

    jobLog(`[${currentJobId}] FFmpeg error: ${err.message}`);

    if (job.retries < 2) {
      job.retries++;
      job.state = 'queued';
      job.progress = 0;
      job.message = `Retry ${job.retries}/3`;
      jobLog(`[${currentJobId}] Network error, retry ${job.retries}/3`);
      setTimeout(() => processNextJob(), 2000);
    } else {
      job.state = 'error';
      job.message = 'Failed: network error';
    }

    currentJobId = null;
    processNextJob();
  });
}

// POST /api/download
app.post('/api/download', async (req, res) => {
  const { url, filename } = req.body;

  if (!url || !url.includes('.m3u8')) {
    return res.status(400).json({ error: 'Invalid .m3u8 URL' });
  }

  if (!await checkFFmpeg()) {
    return res.status(500).json({ error: 'FFmpeg not found. Please install FFmpeg.' });
  }

  const jobId = randomUUID();
  const finalFilename = filename?.trim()
    ? filename.trim().replace(/\.mp4$/, '') + '.mp4'
    : `download_${jobId.slice(0, 8)}.mp4`;

  const job = {
    id: jobId,
    url,
    filename: finalFilename,
    state: 'queued',
    progress: 0,
    message: 'Queued',
    retries: 0,
    createdAt: Date.now(),
    downloadUrl: null,
    fileSize: null,
  };

  jobs.set(jobId, job);
  jobLog(`[${jobId}] Queued: ${url} -> ${finalFilename}`);

  res.json({ jobId, filename: finalFilename });
  processNextJob();
});

// GET /api/status/:jobId
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { process, ...safe } = job;
  res.json(safe);
});

// GET /api/queue
app.get('/api/queue', (req, res) => {
  // Return all jobs including completed (for history)
  const allJobs = Array.from(jobs.values())
    .map(({ process, ...j }) => j);
  res.json({ jobs: allJobs });
});

// DELETE /api/job/:jobId
app.delete('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.state === 'running' && job.process) {
    job.process.kill('SIGTERM');
    job.state = 'cancelled';
    job.message = 'Cancelled';
    jobLog(`[${job.id}] Cancelled`);
  }

  jobs.delete(req.params.jobId);
  res.json({ ok: true });

  if (currentJobId === req.params.jobId) {
    currentJobId = null;
    processNextJob();
  }
});

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/downloads')) return next();
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('<html><body><h1>MThree Server Running</h1><p>Build the client: cd client && bun run build</p></body></html>');
  }
});

app.listen(PORT, () => {
  jobLog(`MThree server running on http://localhost:${PORT}`);
  jobLog(`Download directory: ${DOWNLOAD_DIR}`);
  jobLog(`Log file: ${LOG_FILE}`);
});
