import { useState, useEffect, useRef } from 'react';

const POLL_INTERVAL = 2000;

function App() {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [queue, setQueue] = useState([]);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [notifState, setNotifState] = useState('default');
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState([]);
  const pollingRef = useRef(null);
  const prevJobStatesRef = useRef({});

  // ── Notification permission ─────────────────────────────────────────────────
  useEffect(() => {
    if (!('Notification' in window)) { setNotifState('disabled'); return; }
    const stored = localStorage.getItem('mthree_notifications');
    if (stored === 'granted') setNotifState('granted');
    else if (stored === 'denied') setNotifState('denied');
    else setNotifState('default');
  }, []);

  const sendNotification = (job) => {
    if (notifState !== 'granted') return;
    try {
      const n = new Notification('MThree', { body: `${job.filename} dokončeno (${job.fileSize || '?'})` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  };

  // ── Polling ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const doPoll = async () => {
      try {
        const res = await fetch('/api/queue');
        if (!res.ok) return;
        const data = await res.json();
        const serverJobs = data.jobs || [];

        serverJobs.forEach(j => {
          const prevState = prevJobStatesRef.current[j.id];
          if (prevState !== 'done' && j.state === 'done') sendNotification(j);
          prevJobStatesRef.current[j.id] = j.state;
        });

        setQueue(prev => {
          const serverMap = new Map(serverJobs.map(j => [j.id, j]));
          const localOnly = prev.filter(j => !serverMap.has(j.id) && !j.downloadUrl);
          return [...serverJobs, ...localOnly];
        });
      } catch {}
    };
    pollingRef.current = setInterval(doPoll, POLL_INTERVAL);
    return () => clearInterval(pollingRef.current);
  }, [notifState]);

  // ── LocalStorage persist ───────────────────────────────────────────────────
  useEffect(() => {
    try {
      const done = queue.filter(j => j.state === 'done');
      if (done.length > 0) localStorage.setItem('mthree_queue', JSON.stringify(done));
    } catch {}
  }, [queue]);

  // ── Fetch files ───────────────────────────────────────────────────────────
  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      setFiles(data.files || []);
    } catch {}
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    if (!url.trim() || !url.includes('.m3u8')) return;
    const proposedFilename = filename.trim() || `download_${Date.now().toString(36)}.mp4`;
    const alreadyDone = queue.find(j => j.filename === proposedFilename && j.state === 'done');
    if (alreadyDone) { alert(`"${proposedFilename}" already downloaded.`); return; }
    try {
      const res = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), filename: filename.trim() || undefined }),
      });
      if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
      const { jobId, filename: fn } = await res.json();
      setQueue(prev => [...prev, { id: jobId, url: url.trim(), filename: fn, state: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }]);
      setUrl(''); setFilename('');
    } catch (e) { alert('Network error: ' + e.message); }
  };

  const handleExtractMp3 = async (fname) => {
    try {
      const res = await fetch('/api/extract-mp3', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fname }),
      });
      if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
      const { jobId } = await res.json();
      setQueue(prev => [...prev, { id: jobId, sourceFile: fname, filename: fname.replace(/\.[^.]+$/, '.mp3'), type: 'extract-mp3', state: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }]);
      setShowFiles(false);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const handleTranscribe = async (fname) => {
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fname }),
      });
      if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
      const { jobId } = await res.json();
      const ext = fname.lastIndexOf('.') >= 0 ? fname.slice(fname.lastIndexOf('.')) : '';
      setQueue(prev => [...prev, { id: jobId, sourceFile: fname, filename: fname.replace(/\.[^.]+$/, '') + '.en.txt', type: 'transcribe', state: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }]);
      setShowFiles(false);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const handleTranslate = async (fname) => {
    try {
      const res = await fetch('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fname }),
      });
      if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
      const { jobId } = await res.json();
      setQueue(prev => [...prev, { id: jobId, sourceFile: fname, filename: fname.replace(/\.[^.]+$/, '') + '.cz.txt', type: 'translate', state: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }]);
      setShowFiles(false);
    } catch (e) { alert('Error: ' + e.message); }
  };

  const handlePause = async (jobId) => {
    try { await fetch(`/api/pause/${jobId}`, { method: 'POST' }); } catch {}
  };

  const handleResume = async (jobId) => {
    try {
      const res = await fetch(`/api/resume/${jobId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok && data.reason === 'segment_expired') {
        if (window.confirm('Segment vypršel. Začít znovu od nuly?')) {
          await fetch(`/api/job/${jobId}`, { method: 'DELETE' });
        }
      }
    } catch {}
  };

  const handleCancel = async (jobId) => {
    try { await fetch(`/api/job/${jobId}`, { method: 'DELETE' }); } catch {}
  };

  const handleRemove = (jobId) => setQueue(prev => prev.filter(j => j.id !== jobId));

  const handleCopyLink = async (link) => {
    try { await navigator.clipboard.writeText(window.location.origin + link); setCopyFeedback(true); setTimeout(() => setCopyFeedback(false), 2000); } catch {}
  };

  const handleNotifToggle = async () => {
    if (notifState === 'default') {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') { setNotifState('granted'); localStorage.setItem('mthree_notifications', 'granted'); }
      else { setNotifState('denied'); localStorage.setItem('mthree_notifications', 'denied'); }
    } else if (notifState === 'granted') {
      setNotifState('default'); localStorage.setItem('mthree_notifications', 'default');
    }
  };

  const handleFilesOpen = () => {
    fetchFiles();
    setShowFiles(true);
  };

  // ── Queue splits ───────────────────────────────────────────────────────────
  const runningJob = queue.find(j => j.state === 'running' || j.state === 'resuming');
  const pausedJob = queue.find(j => j.state === 'paused');
  const queuedJobs = queue.filter(j => j.state === 'queued');
  const completedJobs = queue.filter(j => j.state === 'done').slice(-10).reverse();
  const errorJobs = queue.filter(j => j.state === 'error');

  const notifIcon = notifState === 'granted' ? '🔔' : notifState === 'denied' ? '🔕' : '⚪';
  const notifDisabled = notifState === 'disabled' || notifState === 'denied';

  const jobTypeLabel = (type) => {
    if (type === 'extract-mp3') return 'MP3';
    if (type === 'transcribe') return 'Transcribe';
    if (type === 'translate') return 'Translate';
    return 'Download';
  };

  const jobTypeColor = (type) => {
    if (type === 'extract-mp3') return '#00bcd4';
    if (type === 'transcribe') return '#9c27b0';
    if (type === 'translate') return '#ff9800';
    return '#ff6b35';
  };

  return (
    <>
      {/* ── FILES MODAL ─────────────────────────────────────────────────────── */}
      {showFiles && (
        <div className="modal-overlay" onClick={() => setShowFiles(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📁 Downloaded Files</h2>
              <button className="btn btn-ghost" onClick={() => setShowFiles(false)}>✕</button>
            </div>
            {files.length === 0 ? (
              <p style={{color:'#888', textAlign:'center', padding:'2rem'}}>No files yet</p>
            ) : (
              <table className="files-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map(f => (
                    <tr key={f.name}>
                      <td>
                        <div className="file-name">{f.name}</div>
                        <div className="file-meta">{f.type} · {new Date(f.mtime).toLocaleDateString()}</div>
                      </td>
                      <td className="file-size">{f.size}</td>
                      <td>
                        <div className="file-actions">
                          {f.type === 'video' && (
                            <button className="btn btn-sm btn-mp3" onClick={() => handleExtractMp3(f.name)} title="Extract MP3">🎵 MP3</button>
                          )}
                          {(f.type === 'video' || f.type === 'audio') && (
                            <>
                              <button className="btn btn-sm btn-transcribe" onClick={() => handleTranscribe(f.name)} title="Transcribe to English">📝 EN</button>
                              <button className="btn btn-sm btn-translate" onClick={() => handleTranslate(f.name)} title="Translate to Czech">🇨🇿 CZ</button>
                            </>
                          )}
                          <a href={`/downloads/${f.name}`} download className="btn btn-sm btn-ghost">💾</a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-title">
          <h1>MThree</h1>
          <p>M3U8 → MP4 Downloader</p>
        </div>
        <div className="header-actions">
          <button className="notif-btn" onClick={handleFilesOpen} title="Browse files">📁</button>
          <button
            className={`notif-btn ${notifDisabled ? 'notif-btn--disabled' : ''}`}
            onClick={handleNotifToggle}
            disabled={notifDisabled}
            title={notifDisabled ? 'Not available' : notifState === 'granted' ? 'Notifications on' : notifState === 'denied' ? 'Blocked' : 'Enable notifications'}
          >
            {notifIcon}
          </button>
        </div>
      </header>

      {/* ── INPUT ───────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="input-section">
          <input type="text" placeholder="Paste .m3u8 URL here..." value={url}
            onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleDownload()} />
          <div className="input-row">
            <input type="text" placeholder="Filename (optional)" value={filename}
              onChange={e => setFilename(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleDownload()} />
            <button className="btn btn-primary" onClick={handleDownload} disabled={!url.includes('.m3u8')}>Download</button>
          </div>
        </div>
      </div>

      {/* ── RUNNING JOB ────────────────────────────────────────────────────── */}
      {runningJob && (
        <div className="card">
          <div className="progress-section">
            <div className="progress-header">
              <div className="progress-status">
                <span className="progress-dot" style={{background: jobTypeColor(runningJob.type)}}></span>
                <span>[{jobTypeLabel(runningJob.type)}]</span>
                <span>{runningJob.filename}</span>
              </div>
              <div className="progress-actions">
                {runningJob.type === 'download' && (
                  <button className="btn btn-warning" onClick={() => handlePause(runningJob.id)}>Pause</button>
                )}
                <button className="btn btn-danger" onClick={() => handleCancel(runningJob.id)}>Cancel</button>
              </div>
            </div>
            <div className="progress-bar-wrap">
              <div className="progress-bar" style={{ width: `${runningJob.progress || 0}%`, background: jobTypeColor(runningJob.type) }} />
            </div>
            <div className="progress-time">
              {runningJob.progress || 0}%{runningJob.message && runningJob.message !== 'Queued' ? ` — ${runningJob.message}` : ''}
            </div>
          </div>
        </div>
      )}

      {/* ── PAUSED JOB ──────────────────────────────────────────────────────── */}
      {pausedJob && (
        <div className="card">
          <div className="progress-section">
            <div className="progress-header">
              <div className="progress-status">
                <span className="progress-dot paused"></span>
                <span>[{jobTypeLabel(pausedJob.type)}]</span>
                <span>{pausedJob.filename}</span>
              </div>
              <div className="progress-actions">
                <button className="btn btn-success" onClick={() => handleResume(pausedJob.id)}>Resume</button>
                <button className="btn btn-danger" onClick={() => handleCancel(pausedJob.id)}>Cancel</button>
              </div>
            </div>
            <div className="progress-bar-wrap">
              <div className="progress-bar paused" style={{ width: `${pausedJob.progress || 0}%` }} />
            </div>
            <div className="progress-time">{pausedJob.progress || 0}% — Paused</div>
          </div>
        </div>
      )}

      {/* ── HISTORY ───────────────────────────────────────────────────────── */}
      {completedJobs.length > 0 && (
        <div className="card">
          <div className="card-title">History ({completedJobs.length})</div>
          <div className="queue-list">
            {completedJobs.map(job => (
              <div key={job.id} className="queue-item completed">
                <span className="completed-icon">✔</span>
                <span className="queue-item-name" title={job.filename}>
                  <span className="type-badge" style={{color: jobTypeColor(job.type)}}>[{jobTypeLabel(job.type)}]</span>
                  {job.filename}
                </span>
                <span className="queue-item-size">{job.fileSize || '—'}</span>
                <div className="queue-item-actions">
                  {job.downloadUrl && (
                    <a href={job.downloadUrl} download={job.filename} className="btn btn-ghost">↓</a>
                  )}
                  <button className="btn btn-ghost" onClick={() => handleCopyLink(job.downloadUrl)}>{copyFeedback ? '✓' : 'Link'}</button>
                  <button className="btn btn-danger" onClick={() => handleRemove(job.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── QUEUE ───────────────────────────────────────────────────────────── */}
      {queuedJobs.length > 0 && (
        <div className="card">
          <div className="card-title">Queue ({queuedJobs.length})</div>
          <div className="queue-list">
            {queuedJobs.map((job, i) => (
              <div key={job.id} className="queue-item">
                <span className="queue-item-num">{i + 1}.</span>
                <span className="queue-item-name">
                  <span className="type-badge" style={{color: jobTypeColor(job.type)}}>[{jobTypeLabel(job.type)}]</span>
                  {job.filename}
                </span>
                <span className="queue-item-status">{job.state}</span>
                <button className="btn btn-danger" onClick={() => handleRemove(job.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default App;
