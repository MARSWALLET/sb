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
  const [prediction, setPrediction] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      setTimeout(() => setBalance('100'), 800);
    }
  }, []);

  const handlePredict = (type) => {
    setLoading(true);
    setPrediction(null);
    setTimeout(() => {
      setPrediction({
        league: "Virtual Premier League",
        match: "Arsenal vs Chelsea",
        tip: type === 'ai' ? "Home Win (89%)" : "Under 3.5 Goals"
      });
      setBalance(prev => (parseInt(prev) - (type === 'ai' ? 5 : 1)).toString());
      setLoading(false);
    }, 1500);
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
        {!prediction && !loading && (
          <div className="hero">
            <h1 className="hero-title">Live Oracle</h1>
            <p className="hero-subtitle">Mathematical insights for live virtual football matches.</p>
          </div>
        )}

        {/* Action Buttons */}
        {!prediction && !loading && (
          <div className="action-grid">
            <button className="btn btn-ai" onClick={() => handlePredict('ai')}>
              <div className="btn-content">
                <BrainIcon />
                <span>Deep Quant AI <small style={{opacity: 0.8, marginLeft: 4}}>(5 pts)</small></span>
              </div>
              <ArrowRightIcon />
            </button>
            <button className="btn btn-dark" onClick={() => handlePredict('normal')}>
              <div className="btn-content">
                <ZapIcon />
                <span>Fast Probability <small style={{opacity: 0.6, marginLeft: 4}}>(1 pt)</small></span>
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

        {/* Prediction Display */}
        {prediction && (
          <div className="result-section">
            <div className="result-league">{prediction.league}</div>
            <div className="result-match">{prediction.match}</div>
            
            <div className="result-tip-box">
              <div className="result-tip-title">Recommended Edge</div>
              <div className="result-tip-value">{prediction.tip}</div>
            </div>

            <div className="action-grid" style={{ padding: '40px 0 0 0' }}>
               <button className="btn btn-dark" onClick={() => setPrediction(null)}>
                  <span>Analyze Another Match</span>
               </button>
            </div>
          </div>
        )}

      </main>

      {/* Footer / Utilities */}
      <footer className="footer">
        <button className="btn-buy" onClick={() => {/* Handle Squad / Stars */}}>
          <WalletIcon /> Buy Computing Points
        </button>
      </footer>
      
    </div>
  )
}

export default App
