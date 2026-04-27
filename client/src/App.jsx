import { useState, useEffect } from 'react'
import './App.css'

// ── Icons (Inline SVGs) ────────────────────────────────────────────────────────
const WalletIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2" ry="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line>
  </svg>
);

const BrainIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path>
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path>
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path>
    <path d="M6.002 5.125A3 3 0 0 0 6.401 6.5"></path>
    <path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path>
    <path d="M19.938 10.5a4 4 0 0 1 .585.396"></path>
    <path d="M6 18a4 4 0 0 1-1.967-.516"></path>
    <path d="M19.967 17.484A4 4 0 0 1 18 18"></path>
  </svg>
);

const ZapIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
  </svg>
);

const ArrowRightIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>
  </svg>
);

function App() {
  const [balance, setBalance] = useState('...');
  const [predictions, setPredictions] = useState(null); // Now an array
  const [loading, setLoading] = useState(false);
  const [tgId, setTgId] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      
      const user = tg.initDataUnsafe?.user;
      if (user && user.id) {
        setTgId(user.id);
        fetch(`/api/webapp/user?tgId=${user.id}`)
          .then(r => r.json())
          .then(data => {
            if (data.balance !== undefined) setBalance(data.balance.toString());
          })
          .catch(e => console.error("Failed to fetch user state", e));
      } else {
        // Fallback for browser testing
        setTgId('dev_test');
        setBalance('DEV');
      }
    }
  }, []);

  const handlePredict = async (type) => {
    setLoading(true);
    setPredictions(null);
    try {
      const res = await fetch(`/api/webapp/predict?tgId=${tgId}&type=${type}`, { method: 'POST' });
      const data = await res.json();
      
      if (data.success && data.predictions) {
        setPredictions(data.predictions);
        setBalance(data.newBalance.toString());
      } else {
        alert(data.error || "Failed to fetch predictions. Not enough points?");
      }
    } catch (err) {
      alert("Network Error");
    }
    setLoading(false);
  };

  return (
    <div className="app-root">
      
      {/* Top Header */}
      <header className="top-nav">
        <div className="brand">
          <BrainIcon />
          vFootball
        </div>
        <div className="balance-badge">
          <WalletIcon />
          <span>{balance} PTS</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-content">
        
        {/* Dynamic Hero Section */}
        {!predictions && !loading && (
          <div className="hero">
            <h1 className="hero-title">Live Oracle</h1>
            <p className="hero-subtitle">Batch Mathematical insights for live virtual football matches.</p>
          </div>
        )}

        {/* Action Buttons */}
        {!predictions && !loading && (
          <div className="action-grid">
            <button className="btn btn-ai" onClick={() => handlePredict('ai')}>
              <div className="btn-content">
                <BrainIcon />
                <span>Deep Quant AI <small style={{opacity: 0.8, marginLeft: 4}}>(8 pts)</small></span>
              </div>
              <ArrowRightIcon />
            </button>
            <button className="btn btn-dark" onClick={() => handlePredict('normal')}>
              <div className="btn-content">
                <ZapIcon />
                <span>Fast Probability <small style={{opacity: 0.6, marginLeft: 4}}>(8 pts)</small></span>
              </div>
              <ArrowRightIcon />
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="loader-container">
            <div className="spinner"></div>
            <span className="loader-text">Consulting Mathematical Engine...</span>
          </div>
        )}

        {/* Prediction Display (Batch) */}
        {predictions && predictions.length > 0 && (
          <div className="result-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ margin: 0, paddingBottom: '10px', fontSize: '18px', borderBottom: '1px solid #eaeaea', textAlign: 'center', color: 'var(--text-primary)' }}>Oracle Batch Results</h3>
            {predictions.map((pred, i) => (
              <div key={i} className="result-card" style={{ background: '#f8f9fa', padding: '16px', borderRadius: '12px', border: '1px solid #eee' }}>
                <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, marginBottom: '4px' }}>{pred.league || 'Virtual League'}</div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: '#0f172a', marginBottom: '12px' }}>{pred.match}</div>
                <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 700, color: '#4f46e5', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{pred.tip}</span>
                  {pred.confidence && <span style={{ color: '#64748b' }}>{pred.confidence}</span>}
                </div>
              </div>
            ))}

            <div className="action-grid" style={{ padding: '20px 0 0 0' }}>
               <button className="btn btn-dark" onClick={() => setPredictions(null)}>
                  <span>Analyze Another Batch</span>
               </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer / Utilities */}
      <footer className="footer">
        <button className="btn-buy" onClick={() => {
          if (window.Telegram?.WebApp) {
             window.Telegram.WebApp.close();
          }
        }}>
          <WalletIcon /> Buy Points in Bot Menu
        </button>
      </footer>
      
    </div>
  )
}

export default App
