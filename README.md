# MThree — M3U8 → MP4 Downloader

React + Express app for downloading HLS (.m3u8) streams and converting them to .mp4 using FFmpeg.

**Server:** `node server/index.js` (port 7766)  
**Download folder:** `download/`

---

## Changelog

### 2026-04-27

#### Added
- Initial commit — React + Express app with FFmpeg integration
- Queue system: one active download, others queued
- Progress bar with time display (HH:MM:SS / HH:MM:SS)
- Custom filename input with duplicate filename protection
- History section showing last 10 completed downloads
- Retry logic (2 retries on network failure, 3 attempts total)
- localStorage persistence for queue state across page reloads
- Dark theme (#ff6b35 accent)
- Persistent job logging to `logs/jobs_YYYY-MM-DD.log`
- Server startup info (PID, download dir, log file) logged on start

#### Fixed
- **Double progress display** (e.g. `6% — 6%`): Server was sending `6%` in `message` AND UI was appending `${progress}%`. Fixed by removing `job.message = '${progress}%'` from size watcher — only `job.progress` is updated, message stays as time format from `-progress` stdout.
- **Progress bar restart after reload**: localStorage was forcing all jobs to `queued` state on page reload, causing completed jobs to re-appear as active. Fixed — `done`/`error` jobs now preserve their state.
- **Completed jobs being reset**: Completed jobs are now removed from server's in-memory job Map immediately (not after 10s delay).
- **Duplicate filename check**: Warns user if proposed filename already exists in history before adding to queue.

#### Changed
- **Progress message format**: Changed from `XX%` to `HH:MM:SS / HH:MM:SS` time format for better readability.
- **FFmpeg progress**: Uses `-progress pipe:1` for structured stdout output (`out_time_ms`, `total_size`) instead of parsing stderr.
- **Server startup**: Removed verbose debug output, replaced with cleaner startup log.

---

## Tech

- **Frontend:** React + Vite (dark theme, orange accent #ff6b35)
- **Backend:** Express.js (Node.js)
- **Conversion:** FFmpeg (stream copy, `-c copy`)
- **Queue:** In-memory Map with single-active-job processing
