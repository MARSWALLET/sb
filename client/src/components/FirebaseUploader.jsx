import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// FirebaseUploader.jsx
//
// Discovers screenshots from the server, shows NEW/processed tags, lets the
// user select one, set the league name, then runs the full 4-stage pipeline
// with real-time step-by-step SSE progress streaming.
// ─────────────────────────────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { id: 'md5',      icon: '🔍', label: 'Level 1 — MD5 Duplicate Check',        desc: 'Verifying file fingerprint against processed hash database' },
  { id: 'visual',   icon: '👁️',  label: 'Level 1.5 — Visual Image Recognition', desc: 'Offline perceptual hashing of the top 40% of the table image' },
  { id: 'gemini',   icon: '🧠', label: 'Gemini Vision AI Extraction',           desc: 'Extracting structured match data from screenshot' },
  { id: 'dedup',    icon: '🔄', label: 'Level 2 — Database Deduplication',      desc: 'Comparing extracted Game IDs against local JSON database' },
  { id: 'firebase', icon: '🔥', label: 'Firebase Firestore Upload',             desc: 'Batch uploading new records to Firebase cloud database' },
];

const LEAGUES = [
  'England - Virtual', 'Spain - Virtual', 'Italy - Virtual',
  'Germany - Virtual', 'France - Virtual',
];

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatTime(ms) {
  return new Date(ms).toLocaleString('en-NG', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default function FirebaseUploader({ active }) {
  const [screenshots, setScreenshots]   = useState([]);
  const [loadingList, setLoadingList]   = useState(true);
  const [selectedImg, setSelectedImg]   = useState(null);
  const [previewImg, setPreviewImg]     = useState(null);
  const [deletingFile, setDeletingFile] = useState(null);
  const [forceUpload, setForceUpload]   = useState(false);
  const [resettingHashes, setResettingHashes] = useState(false);
  const [syncRunning, setSyncRunning]   = useState(false);
  const [syncLogs, setSyncLogs]         = useState([]);
  const [syncResult, setSyncResult]     = useState(null);
  const [leagueName, setLeagueName]     = useState('England - Virtual');
  const [isRunning, setIsRunning]       = useState(false);
  const [stepStatus, setStepStatus]     = useState({});
  const [stepLogs, setStepLogs]         = useState({});
  const [finalResult, setFinalResult]   = useState(null);
  const [error, setError]               = useState(null);
  const logRef = useRef(null);

  // ── Load image list from server
  const loadScreenshots = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch('http://localhost:3001/api/screenshots');
      const data = await res.json();
      if (data.success) {
        setScreenshots(data.screenshots);
        console.log(`[FirebaseUploader] Loaded ${data.screenshots.length} screenshots, ${data.screenshots.filter(s => s.isNew).length} new`);
      }
    } catch (e) {
      console.error('[FirebaseUploader] Failed to load screenshot list:', e);
    }
    setLoadingList(false);
  }, []);

  // Reload whenever the tab becomes active
  useEffect(() => {
    if (active !== false) loadScreenshots();
  }, [active, loadScreenshots]);

  // ── Delete a screenshot from disk
  const handleDelete = async (img, e) => {
    e.stopPropagation(); // don't select the item
    if (!window.confirm(`Delete "${img.filename}"? This cannot be undone.`)) return;
    console.log(`[FirebaseUploader] Deleting screenshot: ${img.filename}`);
    setDeletingFile(img.filename);
    try {
      const res = await fetch(`http://localhost:3001/api/screenshots/${encodeURIComponent(img.filename)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        console.log(`[FirebaseUploader] Successfully deleted: ${img.filename}`);
        // Deselect if it was selected
        if (selectedImg?.filename === img.filename) setSelectedImg(null);
        if (previewImg?.filename === img.filename) setPreviewImg(null);
        // Refresh the list
        await loadScreenshots();
      } else {
        console.error('[FirebaseUploader] Delete failed:', data.error);
        setError(`Failed to delete: ${data.error}`);
      }
    } catch (err) {
      console.error('[FirebaseUploader] Delete fetch error:', err);
      setError('Could not connect to server to delete file.');
    }
    setDeletingFile(null);
  };

  const updateStep = (stepId, status, message) => {
    setStepStatus(prev => ({ ...prev, [stepId]: status }));
    if (message) {
      setStepLogs(prev => ({ ...prev, [stepId]: [...(prev[stepId] || []), message] }));
    }
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  };

  // ── Sync Local DB → Firebase (recovery for previously extracted but not uploaded data)
  const handleSync = async (leagueFilter) => {
    setSyncRunning(true);
    setSyncLogs([]);
    setSyncResult(null);
    const addLog = (msg) => setSyncLogs(prev => [...prev, msg]);
    console.log('[FirebaseUploader] Starting local DB → Firebase sync, filter:', leagueFilter || 'ALL');
    try {
      const res = await fetch('http://localhost:3001/api/sync-local-to-firebase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leagueFilter ? { leagueFilter } : {}),
      });
      if (!res.body) throw new Error('No SSE stream returned');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            console.log('[FirebaseUploader] Sync SSE:', event);
            if (event.type === 'progress') { addLog(event.message); }
            if (event.type === 'done') { setSyncResult(event); setSyncRunning(false); loadScreenshots(); return; }
            if (event.type === 'error') { addLog('❌ ' + event.message); setSyncRunning(false); return; }
          } catch (e) { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.error('[FirebaseUploader] Sync error:', err);
      addLog('❌ Network error: ' + err.message);
      setSyncRunning(false);
    }
  };

  const handleRun = async () => {
    if (!selectedImg) { setError('Please select a screenshot from the list above.'); return; }
    setIsRunning(true);
    setError(null);
    setFinalResult(null);
    setStepStatus({});
    setStepLogs({});

    console.log(`[FirebaseUploader] Starting pipeline for: ${selectedImg.filename} force=${forceUpload}`);

    try {
      const response = await fetch('http://localhost:3001/api/extract-and-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Auto-use dbLeague from metadata, fall back to manual selection
        body: JSON.stringify({
          imagePath: selectedImg.absolutePath,
          leagueName: selectedImg.dbLeague || leagueName,
          forceUpload, // pass force flag to bypass hash checks
        }),
      });

      if (!response.body) throw new Error('Server did not return a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentStep = 'init';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            console.log('[FirebaseUploader] SSE event:', event);

            if (event.type === 'done') {
              if (currentStep && currentStep !== 'init') updateStep(currentStep, 'done');
              setFinalResult(event);
              setIsRunning(false);
              // Refresh list so NEW tag updates
              loadScreenshots();
              return;
            }
            if (event.type === 'error') {
              if (currentStep && currentStep !== 'init') updateStep(currentStep, 'error', event.message);
              setError(event.message);
              setIsRunning(false);
              return;
            }
            if (event.type === 'progress') {
              if (currentStep !== event.step && event.step !== 'init') {
                if (currentStep && currentStep !== 'init') updateStep(currentStep, 'done');
                currentStep = event.step;
                updateStep(currentStep, 'active');
              }
              updateStep(event.step, 'active', event.message);
            }
          } catch (e) {
            console.warn('[FirebaseUploader] SSE parse error:', line, e);
          }
        }
      }
    } catch (err) {
      console.error('[FirebaseUploader] Fatal fetch error:', err);
      setError('Could not connect to the Node.js server on port 3001.');
      setIsRunning(false);
    }
  };

  const getStepStyle = (id) => {
    const s = stepStatus[id];
    if (s === 'active')  return { borderColor: 'var(--accent-neon)', background: 'rgba(0,255,136,0.06)', boxShadow: '0 0 12px rgba(0,255,136,0.15)' };
    if (s === 'done')    return { borderColor: 'rgba(0,255,136,0.4)', background: 'rgba(0,255,136,0.03)' };
    if (s === 'error')   return { borderColor: 'var(--accent-live)', background: 'rgba(255,50,50,0.08)' };
    return { borderColor: 'rgba(255,255,255,0.07)', background: 'transparent' };
  };

  const getStepIcon = (id, icon) => {
    if (stepStatus[id] === 'active') return <span style={{ animation: 'spin 1s infinite linear', display: 'inline-block' }}>⚙️</span>;
    if (stepStatus[id] === 'done')   return '✅';
    if (stepStatus[id] === 'error')  return '❌';
    return icon;
  };

  const newCount = screenshots.filter(s => s.isNew).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Full-Screen Preview Modal ────────────────────────────────────────── */}
      {previewImg && (
        <div
          onClick={() => setPreviewImg(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: '16px', cursor: 'zoom-out',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', maxWidth: '90vw' }}>
            <span style={{ color: 'var(--accent-neon)', fontWeight: 700, fontSize: '0.9rem' }}>
              📸 {previewImg.filename}
            </span>
            {previewImg.dbLeague && (
              <span style={{ background: 'rgba(0,255,136,0.15)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '20px', padding: '3px 10px', fontSize: '0.75rem', color: 'var(--accent-neon)' }}>
                {previewImg.dbLeague}
              </span>
            )}
            <button
              onClick={() => setPreviewImg(null)}
              style={{ marginLeft: 'auto', background: 'rgba(255,50,50,0.2)', border: '1px solid rgba(255,50,50,0.4)', color: '#ff6b6b', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 700 }}
            >
              ✕ Close
            </button>
          </div>
          <img
            src={`http://localhost:3001/api/screenshot-preview/${encodeURIComponent(previewImg.filename)}`}
            alt={previewImg.filename}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '80vh', objectFit: 'contain', borderRadius: '10px', boxShadow: '0 20px 60px rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)' }}
          />
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', margin: 0 }}>
            Click anywhere outside the image to close
          </p>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ borderLeft: '4px solid #ff6b35', padding: '18px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.8rem' }}>🔥</span>
            <div>
              <h3 style={{ margin: 0, color: '#ff9a6c', fontSize: '1.05rem' }}>Extract & Upload to Firebase</h3>
              <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.6 }}>
                4-stage pipeline: MD5 → Visual Hash → Gemini AI → Firestore
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {newCount > 0 && (
              <span style={{
                background: 'linear-gradient(135deg, #00ff88, #00cc6a)',
                color: '#000', fontSize: '0.72rem', fontWeight: 900,
                padding: '4px 10px', borderRadius: '20px',
              }}>
                {newCount} NEW
              </span>
            )}
            <button
              onClick={loadScreenshots}
              disabled={loadingList}
              style={{
                background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
                color: 'white', borderRadius: '8px', padding: '6px 14px',
                cursor: 'pointer', fontSize: '0.8rem',
              }}
            >
              {loadingList ? '↻ Refreshing...' : '↻ Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Sync Local DB → Firebase Panel ─────────────────────────── */}
      <div className="glass-panel" style={{ borderLeft: '4px solid #ffd700', padding: '18px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: syncLogs.length > 0 || syncResult ? '16px' : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.5rem' }}>🔄</span>
            <div>
              <h4 style={{ margin: 0, color: '#ffd700', fontSize: '0.95rem' }}>Sync Local DB → Firebase</h4>
              <p style={{ margin: 0, fontSize: '0.73rem', opacity: 0.55 }}>
                Push all records already extracted (but not yet uploaded) directly to Firestore. No Gemini tokens used.
              </p>
            </div>
          </div>
          <button
            onClick={() => handleSync(null)}
            disabled={syncRunning || isRunning}
            style={{
              background: syncRunning ? 'rgba(255,215,0,0.1)' : 'linear-gradient(135deg, #ffd700, #ffaa00)',
              color: syncRunning ? 'rgba(255,255,255,0.4)' : '#000',
              border: syncRunning ? '1px solid rgba(255,215,0,0.3)' : 'none',
              borderRadius: '10px', padding: '10px 20px',
              cursor: syncRunning || isRunning ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem', fontWeight: 900, transition: 'all 0.3s ease', whiteSpace: 'nowrap',
              boxShadow: !syncRunning && !isRunning ? '0 4px 15px rgba(255,215,0,0.3)' : 'none',
            }}
          >
            {syncRunning ? '⏳ Syncing...' : '🚀 Push All to Firebase'}
          </button>
        </div>

        {/* Live sync log */}
        {(syncLogs.length > 0 || syncRunning) && (
          <div style={{
            background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '10px 14px',
            maxHeight: '120px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.72rem',
            display: 'flex', flexDirection: 'column', gap: '3px', border: '1px solid rgba(255,215,0,0.1)',
          }}>
            {syncRunning && <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <div className="spinner" style={{ width: 14, height: 14, border: '2px solid rgba(255,215,0,0.2)', borderTop: '2px solid #ffd700', flexShrink: 0 }} />
              <span style={{ color: '#ffd700', fontSize: '0.72rem' }}>Syncing to Firebase...</span>
            </div>}
            {syncLogs.map((log, i) => (
              <span key={i} style={{ color: log.startsWith('❌') ? '#ff6b6b' : 'rgba(255,255,255,0.75)' }}>{log}</span>
            ))}
          </div>
        )}

        {/* Sync result */}
        {syncResult && !syncRunning && (
          <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px' }}>
            {[
              { label: 'Total Records', value: syncResult.total, color: '#ffd700' },
              { label: 'Uploaded', value: syncResult.uploaded, color: 'var(--accent-neon)' },
              { label: 'Skipped', value: syncResult.skipped, color: 'rgba(255,255,255,0.4)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                <p style={{ margin: '0 0 3px', fontSize: '1.3rem', fontWeight: 900, color }}>{value}</p>
                <p style={{ margin: 0, fontSize: '0.67rem', opacity: 0.5 }}>{label}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Screenshot Gallery ──────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '18px 24px' }}>
        <h4 style={{ margin: '0 0 14px', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>
          📂 Available Screenshots — Select one to process
        </h4>

        {loadingList ? (
          <div style={{ textAlign: 'center', padding: '30px', opacity: 0.5 }}>
            <div className="spinner" style={{ width: 24, height: 24, border: '3px solid rgba(255,255,255,0.1)', borderTop: '3px solid var(--accent-neon)', margin: '0 auto 10px' }} />
            <p style={{ margin: 0, fontSize: '0.82rem' }}>Scanning for screenshots...</p>
          </div>
        ) : screenshots.length === 0 ? (
          <p style={{ opacity: 0.5, textAlign: 'center', padding: '20px', fontSize: '0.85rem' }}>
            No screenshots found. Capture one from the Previous Results tab first.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto', paddingRight: '4px' }}>
            {screenshots.map(img => {
              const isSelected = selectedImg?.filename === img.filename;
              const isDeleting = deletingFile === img.filename;
              return (
                <div
                  key={img.filename}
                  onClick={() => !isRunning && !isDeleting && setSelectedImg(img)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '10px 12px', borderRadius: '10px',
                    cursor: isRunning || isDeleting ? 'not-allowed' : 'pointer',
                    border: isSelected ? '1px solid var(--accent-neon)' : '1px solid rgba(255,255,255,0.08)',
                    background: isSelected ? 'rgba(0,255,136,0.07)' : 'rgba(255,255,255,0.03)',
                    textAlign: 'left', transition: 'all 0.2s ease',
                    boxShadow: isSelected ? '0 0 10px rgba(0,255,136,0.12)' : 'none',
                    opacity: isDeleting ? 0.4 : 1,
                  }}
                >
                  {/* Thumbnail preview */}
                  <div
                    onClick={e => { e.stopPropagation(); setPreviewImg(img); }}
                    title="Click to preview"
                    style={{
                      width: 52, height: 40, flexShrink: 0, borderRadius: '6px',
                      background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)',
                      overflow: 'hidden', cursor: 'zoom-in', position: 'relative',
                    }}
                  >
                    <img
                      src={`http://localhost:3001/api/screenshot-preview/${encodeURIComponent(img.filename)}`}
                      alt="preview"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                    <span style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: '1rem', opacity: 0.4,
                    }}>🔍</span>
                  </div>

                  {/* Name + meta */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700,
                      color: isSelected ? 'var(--accent-neon)' : 'white',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {img.filename}
                    </p>
                    <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.5, fontFamily: 'monospace' }}>
                      {formatTime(img.capturedAt)} · {formatSize(img.sizeBytes)}
                      {img.dbLeague && <span style={{ color: 'var(--accent-neon)', opacity: 0.8 }}> · {img.dbLeague}</span>}
                      {img.date && <span style={{ color: '#ffd700', opacity: 0.7 }}> · 📅 {img.date}</span>}
                      {!img.hasMeta && <span style={{ color: '#ff9a6c', opacity: 0.7 }}> · ⚠️ no metadata</span>}
                    </p>
                  </div>

                  {/* NEW/DONE Tag */}
                  {img.isNew ? (
                    <span style={{
                      background: 'linear-gradient(135deg, #00ff88, #00cc6a)', color: '#000',
                      fontSize: '0.62rem', fontWeight: 900, padding: '3px 8px',
                      borderRadius: '20px', flexShrink: 0,
                    }}>NEW</span>
                  ) : (
                    <span style={{
                      background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)',
                      fontSize: '0.62rem', fontWeight: 700, padding: '3px 8px',
                      borderRadius: '20px', flexShrink: 0,
                    }}>DONE</span>
                  )}

                  {/* Delete button */}
                  <button
                    onClick={e => handleDelete(img, e)}
                    disabled={isRunning || isDeleting}
                    title={`Delete ${img.filename}`}
                    style={{
                      background: 'rgba(255,50,50,0.1)', border: '1px solid rgba(255,50,50,0.25)',
                      color: '#ff6b6b', borderRadius: '8px', padding: '5px 9px',
                      cursor: isRunning || isDeleting ? 'not-allowed' : 'pointer',
                      fontSize: '0.78rem', flexShrink: 0, transition: 'all 0.2s ease',
                      lineHeight: 1,
                    }}
                    onMouseEnter={e => { if (!isRunning) e.target.style.background = 'rgba(255,50,50,0.25)'; }}
                    onMouseLeave={e => { e.target.style.background = 'rgba(255,50,50,0.1)'; }}
                  >
                    {isDeleting ? '...' : '🗑️'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── League + Run Button ─────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* League: auto-detected from metadata OR manual fallback */}
        <div>
          <label style={{ fontSize: '0.78rem', opacity: 0.7, display: 'block', marginBottom: '8px' }}>🏆 League (injected into every database record)</label>
          {selectedImg?.dbLeague ? (
            // Auto-detected from .meta.json
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{
                background: 'linear-gradient(135deg, rgba(0,255,136,0.15), rgba(0,204,106,0.08))',
                border: '1px solid rgba(0,255,136,0.3)', borderRadius: '20px',
                padding: '6px 16px', fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent-neon)',
              }}>
                ✅ {selectedImg.dbLeague}
              </span>
              <span style={{ fontSize: '0.72rem', opacity: 0.45 }}>Auto-detected from screenshot metadata</span>
            </div>
          ) : (
            // Fallback: manual selection (for screenshots without metadata)
            <div>
              <p style={{ margin: '0 0 8px', fontSize: '0.72rem', color: '#ff9a6c' }}>
                ⚠️ No metadata found for this image — please select the league manually:
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {LEAGUES.map(lg => (
                  <button key={lg} onClick={() => !isRunning && setLeagueName(lg)} disabled={isRunning}
                    style={{
                      background: leagueName === lg ? 'var(--accent-neon)' : 'transparent',
                      color: leagueName === lg ? '#000' : 'white',
                      border: '1px solid var(--accent-neon)', padding: '6px 14px',
                      borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold',
                      fontSize: '0.78rem', transition: 'all 0.2s ease', opacity: isRunning ? 0.5 : 1,
                    }}>
                    {lg.replace(' - Virtual', '')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Selected image info + preview */}
        {selectedImg && (
          <div style={{
            background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.15)',
            borderRadius: '8px', overflow: 'hidden',
          }}>
            {/* Preview thumbnail bar */}
            <div
              onClick={() => setPreviewImg(selectedImg)}
              title="Click to view full screenshot"
              style={{
                position: 'relative', height: '100px', background: '#050505',
                cursor: 'zoom-in', overflow: 'hidden',
                borderBottom: '1px solid rgba(0,255,136,0.1)',
              }}
            >
              <img
                src={`http://localhost:3001/api/screenshot-preview/${encodeURIComponent(selectedImg.filename)}`}
                alt="Screenshot preview"
                style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }}
                onError={e => { e.target.style.display = 'none'; }}
              />
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', background: 'rgba(0,0,0,0.3)',
                color: 'white', fontSize: '0.78rem', fontWeight: 700, gap: '6px',
              }}>
                <span>🔍</span> Click to expand
              </div>
            </div>
            <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>📸</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--accent-neon)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedImg.filename}
                </p>
                <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.5 }}>
                  {formatTime(selectedImg.capturedAt)} · {formatSize(selectedImg.sizeBytes)}
                  {selectedImg.dbLeague && ` · ${selectedImg.dbLeague}`}
                  {selectedImg.date && ` · ${selectedImg.date}`}
                </p>
              </div>
              {selectedImg.isNew && (
                <span style={{ background: 'linear-gradient(135deg, #00ff88, #00cc6a)', color: '#000', fontSize: '0.65rem', fontWeight: 900, padding: '3px 8px', borderRadius: '20px' }}>
                  NEW
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Force Upload Toggle + Reset Hashes ────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Force Upload toggle */}
          <button
            onClick={() => setForceUpload(v => !v)}
            disabled={isRunning}
            title="Bypasses MD5 and visual hash checks. Gemini + level 2 dedup still runs."
            style={{
              flex: 1,
              background: forceUpload
                ? 'linear-gradient(135deg, rgba(255,200,0,0.2), rgba(255,150,0,0.1))'
                : 'rgba(255,255,255,0.04)',
              border: forceUpload ? '1px solid rgba(255,200,0,0.5)' : '1px solid rgba(255,255,255,0.1)',
              color: forceUpload ? '#ffd700' : 'rgba(255,255,255,0.5)',
              borderRadius: '10px', padding: '10px 14px',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              fontSize: '0.82rem', fontWeight: 700, transition: 'all 0.2s ease',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <span style={{ fontSize: '1rem' }}>{forceUpload ? '⚡' : '🔒'}</span>
            {forceUpload ? 'Force Upload ON — Hash checks bypassed' : 'Force Upload OFF — Hashes active'}
          </button>

          {/* Reset Visual Hashes */}
          <button
            onClick={async () => {
              if (!window.confirm('Clear the visual hash database? Screenshots will no longer be blocked as "visually similar". Match data is safe.')) return;
              setResettingHashes(true);
              try {
                const res = await fetch('http://localhost:3001/api/reset-visual-hashes', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                  console.log('[FirebaseUploader] Visual hashes reset:', data.message);
                  setError(null);
                  // Show as a brief success in the error slot
                  setFinalResult(prev => prev ? { ...prev, hashNote: data.message } : null);
                  alert(`✅ ${data.message}`);
                } else {
                  setError('Reset failed: ' + data.error);
                }
              } catch (err) {
                console.error('[FirebaseUploader] Reset error:', err);
                setError('Could not connect to server to reset hashes.');
              }
              setResettingHashes(false);
            }}
            disabled={isRunning || resettingHashes}
            title="Clears the visual hash DB so similar screenshots are no longer blocked. Safe — does not delete match data."
            style={{
              background: 'rgba(255,50,100,0.08)', border: '1px solid rgba(255,50,100,0.2)',
              color: '#ff6b9d', borderRadius: '10px', padding: '10px 14px',
              cursor: isRunning || resettingHashes ? 'not-allowed' : 'pointer',
              fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap',
              transition: 'all 0.2s ease',
            }}
          >
            {resettingHashes ? '↻ Clearing...' : '🔄 Reset Visual Hashes'}
          </button>
        </div>

        {/* Force warning banner */}
        {forceUpload && (
          <div style={{
            background: 'rgba(255,200,0,0.07)', border: '1px solid rgba(255,200,0,0.25)',
            borderRadius: '8px', padding: '10px 14px',
            display: 'flex', alignItems: 'flex-start', gap: '8px',
          }}>
            <span>⚡</span>
            <p style={{ margin: 0, fontSize: '0.75rem', color: '#ffd700', lineHeight: 1.5 }}>
              <strong>Force Upload mode:</strong> MD5 and visual hash checks are bypassed.
              Gemini AI will still extract data, and Level 2 Game ID dedup will still prevent
              exact duplicate records from being written to Firebase.
            </p>
          </div>
        )}

        <button
          id="firebase-run-btn"
          onClick={handleRun}
          disabled={isRunning || !selectedImg}
          style={{
            width: '100%',
            background: isRunning ? 'rgba(255,107,53,0.2)' : !selectedImg ? 'rgba(255,255,255,0.06)'
              : forceUpload ? 'linear-gradient(135deg, #ffd700, #ff9a00)'
              : 'linear-gradient(135deg, #ff6b35, #ff9a6c)',
            color: (!selectedImg || isRunning) ? 'rgba(255,255,255,0.35)' : '#000',
            border: (!selectedImg || isRunning) ? '1px solid rgba(255,255,255,0.1)' : 'none',
            borderRadius: '10px', padding: '14px', fontSize: '0.95rem', fontWeight: '900',
            cursor: (!selectedImg || isRunning) ? 'not-allowed' : 'pointer',
            boxShadow: selectedImg && !isRunning
              ? forceUpload ? '0 4px 20px rgba(255,200,0,0.35)' : '0 4px 20px rgba(255,107,53,0.35)'
              : 'none',
            transition: 'all 0.3s ease',
          }}
        >
          {isRunning ? '⚙️ Pipeline Running...'
            : !selectedImg ? '← Select a screenshot first'
            : forceUpload ? '⚡ Force Upload & Extract'
            : '🚀 Run Extract & Upload Pipeline'}
        </button>
      </div>

      {/* ── Live Pipeline Monitor ───────────────────────────────────────────── */}
      {(isRunning || Object.keys(stepStatus).length > 0) && (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '18px 24px' }}>
          <h4 style={{ margin: '0 0 6px', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>
            📡 Live Pipeline Monitor
          </h4>

          {isRunning && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'rgba(0,255,136,0.04)', borderRadius: '10px', border: '1px solid rgba(0,255,136,0.15)', marginBottom: '4px' }}>
              <div className="spinner" style={{ width: 22, height: 22, border: '3px solid rgba(0,255,136,0.15)', borderTop: '3px solid var(--accent-neon)', flexShrink: 0 }} />
              <div>
                <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--accent-neon)', fontWeight: 700 }}>Processing...</p>
                <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.6 }}>
                  {PIPELINE_STEPS.find(s => stepStatus[s.id] === 'active')?.desc || 'Initializing pipeline'}
                </p>
              </div>
            </div>
          )}

          {PIPELINE_STEPS.map(step => (
            <div key={step.id} style={{
              border: '1px solid', borderRadius: '10px', padding: '12px 16px',
              transition: 'all 0.3s ease', ...getStepStyle(step.id),
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: stepLogs[step.id]?.length ? '8px' : 0 }}>
                <span style={{ fontSize: '1.1rem', minWidth: 24 }}>{getStepIcon(step.id, step.icon)}</span>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 700 }}>{step.label}</p>
                  {!stepStatus[step.id] && (
                    <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.4 }}>{step.desc}</p>
                  )}
                </div>
                <span style={{ fontSize: '0.68rem', opacity: 0.4, fontFamily: 'monospace' }}>
                  {stepStatus[step.id] === 'active' ? 'RUNNING' : stepStatus[step.id]?.toUpperCase() || 'WAITING'}
                </span>
              </div>

              {stepLogs[step.id]?.length > 0 && (
                <div ref={logRef} style={{
                  maxHeight: '80px', overflowY: 'auto',
                  background: 'rgba(0,0,0,0.3)', borderRadius: '6px', padding: '6px 10px',
                  fontFamily: 'monospace', fontSize: '0.71rem', display: 'flex', flexDirection: 'column', gap: '2px',
                }}>
                  {stepLogs[step.id].map((log, i) => (
                    <span key={i} style={{ color: stepStatus[step.id] === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.75)' }}>
                      {log}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Final Result ────────────────────────────────────────────────────── */}
      {finalResult && !isRunning && (
        <div className="glass-panel" style={{
          borderLeft: finalResult.skipped ? '4px solid #ffd700' : '4px solid var(--accent-neon)',
          padding: '18px 24px',
        }}>
          {finalResult.skipped ? (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '1.4rem' }}>⏭️</span>
              <div>
                <h4 style={{ margin: '0 0 4px', color: '#ffd700' }}>Duplicate Detected — Upload Skipped</h4>
                <p style={{ margin: 0, fontSize: '0.82rem', opacity: 0.75 }}>{finalResult.reason}</p>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontSize: '1.5rem' }}>🎉</span>
                <div>
                  <h4 style={{ margin: '0 0 2px', color: 'var(--accent-neon)' }}>Pipeline Complete!</h4>
                  <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.65 }}>All stages passed. Data is now live in Firebase Firestore.</p>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}>
                {[
                  { label: 'New Records', value: finalResult.newRecords, color: 'var(--accent-neon)' },
                  { label: 'Uploaded to Firebase', value: finalResult.uploaded, color: '#ff9a6c' },
                  { label: 'Duplicates Skipped', value: finalResult.dupeCount ?? 0, color: 'rgba(255,255,255,0.4)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                    <p style={{ margin: '0 0 4px', fontSize: '1.5rem', fontWeight: 900, color }}>{value}</p>
                    <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.55 }}>{label}</p>
                  </div>
                ))}
              </div>
              {finalResult.model && (
                <p style={{ marginTop: '10px', fontSize: '0.7rem', opacity: 0.4, textAlign: 'center', fontFamily: 'monospace' }}>
                  Extracted by: {finalResult.model}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Error Banner ────────────────────────────────────────────────────── */}
      {error && !isRunning && (
        <div className="glass-panel history-error" style={{ marginTop: 0 }}>
          <div className="history-error-icon">⚠️</div>
          <div>
            <h4 className="history-error-title">Pipeline Error</h4>
            <p className="history-error-body">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
