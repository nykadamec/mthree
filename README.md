# MThree — M3U8 → MP4 Downloader

React + Express app for downloading HLS (.m3u8) streams and converting them to .mp4 using FFmpeg.

**Server:** `node server/index.js` (port 7766)  
**Download folder:** `download/`

---

## Changelog

### 2026-04-27

#### Added
- Persistent job logging to `logs/jobs_YYYY-MM-DD.log`
- **Pause/Resume** — `POST /api/pause/:jobId` + `POST /api/resume/:jobId`
  - Saves `outTime`, `totalBytes`, `durationEstimate` on pause
  - Resume uses `-ss <position>` seek
  - Fallback dialog if segment expired
  - UI: Pause (orange) + Cancel for running, Resume (green) + Cancel for paused
- **Browser notifications** — bell icon in header (🔔 on / 🔕 off / ⚪ disabled)
  - Web Notifications API triggers on job done
  - localStorage persists preference (`mthree_notifications`)
- React + Express app with FFmpeg integration
- Queue system (one active, others queued)
- Progress bar with time display (HH:MM:SS / HH:MM:SS)
- Custom filename input with duplicate protection
- History section (last 10 completed downloads)
- Retry logic (2 retries on network failure, 3 attempts total)
- localStorage persistence across page reloads
- Dark theme (#ff6b35 accent)

#### Fixed
- **Double progress display** (e.g. `6% — 6%`): Size watcher no longer overwrites `job.message`
- **Progress bar restart after reload**: `done`/`error` jobs preserve state on reload
- **Completed jobs being reset**: Completed jobs deleted from server memory immediately

---

## Tech

- **Frontend:** React + Vite (dark theme, orange accent #ff6b35)
- **Backend:** Express.js (Node.js)
- **Conversion:** FFmpeg (stream copy, `-c copy`)
- **Queue:** In-memory Map with single-active-job processing
