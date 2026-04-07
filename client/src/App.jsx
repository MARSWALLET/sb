import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ScoreBoard from './components/ScoreBoard';
import HowToGuide from './components/HowToGuide';
import HistoricalResults from './components/HistoricalResults';
import FirebaseUploader from './components/FirebaseUploader';
import LandingPage from './components/LandingPage';
import AILog from './components/AILog';
import './index.css';

// ── Admin Dashboard (existing app) ─────────────────────────────────────────
function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('live');
  const [scores, setScores]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    let interval;
    if (activeTab === 'live') {
      const fetchScores = async () => {
        try {
          const response = await fetch('/api/scores');
          if (!response.ok) throw new Error('Server error');
          const data = await response.json();
          if (data.success) { setScores(data.data); setError(null); }
        } catch (err) {
          console.error('[Firebase Index Debug/Error Details]: Network fetch failed.', err);
          setError('Unable to connect to stealth scraper. Node server offline?');
        } finally {
          setLoading(false);
        }
      };
      fetchScores();
      interval = setInterval(fetchScores, 2000);
    }
    return () => clearInterval(interval);
  }, [activeTab]);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 20px', display: 'flex', gap: '32px', flexDirection: 'column' }}>
      <header>
        {/* Admin breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <a href="/" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', textDecoration: 'none' }}>← Public Dashboard</a>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>/</span>
          <span style={{ color: 'var(--accent-purple)', fontSize: '0.8rem', fontWeight: 700 }}>⚙️ Admin</span>
        </div>

        <h1 style={{ fontSize: '3rem', margin: '0 0 10px 0', letterSpacing: '-0.02em' }}>
          <span className="pulse-dot"></span> vFootball <span className="glow-text">Terminal</span>
          <span style={{ fontSize: '1rem', marginLeft: '12px', color: 'var(--accent-purple)', fontWeight: 600 }}>Admin</span>
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>Dual Architecture: Memory Proxy (Live) &amp; Puppeteer Pagination (History).</p>

        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '16px', marginTop: '24px', borderBottom: '1px solid var(--glass-border)', paddingBottom: '16px' }}>
          {[
            { id: 'live',     label: 'Live Odds Loop' },
            { id: 'history',  label: 'Previous Results' },
            { id: 'firebase', label: '🔥 Firebase Upload' },
          ].map(tab => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: 'none', border: 'none', padding: '8px 16px', fontSize: '1.2rem', cursor: 'pointer',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: activeTab === tab.id ? 'bold' : 'normal',
                borderBottom: activeTab === tab.id
                  ? `3px solid ${tab.id === 'firebase' ? '#ff6b35' : 'var(--accent-neon)'}`
                  : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {error && activeTab === 'live' && (
        <div className="glass-panel" style={{ borderLeft: '4px solid var(--accent-live)' }}>
          <h3 style={{ color: 'var(--accent-live)', marginTop: 0 }}>Connection Interrupted</h3>
          <p>{error}</p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 350px', gap: '32px', alignItems: 'start' }}>
        <main>
          {activeTab === 'live' && (
            loading ? (
              <div className="glass-panel" style={{ textAlign: 'center', padding: '60px' }}>
                <div className="pulse-dot" style={{ backgroundColor: 'var(--accent-neon)', boxShadow: '0 0 10px var(--accent-neon)' }}></div>
                <p style={{ color: 'var(--accent-neon)' }}>Launching Continuous Polling Background Browser...</p>
              </div>
            ) : (
              <ScoreBoard scores={scores} />
            )
          )}
          {activeTab === 'history' && <HistoricalResults />}
          {activeTab === 'firebase' && <FirebaseUploader active={activeTab === 'firebase'} />}
        </main>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <HowToGuide activeTab={activeTab} />
          {activeTab === 'history' && <AILog />}
        </aside>
      </div>
    </div>
  );
}

// ── Root App with routing ──────────────────────────────────────────────────
export default function App() {
  return (
    <Routes>
      <Route path="/"      element={<LandingPage />} />
      <Route path="/admin" element={<AdminDashboard />} />
      <Route path="*"      element={<Navigate to="/" replace />} />
    </Routes>
  );
}
