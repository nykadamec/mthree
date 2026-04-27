# MThree — Pause/Resume & Notifications Design

## Status: Approved

---

## 1. Pause/Resume

### Job States (updated)

| State | Description |
|-------|-------------|
| `queued` | Čeká ve frontě |
| `running` | FFmpeg aktivně stahuje |
| `paused` | FFmpeg ukončen, pozice uložena |
| `resuming` | Probíhá obnova z pause |
| `done` | Hotovo |
| `error` | Chyba po 3 pokusech |
| `cancelled` | Zrušeno uživatelem |

### Server: Pause (`POST /api/pause/:jobId`)

1. Ověř že job je ve stavu `running`
2. Uloží aktuální FFmpeg progress:
   - `outTime` — z `out_time_ms` (v sekundách)
   - `totalBytes` — z `total_size`
   - `durationEstimate` — odhad celkové doby
3. Killne FFmpeg proces (SIGTERM)
4. Nastaví `job.state = 'paused'`
5. Smaže temp soubor `.part` pokud existuje
6. Log: `[jobId] Paused at ${outTime}s`

### Server: Resume (`POST /api/resume/:jobId`)

1. Ověř že job je ve stavu `paused`
2. Nastaví `job.state = 'resuming'`
3. Spustí FFmpeg s `-ss <outTime>` seekem:
   ```
   ffmpeg -y -ss <outTime> -i <url> -c copy -bsf:a aac_adtstoasc -movflags +faststart -progress pipe:1 <outputPath>
   ```
4. Na chybu (exit code != 0 hned při startu):
   - Pokud je chyba "404" / "Not Found" / expired segment → fallback
   - Fallback dialog: "Segment vypršel. Začít znovu od nuly?"
     - Ano → smaže soubor, restartuje FFmpeg bez `-ss`
     - Ne → vrátí job do `paused` stavu
5. Na úspěšný start → `job.state = 'running'`
6. Log: `[jobId] Resuming from ${outTime}s`

### Client: Pause Button

- Vedle Cancel tlačítka
- Když `running`: **Pause** (🟠 orange border)
- Když `paused`: **Resume** (🟢 green border)
- Když `queued`/`resuming`/`done`/`error`: žádné tlačítko

### Client: Cancel Button

- Stále viditelné u `running` i `paused` jobů
- Červené, stejné jako teď

### Client: Error Fallback Dialog

Pokud resume selže:
- `window.confirm('Segment vypršel. Chceš začít znovu od nuly?')`
- Ano → smaže soubor, restartuje bez seek
- Ne → job zůstane paused

---

## 2. Notifications

### Header Toggle

- Vedle nadpisu "MThree" — bell ikona
- Vizuální stavy:
  - 🔔 (zapnuto, notifikace povoleny a enabled)
  - 🔕 (vypnuto, user si sám vypnul)
  - ⚪ disabled (ještě nepotvrdil oprávnění v prohlížeči)
- Uloženo v `localStorage`: `mthree_notifications`

### Permission Flow

1. Kliknutí na 🔔/⚪ → `Notification.requestPermission()`
2. Pokud user zamítne → button zůstane disabled
3. Pokud user povolí → uloží se `mthree_notifications = 'granted'`
4. Následně může user přepínat mezi 🔔 a 🔕

### Notification Trigger

- Kdykoli job přejde do `done` stavu
- Text: "MThree — {filename} dokončeno ({fileSize})"
- Kliknutí na notifikaci → `window.focus()`

---

## 3. API Summary

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/api/pause/:jobId` | — | `{ ok: true }` nebo `400` |
| POST | `/api/resume/:jobId` | — | `{ ok: true }` nebo `400` |

Nové job fields:
```js
{
  outTime: number | null,      // sekundy, kam jsme dospali
  totalBytes: number | null,   // posledni total_size
  durationEstimate: number | null,
}
```

---

## 4. Log Format (append only)

```
[<ts>] [<jobId>] Paused at 1234.5s
[<ts>] [<jobId>] Resume attempted from 1234.5s
[<ts>] [<jobId>] Resume failed: segment expired
[<ts>] [<jobId>] Resume fallback: restarting from zero
```
