import { useState, useEffect, useRef } from 'react';

const POLL_INTERVAL = 2000;

function App() {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [queue, setQueue] = useState([]);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [notifState, setNotifState] = useState('default'); // 'default' | 'granted' | 'denied' | 'disabled'
  const pollingRef = useRef(null);

  // Load queue from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('mthree_queue');
      if (saved) {
        const parsed = JSON.parse(saved);
        setQueue(parsed.map(j => ({
          ...j,
          state: j.state === 'running' ? 'queued' : j.state,
          progress: j.state === 'running' ? 0 : j.progress,
        })));
      }
    } catch {}
  }, []);

  // Notification permission check
  useEffect(() => {
    if (!('Notification' in window)) {
      setNotifState('disabled');
      return;
    }
    const stored = localStorage.getItem('mthree_notifications');
    if (stored === 'granted') {
      setNotifState('granted');
    } else if (stored === 'denied') {
      setNotifState('denied');
    } else {
      setNotifState('default');
    }
  }, []);

  // Send notification for a done job
  const sendNotification = (job) => {
    if (notifState !== 'granted') return;
    try {
      const n = new Notification('MThree', {
        body: `${job.filename} dokončeno (${job.fileSize || '?'})`,
        icon: '',
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  };

  // Track previous job states to detect transitions to 'done'
  const prevJobStatesRef = useRef({});

  // Polling — runs continuously to sync with server state
  useEffect(() => {
    const doPoll = async () => {
      try {
        const res = await fetch('/api/queue');
        if (!res.ok) return;
        const data = await res.json();
        const serverJobs = data.jobs || [];

        setQueue(prev => {
          // Server is source of truth for all job states
          const serverMap = new Map(serverJobs.map(j => [j.id, j]));

          // Detect newly completed jobs
          serverJobs.forEach(j => {
            const prevState = prevJobStatesRef.current[j.id];
            if (prevState !== 'done' && j.state === 'done') {
              sendNotification(j);
            }
            prevJobStatesRef.current[j.id] = j.state;
          });

          // Keep jobs that were just added locally but server hasn't picked up yet
          const localOnly = prev.filter(j => !serverMap.has(j.id) && !j.downloadUrl);
          return [...serverJobs, ...localOnly];
        });
      } catch {}
    };

    pollingRef.current = setInterval(doPoll, POLL_INTERVAL);
    return () => clearInterval(pollingRef.current);
  }, [notifState]); // notifState in deps so callback has latest

  // Persist queue to localStorage (only completed jobs for history)
  useEffect(() => {
    try {
      const done = queue.filter(j => j.state === 'done');
      if (done.length > 0) {
        localStorage.setItem('mthree_queue', JSON.stringify(done));
      }
    } catch {}
  }, [queue]);

  const handleDownload = async () => {
    if (!url.trim() || !url.includes('.m3u8')) return;

    const proposedFilename = filename.trim() || `download_${Date.now().toString(36)}.mp4`;
    const alreadyDone = queue.find(j => j.filename === proposedFilename && j.state === 'done');
    if (alreadyDone) {
      alert(`"${proposedFilename}" already downloaded. Delete it from History first.`);
      return;
    }

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          filename: filename.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to start download');
        return;
      }

      const { jobId, filename: serverFilename } = await res.json();
      const finalFilename = serverFilename || proposedFilename;
      const job = {
        id: jobId,
        url: url.trim(),
        filename: finalFilename,
        state: 'queued',
        progress: 0,
        message: 'Queued',
        createdAt: Date.now(),
      };

      setQueue(prev => [...prev, job]);
      setUrl('');
      setFilename('');
    } catch (e) {
      alert('Network error: ' + e.message);
    }
  };

  const handlePause = async (jobId) => {
    try {
      await fetch(`/api/pause/${jobId}`, { method: 'POST' });
    } catch {}
  };

  const handleResume = async (jobId) => {
    try {
      const res = await fetch(`/api/resume/${jobId}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok && data.reason === 'segment_expired') {
        const restart = window.confirm('Segment vypršel. Chceš začít znovu od nuly?');
        if (restart) {
          // Cancel and re-add
          await fetch(`/api/job/${jobId}`, { method: 'DELETE' });
        }
        // else — job stays paused
      }
    } catch {}
  };

  const handleCancel = async (jobId) => {
    try {
      await fetch(`/api/job/${jobId}`, { method: 'DELETE' });
      setQueue(prev => prev.filter(j => j.id !== jobId));
    } catch {}
  };

  const handleRemove = (jobId) => {
    setQueue(prev => prev.filter(j => j.id !== jobId));
  };

  const handleCopyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + link);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {}
  };

  const handleNotifToggle = async () => {
    if (notifState === 'default') {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        setNotifState('granted');
        localStorage.setItem('mthree_notifications', 'granted');
      } else {
        setNotifState('denied');
        localStorage.setItem('mthree_notifications', 'denied');
      }
    } else if (notifState === 'granted') {
      setNotifState('default');
      localStorage.setItem('mthree_notifications', 'default');
    } else if (notifState === 'denied') {
      // Can't re-request, just show denied state
    }
  };

  const runningJob = queue.find(j => j.state === 'running' || j.state === 'resuming');
  const pausedJob = queue.find(j => j.state === 'paused');
  const queuedJobs = queue.filter(j => j.state === 'queued');
  const completedJobs = queue.filter(j => j.state === 'done').slice(-10).reverse();
  const errorJobs = queue.filter(j => j.state === 'error');

  const notifIcon = notifState === 'granted' ? '🔔' : notifState === 'denied' ? '🔕' : '⚪';
  const notifDisabled = notifState === 'disabled' || notifState === 'denied';

  return (
    <>
      <header className="header">
        <div className="header-title">
          <h1>MThree</h1>
          <p>M3U8 → MP4 Downloader</p>
        </div>
        <button
          className={`notif-btn ${notifDisabled ? 'notif-btn--disabled' : ''}`}
          onClick={handleNotifToggle}
          disabled={notifDisabled}
          title={notifDisabled ? 'Notifications not available' : notifState === 'granted' ? 'Notifications on' : notifState === 'denied' ? 'Notifications blocked' : 'Enable notifications'}
        >
          {notifIcon}
        </button>
      </header>

      {/* INPUT SECTION */}
      <div className="card">
        <div className="input-section">
          <input
            type="text"
            placeholder="Paste .m3u8 URL here..."
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleDownload()}
          />
          <div className="input-row">
            <input
              type="text"
              placeholder="Filename (optional)"
              value={filename}
              onChange={e => setFilename(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleDownload()}
            />
            <button
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={!url.includes('.m3u8')}
            >
              Download
            </button>
          </div>
        </div>
      </div>

      {/* ACTIVE JOB */}
      {runningJob && (
        <div className="card">
          <div className="progress-section">
            <div className="progress-header">
              <div className="progress-status">
                <span className="progress-dot"></span>
                <span>{runningJob.filename}</span>
              </div>
              <div className="progress-actions">
                <button className="btn btn-warning" onClick={() => handlePause(runningJob.id)}>
                  Pause
                </button>
                <button className="btn btn-danger" onClick={() => handleCancel(runningJob.id)}>
                  Cancel
                </button>
              </div>
            </div>
            <div className="progress-bar-wrap">
              <div
                className="progress-bar"
                style={{ width: `${runningJob.progress || 0}%` }}
              />
            </div>
            <div className="progress-time">
              {runningJob.progress || 0}%
              {runningJob.message && !['Queued', 'Converting...', 'Done'].includes(runningJob.message)
                ? ` — ${runningJob.message}`
                : ''}
            </div>
          </div>
        </div>
      )}

      {/* PAUSED JOB */}
      {pausedJob && (
        <div className="card">
          <div className="progress-section">
            <div className="progress-header">
              <div className="progress-status">
                <span className="progress-dot paused"></span>
                <span>{pausedJob.filename}</span>
              </div>
              <div className="progress-actions">
                <button className="btn btn-success" onClick={() => handleResume(pausedJob.id)}>
                  Resume
                </button>
                <button className="btn btn-danger" onClick={() => handleCancel(pausedJob.id)}>
                  Cancel
                </button>
              </div>
            </div>
            <div className="progress-bar-wrap">
              <div
                className="progress-bar paused"
                style={{ width: `${pausedJob.progress || 0}%` }}
              />
            </div>
            <div className="progress-time">
              {pausedJob.progress || 0}% — Paused
            </div>
          </div>
        </div>
      )}

      {/* HISTORY */}
      {completedJobs.length > 0 && (
        <div className="card">
          <div className="card-title">History ({completedJobs.length})</div>
          <div className="queue-list">
            {completedJobs.map(job => (
              <div key={job.id} className="queue-item completed">
                <span className="completed-icon">✔</span>
                <span className="queue-item-name" title={job.filename}>{job.filename}</span>
                <span className="queue-item-size">{job.fileSize || '—'}</span>
                <div className="queue-item-actions">
                  <a
                    href={job.downloadUrl}
                    download={job.filename}
                    className="btn btn-ghost"
                  >
                    ↓
                  </a>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleCopyLink(job.downloadUrl)}
                  >
                    {copyFeedback ? '✓' : 'Link'}
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => handleRemove(job.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QUEUE */}
      {queuedJobs.length > 0 && (
        <div className="card">
          <div className="card-title">Queue ({queuedJobs.length})</div>
          <div className="queue-list">
            {queuedJobs.map((job, i) => (
              <div key={job.id} className="queue-item">
                <span className="queue-item-num">{i + 1}.</span>
                <span className="queue-item-name" title={job.filename}>{job.filename}</span>
                <span className="queue-item-status">queued</span>
                <button
                  className="btn btn-danger"
                  onClick={() => handleRemove(job.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default App;
