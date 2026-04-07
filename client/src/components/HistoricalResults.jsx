import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// HistoricalResults.jsx
//
// 1. Capture screenshot of any vFootball league on any date.
// 2. After capture, an inline "Upload to Firebase" panel appears immediately.
// 3. A persistent reminder banner shows if there are unuploaded screenshots.
// 4. Full 4-stage SSE pipeline runs inline — no need to switch tabs.
// ─────────────────────────────────────────────────────────────────────────────

const LEAGUES = ['England League', 'Spain League', 'Italy League', 'Germany League', 'France League'];
const DB_LEAGUE_NAMES = {
  'England League': 'England - Virtual',
  'Spain League':   'Spain - Virtual',
  'Italy League':   'Italy - Virtual',
  'Germany League': 'Germany - Virtual',
  'France League':  'France - Virtual',
};

const PIPELINE_STEPS = [
  { id: 'md5',      icon: '🔍', label: 'Level 1 — MD5 Duplicate Check',        desc: 'Verifying file fingerprint against processed hash database' },
  { id: 'visual',   icon: '👁️',  label: 'Level 1.5 — Visual Image Recognition', desc: 'Offline perceptual hashing of the top 40% of the table image' },
  { id: 'gemini',   icon: '🧠', label: 'Gemini Vision AI Extraction',           desc: 'Extracting structured match data using Gemini Vision' },
  { id: 'dedup',    icon: '🔄', label: 'Level 2 — Database Deduplication',      desc: 'Comparing extracted Game IDs against local JSON database' },
  { id: 'firebase', icon: '🔥', label: 'Firebase Firestore Upload',             desc: 'Batch uploading new records to Firebase cloud database' },
];

