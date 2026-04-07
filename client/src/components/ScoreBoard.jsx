import React from 'react';

export default function ScoreBoard({ scores }) {
  if (!scores || scores.length === 0) {
    return (
      <div className="glass-panel" style={{ textAlign: 'center', opacity: 0.7 }}>
        <p>No active matches found. The scraper successfully ran but the scoreboard is empty.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {scores.map((leagueGroup, i) => (
        <div key={i}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '16px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--glass-border)', paddingBottom: '8px' }}>
            {leagueGroup.league}
          </h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {leagueGroup.matches.map((match, j) => (
              <div key={j} className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', transition: '0.2s', cursor: 'default' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{ color: 'var(--accent-neon)', fontWeight: 600, width: '50px' }}>
                    {match.time}
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', width: '50px' }}>
                    #{match.code}
                  </div>
                </div>
                
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px', fontWeight: 500, fontSize: '1.1rem' }}>
                  <span style={{ textAlign: 'right', flex: 1 }}>{match.home}</span>
                  <span style={{ padding: '6px 16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', color: 'var(--accent-success)', letterSpacing: '2px', fontWeight: 'bold' }}>
                    {match.score}
                  </span>
                  <span style={{ textAlign: 'left', flex: 1 }}>{match.away}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
