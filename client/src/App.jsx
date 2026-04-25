import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [balance, setBalance] = useState('...');
  const [prediction, setPrediction] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // If running inside Telegram Web App, tg.initDataUnsafe holds user info
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      // Normally we'd pass tg.initDataUnsafe.user.id to fetch user balance from our API
      // Since this is a demo structure, we'll simulate fetching from our backend
      setTimeout(() => setBalance('100'), 800);
    }
  }, []);

  const handlePredict = (type) => {
    setLoading(true);
    setPrediction(null);
    // Simulate backend call to the Telegram bot server endpoint
    setTimeout(() => {
      setPrediction({
        league: "Virtual Premier League",
        match: "Arsenal vs Chelsea",
        tip: type === 'ai' ? "Home Win (89%)" : "Draw (60%)"
      });
      setBalance(prev => (parseInt(prev) - (type === 'ai' ? 5 : 1)).toString());
      setLoading(false);
    }, 1500);
  };

  return (
    <div className="mini-app-container">
      <header className="header">
        <h1>vFootball AI ✨</h1>
        <div className="balance-pill">💰 {balance} PTS</div>
      </header>

      <main className="content">
        <div className="glass-panel">
          <h2>Live Match Oracle</h2>
          <p>Instantly generate predictions for virtual matches.</p>

          <div className="actions">
            <button className="btn-normal" onClick={() => handlePredict('normal')}>
              ⚡ Quick Predict (1 pt)
            </button>
            <button className="btn-ai" onClick={() => handlePredict('ai')}>
              🤖 Deep AI Predict (5 pts)
            </button>
          </div>
        </div>

        {loading && (
          <div className="loader-container">
            <div className="spinner"></div>
            <p>Consulting Intelligence Node...</p>
          </div>
        )}

        {prediction && (
          <div className="prediction-card slide-up">
            <div className="match-title">{prediction.league}</div>
            <div className="match-teams">{prediction.match}</div>
            <div className="match-tip-container">
              <div className="match-tip">{prediction.tip}</div>
              {prediction.tip.includes('%') ? null : <div className="match-confidence">High Probability</div>}
            </div>
          </div>
        )}
      </main>

      <footer className="footer-actions">
        <button className="btn-buy" onClick={() => {/* Launch Squad API or TG Stars //*/}}>
          💳 Buy More Points
        </button>
      </footer>
    </div>
  )
}

export default App
