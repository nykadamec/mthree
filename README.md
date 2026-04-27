# MThree — M3U8 → MP4 Downloader

React + Express app for downloading HLS (.m3u8) streams and converting them to .mp4 using FFmpeg, with audio extraction, transcription, and translation.

**Server:** `node server/index.js` (port 7766)
**Download folder:** `download/`
**Environment:** `GROQ_API_KEY` for transcription/translation (optional)

---

## Changelog

### 2026-04-27

#### Added
- **Files Modal** — 📁 button in header opens modal with all files in `download/`
  - Table: filename, size, type (video/audio), date
  - **MP3** — extract audio from video via FFmpeg (`-vn -c:a libmp3lame`)
  - **EN** — transcribe to English text via Groq Whisper API (`distil-whisper-large-v3-en`)
  - **CZ** — translate to Czech via Groq LLM (`llama-4-scout-17b-16e-instruct`)
  - All operations use same job queue as downloads
- **Pause/Resume** — saves position on pause, resumes with `-ss` seek
  - Fallback dialog if segment expired
  - Pause (orange) + Cancel for running; Resume (green) + Cancel for paused
- **Browser notifications** — 🔔 bell icon in header (on/off/disabled)
  - Web Notifications API on job completion
  - localStorage persists preference
- Persistent job logging to `logs/jobs_YYYY-MM-DD.log`
- React + Express app with FFmpeg integration
- Queue system (one active, others queued)
- Progress bar with time display (HH:MM:SS / HH:MM:SS)
- Custom filename input with duplicate protection
- History section (last 10 completed)
- Retry logic (2 retries on network failure, 3 attempts total)
- localStorage persistence across page reloads
- Dark theme (#ff6b35 accent)

#### Fixed
- **Double progress display** (e.g. `6% — 6%`): size watcher no longer overwrites `job.message`
- **Progress bar restart after reload**: `done`/`error` jobs preserve state
- **Completed jobs being reset**: completed jobs deleted from server memory immediately

---

## Tech
- **Frontend:** React + Vite (dark theme, orange accent #ff6b35)
- **Backend:** Express.js (Node.js)
- **Conversion:** FFmpeg (stream copy for downloads, libmp3lame for MP3 extraction)
- **STT:** Groq Whisper API (`distil-whisper-large-v3-en`)
- **Translation:** Groq LLM (`llama-4-scout-17b-16e-instruct`)
- **Queue:** In-memory Map with single-active-job processing
