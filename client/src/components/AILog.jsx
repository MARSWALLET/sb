import React, { useState, useEffect } from 'react';

const PURPLE = '#A78BFA';
const NEON   = '#00E5FF';

export default function AILog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/ai-memory')
      .then(res => res.json())
      .then(data => {
        if (data.success) setLogs(data.log);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load AI Memory log:', err);
        setLoading(false);
      });
  }, []);

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Loading Memory...</div>;
  if (!logs.length) return <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Memory is blank. Run an analysis on the Landing Page first.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <h3 style={{ margin: '0 0 10px', color: PURPLE, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
        ???? AI Collective Memory Log
      </h3>
      {logs.map(log => (
        <div key={log.id} style={{
          background: 'rgba(167,139,250,0.06)', border: `1px solid rgba(167,139,250,0.15)`,
          borderRadius: 8, padding: '12px 14px', fontSize: '0.8rem'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontWeight: 700, color: '#fff' }}>{log.dateLabel}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{new Date(log.createdAt).toLocaleString()}</span>
          </div>
          <div style={{ color: NEON, fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.05em' }}>
            [Scope: {log.scope}] {log.league ? `?? ${log.league}` : '?? Global'} ?? {log.matchCount} Matches
          </div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.5 }}>
            {log.summary}
          </div>
          {log.prediction && (
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: 6, borderLeft: `2px solid ${PURPLE}` }}>
              <span style={{ color: PURPLE, fontSize: '0.7rem', fontWeight: 600, display: 'block', marginBottom: '4px' }}>???? PREDICTION</span>
              <span style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{log.prediction}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