export default function HistoricalResults() {
  const [selectedLeague, setSelectedLeague] = useState(LEAGUES[0]);
  // Default to today so captures always have a date unless user manually clears it
  const todayISO = new Date().toISOString().split('T')[0]; // e.g. "2026-04-07"
  const [targetDate, setTargetDate]         = useState(todayISO);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);
  const [resultData, setResultData]         = useState(null);
  const [showHowTo, setShowHowTo]           = useState(false);
  const [pendingCount, setPendingCount]     = useState(0);

  // Firebase upload state (inline)
  const [uploadReady, setUploadReady]       = useState(null); // { path, league }
  const [isUploading, setIsUploading]       = useState(false);
  const [stepStatus, setStepStatus]         = useState({});
  const [stepLogs, setStepLogs]             = useState({});
  const [uploadResult, setUploadResult]     = useState(null);
  const [uploadError, setUploadError]       = useState(null);
  const logRef = useRef(null);

  // Poll for pending (unprocessed) screenshot count
  const checkPending = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:3001/api/screenshots');
      const data = await res.json();
      if (data.success) {
        setPendingCount(data.screenshots.filter(s => s.isNew).length);
      }
    } catch (e) {
      console.warn('[HistoricalResults] Could not check pending count:', e.message);
    }
  }, []);

  useEffect(() => {
    checkPending();
  }, [checkPending]);

  // ── Capture Screenshot
  const handleFetchResults = async () => {
    setLoading(true);
    setError(null);
    setResultData(null);
    setUploadReady(null);
    setUploadResult(null);
    setUploadError(null);
    setStepStatus({});
    setStepLogs({});
    console.log(`[HistoricalResults] Capturing: ${selectedLeague} date=${targetDate || 'today'}`);

    try {
      const params = new URLSearchParams({ league: selectedLeague });
      if (targetDate) params.append('date', targetDate);
      const response = await fetch(`http://localhost:3001/api/vfootball/screenshot-results?${params}`);

      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Server failed to capture screenshot');

      setResultData({
        league: data.league,
        image: data.base64Image,
        rawText: data.rawText,
        matchData: data.matchData || [],
      });

      // Pre-fill the upload panel with the freshly captured image
      if (data.screenshotPath) {
        setUploadReady({
          path: data.screenshotPath,
          league: DB_LEAGUE_NAMES[selectedLeague] || selectedLeague,
        });
        console.log(`[HistoricalResults] Screenshot saved at: ${data.screenshotPath} — ready to upload`);
      }

      // Refresh pending count
      await checkPending();

    } catch (err) {
      console.error('[Firebase Index Debug/Error Details]: [HistoricalResults]', err.message);
      setError(err.message || 'Error communicating with the backend server.');
    } finally {
      setLoading(false);
    }
  };

  // ── Firebase Upload (inline SSE pipeline)
  const updateStep = (stepId, status, message) => {
    setStepStatus(prev => ({ ...prev, [stepId]: status }));
    if (message) setStepLogs(prev => ({ ...prev, [stepId]: [...(prev[stepId] || []), message] }));
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  };

  const handleUpload = async () => {
    if (!uploadReady) return;
    setIsUploading(true);
    setUploadError(null);
    setUploadResult(null);
    setStepStatus({});
    setStepLogs({});
    console.log('[HistoricalResults] Starting inline Firebase upload pipeline...');

    try {
      const response = await fetch('http://localhost:3001/api/extract-and-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePath: uploadReady.path, leagueName: uploadReady.league }),
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
            if (event.type === 'done') {
              if (currentStep && currentStep !== 'init') updateStep(currentStep, 'done');
              setUploadResult(event);
              setIsUploading(false);
              await checkPending(); // Refresh badge
              return;
            }
            if (event.type === 'error') {
              if (currentStep && currentStep !== 'init') updateStep(currentStep, 'error', event.message);
              setUploadError(event.message);
              setIsUploading(false);
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
          } catch (e) { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.error('[HistoricalResults] Upload error:', err);
      setUploadError('Could not connect to Node.js server on port 3001.');
      setIsUploading(false);
    }
  };

  const getStepStyle = (id) => {
    const s = stepStatus[id];
    if (s === 'active') return { borderColor: 'var(--accent-neon)', background: 'rgba(0,255,136,0.06)', boxShadow: '0 0 12px rgba(0,255,136,0.15)' };
    if (s === 'done')   return { borderColor: 'rgba(0,255,136,0.4)', background: 'rgba(0,255,136,0.03)' };
    if (s === 'error')  return { borderColor: 'var(--accent-live)', background: 'rgba(255,50,50,0.08)' };
    return { borderColor: 'rgba(255,255,255,0.07)', background: 'transparent' };
  };
  const getStepIcon = (id, icon) => {
    if (stepStatus[id] === 'active') return <span style={{ animation: 'spin 1s infinite linear', display: 'inline-block' }}>⚙️</span>;
    if (stepStatus[id] === 'done')   return '✅';
    if (stepStatus[id] === 'error')  return '❌';
    return icon;
  };

  return (
    <div className="history-root">

      {/* ── Pending Reminder Banner ────────────────────────────────────────── */}
      {pendingCount > 0 && !uploadReady && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(255,107,53,0.15), rgba(255,154,108,0.08))',
          border: '1px solid rgba(255,107,53,0.35)', borderRadius: '12px',
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '14px',
          marginBottom: '4px',
        }}>
          <span style={{ fontSize: '1.4rem' }}>🔔</span>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '0.9rem', color: '#ff9a6c' }}>
              {pendingCount} screenshot{pendingCount !== 1 ? 's' : ''} waiting to be uploaded to Firebase
            </p>
            <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.65 }}>
              Capture a new screenshot below to trigger the upload pipeline, or use the 🔥 Firebase Upload tab.
            </p>
          </div>
          <span style={{
            background: 'linear-gradient(135deg, #ff6b35, #ff9a6c)', color: '#000',
            fontWeight: 900, fontSize: '0.75rem', padding: '4px 12px', borderRadius: '20px',
          }}>{pendingCount} PENDING</span>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="history-header glass-panel" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="history-header-left">
            <div className="history-icon">📸</div>
            <div>
              <h2 className="history-title">Live Snapshot Results</h2>
              <p className="history-subtitle">
                Capture · Gemini Vision Extract · Upload to Firebase — all in one flow.
              </p>
            </div>
          </div>
          <button className="how-to-toggle" onClick={() => setShowHowTo(v => !v)}>
            {showHowTo ? '✕ Close' : '⚡ How It Works'}
          </button>
        </div>

        {/* ── League Selector + Date Picker + Capture ───────────────────── */}
        <div style={{ marginTop: '20px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          {LEAGUES.map(lg => (
            <button key={lg} onClick={() => setSelectedLeague(lg)} disabled={loading}
              style={{
                background: selectedLeague === lg ? 'var(--accent-neon)' : 'transparent',
                color: selectedLeague === lg ? '#000' : 'white',
                border: '1px solid var(--accent-neon)', padding: '8px 16px', borderRadius: '20px',
                cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem',
                transition: 'all 0.25s ease', opacity: loading ? 0.5 : 1,
              }}>
              {lg.replace(' League', '')}
            </button>
          ))}

          <input id="history-date-picker" type="date" value={targetDate}
            onChange={e => setTargetDate(e.target.value)} disabled={loading}
            style={{
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '8px', padding: '8px 12px', color: 'white', fontSize: '0.85rem',
              cursor: 'pointer', colorScheme: 'dark', outline: 'none', opacity: loading ? 0.5 : 1,
            }} />
          {targetDate && targetDate !== todayISO && (
            <button onClick={() => setTargetDate(todayISO)} disabled={loading}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '0.8rem', padding: '4px 6px' }}>
              ✕ Reset to Today
            </button>
          )}

          <button id="history-fetch-btn" onClick={handleFetchResults} disabled={loading}
            style={{
              marginLeft: 'auto',
              background: loading ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #ffd700, var(--accent-neon))',
              color: '#000', border: 'none', padding: '10px 24px', borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer', fontWeight: '900', fontSize: '0.95rem',
              boxShadow: loading ? 'none' : '0 4px 15px rgba(0,255,136,0.25)', transition: 'all 0.3s ease',
            }}>
            {loading ? '⏳ Capturing...' : `📸 Capture ${selectedLeague.replace(' League', '')} · ${targetDate === todayISO ? 'Today' : targetDate}`}
          </button>
        </div>
      </div>

      {/* ── How It Works Accordion ─────────────────────────────────────────── */}
      <div className={`how-to-accordion ${showHowTo ? 'how-to-open' : ''}`}>
        <div className="glass-panel how-to-body">
          <h3 className="how-to-heading">Capture → Extract → Upload — How It Works</h3>
          <div className="how-to-steps">
            {[
              { n: 1, label: 'Select League & Date', body: 'Pick one of 5 vFootball leagues. Optionally choose a historical date using the date picker to retrieve past results.' },
              { n: 2, label: 'Automated Browser Capture', body: 'A headless Chrome browser navigates SportyBet, selects the correct league category, and captures a full-page screenshot saved to the server.' },
              { n: 3, label: 'Gemini Vision AI Extraction', body: 'The screenshot is sent to Google Gemini Vision which reads every match row — teams, scores, game IDs — and returns perfectly structured JSON.' },
              { n: 4, label: '3-Level Duplicate Guard', body: 'Before saving, the system checks: MD5 hash (exact copy), perceptual visual hash (80%+ similar table top), and Game ID comparison. All three must pass.' },
              { n: 5, label: 'Firebase Firestore Upload', body: 'Verified new records are batch-uploaded to your Firebase Firestore database under the vfootball_results collection, instantly available for your apps.' },
            ].map(({ n, label, body }) => (
              <div key={n} className="how-to-step">
                <div className="how-to-step-num">{n}</div>
                <div><strong>{label}</strong><p>{body}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Error Banner ───────────────────────────────────────────────────── */}
      {error && (
        <div className="glass-panel history-error" style={{ marginTop: '20px' }}>
          <div className="history-error-icon">⚠️</div>
          <div>
            <h4 className="history-error-title">Capture Error</h4>
            <p className="history-error-body">{error}</p>
            <p style={{ marginTop: '6px', fontSize: '0.82rem', opacity: 0.7 }}>
              Common causes: WAF blocking, or the backend server is not running. Check the terminal running <code>node index.js</code>.
            </p>
            <button className="retry-btn" style={{ marginTop: '12px' }} onClick={handleFetchResults}>↺ Try Again</button>
          </div>
        </div>
      )}

      {/* ── Loading State ──────────────────────────────────────────────────── */}
      {loading && !error && (
        <div className="glass-panel" style={{ marginTop: '20px', padding: '40px', textAlign: 'center' }}>
          <h3 style={{ color: 'var(--accent-neon)', marginBottom: '12px' }}>Running Automated Browser Sequence</h3>
          <p style={{ opacity: 0.75, marginBottom: '24px', lineHeight: 1.6 }}>
            Launching Chrome → Navigating to SportyBet →<br />
            Filtering <strong>{selectedLeague}</strong>{targetDate ? ` for ${targetDate}` : ''} → Capturing screenshot...
          </p>
          <div className="spinner" />
          <p style={{ marginTop: '20px', fontSize: '0.82rem', color: '#777' }}>This takes ~15–25 seconds. Please wait.</p>
        </div>
      )}

      {/* ── Results: Screenshot + Match Cards ─────────────────────────────── */}
      {resultData && !loading && !error && (
        <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          <div className="history-league-label">
            <div className="history-league-bar" />
            <span>{resultData.league} — Live Snapshot · {new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: '20px', alignItems: 'start' }}>

            {/* ── Left: Screenshot ── */}
            <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', background: 'rgba(0,0,0,0.5)', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span>📸</span>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Authentic Live Screenshot</h3>
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#888' }}>
                  {new Date().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ background: '#050505', padding: '8px', textAlign: 'center' }}>
                <img src={resultData.image} alt={`Screenshot for ${resultData.league}`}
                  style={{ maxWidth: '100%', height: 'auto', borderRadius: '6px', boxShadow: '0 4px 24px rgba(0,0,0,0.7)' }} />
              </div>
            </div>

            {/* ── Right: Match Cards ── */}
            <div className="glass-panel" style={{ maxHeight: '620px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <span style={{ fontSize: '1.1rem' }}>🤖</span>
                <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--accent-neon)' }}>Extracted Match Data</h3>
              </div>
              <p style={{ fontSize: '0.78rem', opacity: 0.55, marginBottom: '16px' }}>
                DOM-extracted live • {resultData.matchData.length} match{resultData.matchData.length !== 1 ? 'es' : ''} found
              </p>
              {resultData.matchData.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {resultData.matchData.map((match, i) => (
                    <div key={i} style={{
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: '10px', padding: '10px 14px',
                      display: 'grid', gridTemplateColumns: '36px 1fr auto 1fr', gap: '8px', alignItems: 'center',
                    }}>
                      <span style={{ fontSize: '0.72rem', color: '#aaa', fontFamily: 'monospace' }}>{match.time}</span>
                      <span style={{ fontWeight: 700, fontSize: '0.88rem', textAlign: 'right' }}>{match.home}</span>
                      <span style={{ border: '1px solid var(--accent-neon)', color: 'var(--accent-neon)', borderRadius: '6px', padding: '3px 9px', fontSize: '0.72rem', fontFamily: 'monospace', textAlign: 'center' }}>
                        {match.odds || 'LIVE'}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>{match.away}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '30px 20px', opacity: 0.5 }}>
                  <p style={{ fontSize: '1.5rem' }}>🔍</p>
                  <p>No match data was extracted. Use the screenshot as visual reference and upload it to Firebase via Gemini AI below.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 🔥 Inline Firebase Upload Panel ──────────────────────────────── */}
      {(uploadReady || pendingCount > 0) && !loading && (
        <div style={{ marginTop: '8px' }}>

          {/* Call to action header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px',
            background: uploadResult?.uploaded > 0
              ? 'linear-gradient(135deg, rgba(0,255,136,0.1), rgba(0,204,106,0.05))'
              : 'linear-gradient(135deg, rgba(255,107,53,0.12), rgba(255,154,108,0.05))',
            border: `1px solid ${uploadResult?.uploaded > 0 ? 'rgba(0,255,136,0.3)' : 'rgba(255,107,53,0.3)'}`,
            borderRadius: '14px 14px 0 0', borderBottom: 'none',
          }}>
            <span style={{ fontSize: '1.5rem' }}>{uploadResult ? '✅' : '🔥'}</span>
            <div style={{ flex: 1 }}>
              <h4 style={{ margin: 0, color: uploadResult ? 'var(--accent-neon)' : '#ff9a6c', fontSize: '0.95rem' }}>
                {uploadResult
                  ? uploadResult.skipped ? 'Duplicate Detected — Upload Skipped' : `Uploaded ${uploadResult.uploaded} Records to Firebase!`
                  : 'Upload Screenshot to Firebase'}
              </h4>
              <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.6 }}>
                {uploadResult
                  ? uploadResult.reason || `${uploadResult.newRecords} new · ${uploadResult.dupeCount ?? 0} duplicates skipped · Model: ${uploadResult.model}`
                  : uploadReady
                    ? `Ready: ${uploadReady.path.split('/').pop()} → ${uploadReady.league}`
                    : `${pendingCount} screenshot${pendingCount !== 1 ? 's' : ''} pending upload in the Firebase tab`}
              </p>
            </div>
            {!uploadResult && uploadReady && (
              <button onClick={handleUpload} disabled={isUploading}
                style={{
                  background: isUploading ? 'rgba(255,107,53,0.2)' : 'linear-gradient(135deg, #ff6b35, #ff9a6c)',
                  color: isUploading ? 'rgba(255,255,255,0.4)' : '#000',
                  border: isUploading ? '1px solid rgba(255,107,53,0.3)' : 'none',
                  borderRadius: '10px', padding: '10px 22px', fontSize: '0.88rem', fontWeight: 900,
                  cursor: isUploading ? 'not-allowed' : 'pointer',
                  boxShadow: isUploading ? 'none' : '0 4px 16px rgba(255,107,53,0.3)',
                  transition: 'all 0.3s ease', whiteSpace: 'nowrap',
                }}>
                {isUploading ? '⚙️ Running...' : '🚀 Upload Now'}
              </button>
            )}
          </div>

          {/* Pipeline Steps (visible during + after upload) */}
          {(isUploading || Object.keys(stepStatus).length > 0) && (
            <div style={{
              background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.07)',
              borderTop: 'none', borderRadius: '0 0 14px 14px', padding: '14px 20px',
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}>
              {isUploading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'rgba(0,255,136,0.04)', borderRadius: '8px', border: '1px solid rgba(0,255,136,0.12)', marginBottom: '4px' }}>
                  <div className="spinner" style={{ width: 20, height: 20, border: '3px solid rgba(0,255,136,0.1)', borderTop: '3px solid var(--accent-neon)', flexShrink: 0 }} />
                  <div>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--accent-neon)', fontWeight: 700 }}>Pipeline running...</p>
                    <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.55 }}>
                      {PIPELINE_STEPS.find(s => stepStatus[s.id] === 'active')?.desc || 'Initializing...'}
                    </p>
                  </div>
                </div>
              )}

              {PIPELINE_STEPS.map(step => (
                <div key={step.id} style={{ border: '1px solid', borderRadius: '8px', padding: '10px 14px', transition: 'all 0.3s ease', ...getStepStyle(step.id) }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: stepLogs[step.id]?.length ? '6px' : 0 }}>
                    <span style={{ fontSize: '1rem', minWidth: 22 }}>{getStepIcon(step.id, step.icon)}</span>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700 }}>{step.label}</p>
                      {!stepStatus[step.id] && <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.4 }}>{step.desc}</p>}
                    </div>
                    <span style={{ fontSize: '0.65rem', opacity: 0.4, fontFamily: 'monospace' }}>
                      {stepStatus[step.id] === 'active' ? 'RUNNING' : stepStatus[step.id]?.toUpperCase() || 'WAITING'}
                    </span>
                  </div>
                  {stepLogs[step.id]?.length > 0 && (
                    <div ref={logRef} style={{ maxHeight: '70px', overflowY: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', padding: '5px 10px', fontFamily: 'monospace', fontSize: '0.7rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      {stepLogs[step.id].map((log, i) => (
                        <span key={i} style={{ color: stepStatus[step.id] === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.7)' }}>{log}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {uploadError && (
                <div style={{ color: '#ff6b6b', fontSize: '0.8rem', padding: '10px 14px', background: 'rgba(255,50,50,0.08)', borderRadius: '8px', border: '1px solid rgba(255,50,50,0.2)' }}>
                  ❌ {uploadError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
