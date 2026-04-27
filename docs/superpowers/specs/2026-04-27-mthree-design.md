# MThree — M3U8 Video Downloader

## Project Overview

**Name:** MThree  
**Type:** Web application (React + Express/Bun)  
**Core functionality:** Download and convert `.m3u8` HLS streams to `.mp4` using FFmpeg, with queue management and persistent pending jobs via localStorage.  
**Target users:** Anyone who needs to save HLS video streams locally.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React (Vite), plain CSS |
| Backend | Express.js on Bun |
| Media conversion | FFmpeg (must be installed on system) |
| State persistence | localStorage (queue survives refresh) |
| File delivery | Static files from `download/` directory |

---

## Project Structure

```
/Users/nykadamec/.openclaw/workspace/projects/mthree/
├── download/              # .mp4 files land here
├── client/                # React (Vite) frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── server/
│   ├── index.js            # Express server, FFmpeg spawn, job store
│   ├── package.json
│   └── download/           # symlink or alias to project-level download/
└── package.json            # root: bun run dev (concurrently)
```

---

## User Flow

1. User pastes `.m3u8` URL into the input field
2. Optionally enters a custom filename (if empty → random generated name)
3. Clicks "Download" → item added to queue
4. If no job is running, first queue item starts immediately:
   - FFmpeg spawns: `ffmpeg -i "<url>" -c copy -bsf:a aac_adtstoasc -movflags +faststart download/<filename.mp4>`
   - Progress bar (0–100%) with time estimate updates via polling
   - On completion: shows file size + download button
5. Completed items disappear from UI (file stays on disk)
6. Queued items persist in localStorage across page refresh

---

## API Design

| Method | Path | Request | Response |
|--------|------|---------|----------|
| POST | `/api/download` | `{ url: string, filename?: string }` | `{ jobId: string }` |
| GET | `/status/:jobId` | — | `{ state, progress, message, downloadUrl?, fileSize? }` |
| GET | `/downloads/:filename` | — | Static file |
| DELETE | `/job/:jobId` | — | Cancels running job or removes from queue |
| GET | `/queue` | — | `{ jobs: Job[] }` |

### Job States
- `queued` — waiting in queue
- `running` — currently downloading/converting
- `done` — completed successfully
- `error` — failed (with retry up to 2 times for network errors)
- `cancelled` — user cancelled

### Progress Object
```ts
{
  state: JobState,
  progress: number,        // 0–100
  message: string,        // e.g. "Converting..." or "67%"
  downloadUrl?: string,    // /downloads/filename.mp4 when done
  fileSize?: string,       // e.g. "324 MB" when done
  url: string,
  filename: string,
  createdAt: number
}
```

---

## FFmpeg Integration

**Command:**
```bash
ffmpeg -i "<m3u8_url>" -c copy -bsf:a aac_adtstoasc -movflags +faststart <download_dir>/<filename.mp4>
```

**Progress parsing:**
- FFmpeg outputs to stderr in format: `time=00:01:23.45 ...`
- Parse `time=` to estimate total duration (sampled over first 5 seconds)
- Calculate percentage: `elapsed_time / estimated_total * 100`

**Retry logic:**
- Network errors trigger up to 2 automatic retries (3 attempts total)
- Non-network errors (e.g. invalid URL) → immediately `error` state

**FFmpeg availability check:**
- Server checks on startup: `bunx ffmpeg -version` or `which ffmpeg`
- If not found → server exits with clear error message

---

## UI Layout

Single page, vertically stacked:

```
┌─────────────────────────────────────────┐
│ HEADER: "MThree"                        │
├─────────────────────────────────────────┤
│ INPUT SECTION:                          │
│ ┌─────────────────────────────────────┐ │
│ │ [URL input───────────────────────] │ │
│ │ [Filename input (optional)──────]  │ │
│ │            [Download]               │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ ACTIVE JOB:                             │
│ ┌─────────────────────────────────────┐ │
│ │ ● Converting...                     │ │
│ │ ████████████░░░░░░░░░  67%         │ │
│ │ time: 00:45 / ~02:30               │ │
│ │ [Cancel]                            │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ QUEUE:                                  │
│ ┌─────────────────────────────────────┐ │
│ │ 1. video_preset.mp4   [queued]      │ │
│ │ 2. stream_live.m3u8  [queued]      │ │
│ │                        [remove]    │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ LAST COMPLETED:                         │
│ ┌─────────────────────────────────────┐ │
│ │ ✔ video_final.mp4  (324 MB)       │ │
│ │   [Download]  [Copy link]          │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Styling:**
- Background: `#121212`
- Card background: `#1e1e1e`
- Accent color: `#ff6b35` (warm orange)
- Font: system-ui, sans-serif
- Clean, minimal, dark theme

---

## Frontend State (localStorage)

```ts
{
  queue: Job[],        // all queued + running jobs (persisted)
  lastCompleted: Job,   // most recent completed job (shown briefly)
}
```

- On page load: restore queue from localStorage
- On page unload: nothing (no save needed, state is reactive)
- Completed jobs removed from queue on completion → `lastCompleted` shown for 5s then cleared

---

## Features Summary

| Feature | Description |
|---------|-------------|
| Single download slot | Only one FFmpeg process at a time |
| Queue | Additional URLs go into FIFO queue |
| Progress bar | Percentage + time estimate from FFmpeg output |
| Custom filename | Optional; random name if empty |
| File size | Shown after completion |
| Cancel running | Kills FFmpeg process |
| Remove queued | Removes from queue without affecting disk |
| Retry on network error | Up to 2 retries |
| localStorage persistence | Queued items survive page refresh |
| Copy download link | One-click copy to clipboard |

---

## Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Root — runs client + server with `bun run dev` |
| `client/package.json` | Vite + React deps |
| `client/vite.config.js` | Proxy `/api/*` → `localhost:7766` |
| `client/index.html` | Entry HTML |
| `client/src/main.jsx` | React entry |
| `client/src/App.jsx` | Main component, state, polling |
| `client/src/App.css` | Dark theme, orange accent |
| `server/index.js` | Express app, FFmpeg spawn, job store |
| `server/package.json` | express, cors deps |
| `download/.gitkeep` | Ensure directory exists |

---

## Verification Steps

1. `cd /Users/nykadamec/.openclaw/workspace/projects/mthree`
2. `bun run dev` — both servers start
3. Open `http://localhost:5173`
4. Paste a real `.m3u8` URL → click Download
5. See progress bar animate → completion → download link works
6. Add 2nd URL → see it queue → starts after first finishes
7. Refresh page → queued item still present
8. Cancel running → FFmpeg killed, queue advances

---

## Risks & Open Questions

- FFmpeg must be pre-installed on the system (no bundled binary)
- HLS streams with AES-128 encryption will fail without `-hls_key_info_file` flag (out of scope for v1)
- No authentication — anyone with network access can use the app
- No disk cleanup in v1 — `download/` grows indefinitely
