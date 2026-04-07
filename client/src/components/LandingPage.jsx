import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Chart as ChartJS,
  ArcElement, BarElement, CategoryScale, LinearScale,
  RadialLinearScale, PointElement, LineElement,
  Tooltip, Legend, Filler,
} from 'chart.js';
import { Doughnut, Bar, Radar, PolarArea } from 'react-chartjs-2';

ChartJS.register(
  ArcElement, BarElement, CategoryScale, LinearScale,
  RadialLinearScale, PointElement, LineElement,
  Tooltip, Legend, Filler,
);

// ── Colour helpers ─────────────────────────────────────────────────────────
const NEON    = '#00E5FF';
const GREEN   = '#00FF88';
const GOLD    = '#FFD700';
const PURPLE  = '#A78BFA';
const RED     = '#FF3355';
const ORANGE  = '#FF6B35';
const LEAGUES = {
  'England - Virtual': { icon: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: '#00E5FF' },
  'Germany - Virtual': { icon: '🇩🇪', color: '#FFD700' },
  'Italy - Virtual':   { icon: '🇮🇹', color: '#00FF88' },
  'Spain - Virtual':   { icon: '🇪🇸', color: '#FF3355' },
};
const leagueColor = (lg) => LEAGUES[lg]?.color || PURPLE;
const leagueIcon  = (lg) => LEAGUES[lg]?.icon  || '🌐';

// ── Score parser ───────────────────────────────────────────────────────────
function parseScore(score = '0:0') {
  const [h, a] = score.split(':').map(Number);
  return { home: h || 0, away: a || 0, total: (h || 0) + (a || 0) };
}

// ── Chart config util ──────────────────────────────────────────────────────
const CHART_OPTS = {
  plugins: { legend: { labels: { color: '#7A8AA0', font: { family: 'Inter', size: 11 } } } },
  responsive: true,
  maintainAspectRatio: false,
};

export default function LandingPage() {
  // ── State ────────────────────────────────────────────────────────────────
  const [data,           setData]           = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [page,           setPage]           = useState(1);
  const [pageSize]                          = useState(3);
  const [leagueFilter,   setLeagueFilter]   = useState('');
  
  // Date filtering
  const [dateFrom,       setDateFrom]       = useState(''); // YYYY-MM-DD for input
  const [dateTo,         setDateTo]         = useState(''); // YYYY-MM-DD for input
  
  const [expandedDates,  setExpandedDates]  = useState({});
  const [analyzing,      setAnalyzing]      = useState(null); // date string being analyzed
  const [analysisMap,    setAnalysisMap]    = useState({});   // date → analysis object
  const [analysisError,  setAnalysisError]  = useState({});
  const analysisRef = useRef({});
  analysisRef.current = analysisMap;

  // ── Helper: Convert YYYY-MM-DD to DD/MM/YYYY for API ───────────────────────
  const formatForApi = (isoStr) => {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

  // ── Fetch results ─────────────────────────────────────────────────────────
  const fetchResults = useCallback(async (p = page) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: p, pageSize });
      if (leagueFilter) params.set('league', leagueFilter);
      if (dateFrom) params.set('dateFrom', formatForApi(dateFrom));
      if (dateTo)   params.set('dateTo', formatForApi(dateTo));
      
      console.log(`[LandingPage] Fetching results page=${p} league=${leagueFilter || 'ALL'}`);
      const res = await fetch(`http://localhost:3001/api/public/results?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Unknown server error');
      console.log(`[LandingPage] Got ${json.dates.length} date blocks, totalDates=${json.totalDates}`);
      setData(json);
      
      // Auto-expand first date if not already set
      if (json.dates.length > 0 && Object.keys(expandedDates).length === 0) {
        setExpandedDates({ [json.dates[0].date]: true });
      }
    } catch (err) {
      console.error('[LandingPage] Fetch error:', err);
      setError(err.message);
    }
    setLoading(false);
  }, [page, pageSize, leagueFilter, dateFrom, dateTo]);

  useEffect(() => { fetchResults(page); }, [page, leagueFilter, dateFrom, dateTo]);

  // ── Pagination handlers ───────────────────────────────────────────────────
  const goPage = (p) => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  // ── Toggle date expansion ─────────────────────────────────────────────────
  const toggleDate = (d) => setExpandedDates(prev => ({ ...prev, [d]: !prev[d] }));

  // ── DeepSeek Analysis ─────────────────────────────────────────────────────
  const analyze = async (dateBlock, scopeType = 'date') => {
    let scope, dateLabel;
    
    if (scopeType === 'today') {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = d.getFullYear();
        const todayStr = `${dd}/${mm}/${yy}`;
        if (dateBlock.date !== todayStr) {
           alert("The 'Today Only' analysis is meant for today's results.");
           return;
        }
        scope = 'today';
        dateLabel = "Today's Matches";
    } else if (scopeType === 'range' && (dateFrom || dateTo)) {
        scope = 'range';
        dateLabel = `Range: ${formatForApi(dateFrom) || 'Start'} to ${formatForApi(dateTo) || 'End'}`;
    } else {
        scope = 'date';
        dateLabel = `Specific Date: ${dateBlock.date}`;
    }

    const { date, leagues } = dateBlock;

    setAnalyzing(date);
    setAnalysisError(prev => ({ ...prev, [date]: null }));
    console.log(`[LandingPage] Requesting AI Analysis scope=${scope} for ${date}`);

    try {
      const res = await fetch('http://localhost:3001/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          dateLabel,
          dateFrom: scope === 'range' ? formatForApi(dateFrom) : undefined,
          dateTo:   scope === 'range' ? formatForApi(dateTo)   : undefined,
          league:   leagueFilter || '',
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Analysis failed');
      console.log(`[LandingPage] Analysis complete for ${date}, tokens=${json.tokensUsed}`);
      setAnalysisMap(prev => ({ ...prev, [date]: json.analysis }));
      // Scroll to analysis
      setTimeout(() => document.getElementById(`analysis-${date}`)?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('[LandingPage] Analysis error:', err);
      setAnalysisError(prev => ({ ...prev, [date]: err.message }));
    }
    setAnalyzing(null);
  };

  // ── Collect all flat matches for a date ───────────────────────────────────
  const allMatchesFor = (dateBlock) => Object.values(dateBlock.leagues).flat();

  // ── Helper UI for quick date selecting ─────────────────────────────────────
  const setToday = () => {
    const d = new Date();
    const iso = d.toISOString().split('T')[0];
    setDateFrom(iso);
    setDateTo(iso);
    setPage(1);
  };
  const clearDates = () => {
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', fontFamily: 'Inter, sans-serif' }}>

      {/* ── HERO HEADER ──────────────────────────────────────────────────── */}
      <header style={{
        background: 'linear-gradient(180deg, rgba(0,229,255,0.06) 0%, transparent 100%)',
        borderBottom: '1px solid rgba(0,229,255,0.1)',
        padding: '0 24px',
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 0 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: GREEN, boxShadow: `0 0 12px ${GREEN}`, animation: 'pulse 1.5s infinite' }} />
                <span style={{ fontSize: '0.72rem', color: GREEN, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Live vFootball Results</span>
              </div>
              <h1 style={{ margin: 0, fontSize: '2.4rem', fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
                vFootball <span style={{ color: NEON, textShadow: `0 0 20px ${NEON}55` }}>Terminal</span>
              </h1>
              <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Real match results · AI Pattern Memory · Live Firebase Sync
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              {data && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  {[
                    { label: 'Dates Found', value: data.totalDates, color: NEON },
                  ].map(s => (
                    <div key={s.label} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '8px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.3rem', fontWeight: 900, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}
              <a href="/admin" style={{
                background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.35)',
                color: PURPLE, borderRadius: 10, padding: '10px 18px',
                textDecoration: 'none', fontSize: '0.85rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.2s ease',
              }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(167,139,250,0.22)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(167,139,250,0.12)'}
              >
                ⚙️ Admin Panel
              </a>
            </div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px' }}>

        {/* ── FILTERS BAR ──────────────────────────────────────────────────── */}
        <div className="glass-panel" style={{ padding: '16px 20px', marginBottom: '24px', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' }}>
          
          {/* League Filter */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>League:</span>
            {['', ...(data?.availableLeagues || [])].map(lg => (
              <button key={lg || 'all'} onClick={() => { setLeagueFilter(lg); setPage(1); }}
                style={{
                  background: leagueFilter === lg ? (lg ? leagueColor(lg) : NEON) : 'rgba(255,255,255,0.04)',
                  color: leagueFilter === lg ? '#000' : 'var(--text-secondary)',
                  border: `1px solid ${leagueFilter === lg ? 'transparent' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 20, padding: '6px 14px', cursor: 'pointer',
                  fontSize: '0.78rem', fontWeight: 700, transition: 'all 0.2s ease',
                }}
              >
                {lg ? `${leagueIcon(lg)} ${lg.replace(' - Virtual', '')}` : '🌍 All'}
              </button>
            ))}
          </div>

          <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.1)' }} />

          {/* Date Filter */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Date Range:</span>
            
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', borderRadius: 6, padding: '6px 12px', colorScheme: 'dark', fontSize: '0.8rem' }} />
            <span style={{ color: 'var(--text-muted)' }}>to</span>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', borderRadius: 6, padding: '6px 12px', colorScheme: 'dark', fontSize: '0.8rem' }} />
            
            <button onClick={setToday} style={{ background: `${GREEN}15`, color: GREEN, border: `1px solid ${GREEN}40`, borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700 }}>
              Today
            </button>
            {(dateFrom || dateTo) && (
              <button onClick={clearDates} style={{ background: 'rgba(255,51,85,0.1)', color: RED, border: `1px solid rgba(255,51,85,0.3)`, borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700 }}>
                Clear
              </button>
            )}
          </div>
        </div>


        {/* ── LOADING / ERROR ───────────────────────────────────────────────── */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Loading match results...</p>
          </div>
        )}

        {error && !loading && (
          <div className="glass-panel" style={{ borderLeft: `4px solid ${RED}`, background: 'rgba(255,51,85,0.05)', textAlign: 'center', padding: '40px' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>⚠️</div>
            <h3 style={{ color: RED, margin: '0 0 8px' }}>Could Not Load Results</h3>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 20px', fontSize: '0.88rem' }}>{error}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 16px' }}>Make sure the Node.js server is running on port 3001</p>
            <button onClick={() => fetchResults(page)} style={{ background: RED, color: 'white', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: 'pointer', fontWeight: 700 }}>
              ↺ Retry
            </button>
          </div>
        )}

        {!loading && !error && data?.dates.length === 0 && (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</div>
            <h3 style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>No Results Found</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {leagueFilter ? `No data for ${leagueFilter}` : 'Upload screenshots via the Admin panel to populate results'}
            </p>
          </div>
        )}

        {/* ── DATE BLOCKS ───────────────────────────────────────────────────── */}
        {!loading && !error && data?.dates.map((dateBlock) => {
          const isExpanded = expandedDates[dateBlock.date] !== false;
          const matches = allMatchesFor(dateBlock);
          const analysis = analysisMap[dateBlock.date];
          const isAnalyzing = analyzing === dateBlock.date;
          const aError = analysisError[dateBlock.date];

          return (
            <div key={dateBlock.date} className="glass-panel" style={{ marginBottom: '20px', padding: 0, overflow: 'hidden' }}>

              {/* Date header */}
              <div
                onClick={() => toggleDate(dateBlock.date)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '18px 24px', cursor: 'pointer',
                  borderBottom: isExpanded ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  background: 'linear-gradient(90deg, rgba(0,229,255,0.04) 0%, transparent 100%)',
                  userSelect: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: 3, height: 36, background: `linear-gradient(180deg, ${NEON}, ${PURPLE})`, borderRadius: 3 }} />
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '1.1rem', fontWeight: 900, color: 'white' }}>📅 {dateBlock.date}</span>
                      <span style={{
                        background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.25)',
                        borderRadius: 20, padding: '2px 10px', fontSize: '0.7rem', color: NEON, fontWeight: 700,
                      }}>{dateBlock.totalMatches} matches</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '5px', flexWrap: 'wrap' }}>
                      {Object.keys(dateBlock.leagues).map(lg => (
                        <span key={lg} style={{
                          fontSize: '0.68rem', color: leagueColor(lg), fontWeight: 600,
                          background: `${leagueColor(lg)}15`, borderRadius: 20, padding: '1px 8px',
                        }}>{leagueIcon(lg)} {lg.replace(' - Virtual', '')}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {/* AI Analysis Dropdown */}
                  <div style={{ position: 'relative' }} className="analyze-dropdown">
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        // If no range filter is active, just do the single date.
                        // Otherwise, we can just trigger the single date by default on click,
                        // but provide a dropdown for other options
                        analyze(dateBlock, 'date');
                      }}
                      disabled={isAnalyzing}
                      style={{
                        background: analysis ? 'rgba(0,255,136,0.1)' : 'rgba(167,139,250,0.12)',
                        border: `1px solid ${analysis ? 'rgba(0,255,136,0.3)' : 'rgba(167,139,250,0.3)'}`,
                        color: analysis ? GREEN : PURPLE, borderRadius: '8px 0 0 8px', padding: '7px 14px',
                        cursor: isAnalyzing ? 'not-allowed' : 'pointer', fontSize: '0.78rem', fontWeight: 700,
                        transition: 'all 0.2s ease', display: 'flex', alignItems: 'center', gap: '6px',
                        borderRight: 'none'
                      }}
                    >
                      {isAnalyzing ? (
                        <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, flexShrink: 0 }} /> Analyzing...</>
                      ) : analysis ? '✅ Re-Analyze Date' : '🤖 Analyze Date'}
                    </button>
                    {/* The small dropdown trigger next to the button */}
                    <button
                      style={{
                        background: analysis ? 'rgba(0,255,136,0.05)' : 'rgba(167,139,250,0.05)',
                        border: `1px solid ${analysis ? 'rgba(0,255,136,0.3)' : 'rgba(167,139,250,0.3)'}`,
                        color: analysis ? GREEN : PURPLE, borderRadius: '0 8px 8px 0', padding: '7px 8px',
                        cursor: isAnalyzing ? 'not-allowed' : 'pointer', fontSize: '0.75rem', fontWeight: 700,
                      }}
                      disabled={isAnalyzing}
                      onClick={(e) => {
                        e.stopPropagation();
                        const menu = e.currentTarget.nextElementSibling;
                        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
                      }}
                      onBlur={(e) => {
                        // Small timeout to allow click to register before hiding
                        const menu = e.currentTarget.nextElementSibling;
                        setTimeout(() => { if (menu) menu.style.display = 'none'; }, 200);
                      }}
                    >▼</button>
                    {/* Dropdown Menu */}
                    <div style={{
                      display: 'none', position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                      background: '#1A2235', border: '1px solid rgba(167,139,250,0.3)',
                      borderRadius: 8, overflow: 'hidden', zIndex: 10, minWidth: 150,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    }}>
                      <div
                        style={{ padding: '10px 16px', fontSize: '0.75rem', color: '#fff', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        onClick={(e) => { e.stopPropagation(); e.currentTarget.parentElement.style.display = 'none'; analyze(dateBlock, 'today'); }}
                      >📅 Analyze Today Only</div>
                      {(dateFrom || dateTo) && (
                        <div
                          style={{ padding: '10px 16px', fontSize: '0.75rem', color: '#fff', cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          onClick={(e) => { e.stopPropagation(); e.currentTarget.parentElement.style.display = 'none'; analyze(dateBlock, 'range'); }}
                        >📊 Analyze Filtered Range</div>
                      )}
                    </div>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'none' }}>⌄</span>
                </div>
              </div>


              {/* Match results */}
              {isExpanded && (
                <div style={{ padding: '0 24px 24px' }}>
                  {Object.entries(dateBlock.leagues).map(([lg, lgMatches]) => (
                    <div key={lg} style={{ marginTop: '20px' }}>
                      {/* League header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                        <div style={{ width: 20, height: 2, background: leagueColor(lg), borderRadius: 2 }} />
                        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: leagueColor(lg), textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                          {leagueIcon(lg)} {lg}
                        </span>
                        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.04)' }} />
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{lgMatches.length} matches</span>
                      </div>

                      {/* Match table */}
                      <div style={{
                        background: 'rgba(0,0,0,0.2)', borderRadius: 10,
                        overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)',
                      }}>
                        {/* Table head */}
                        <div style={{
                          display: 'grid', gridTemplateColumns: '70px 1fr 90px 1fr 70px',
                          padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)',
                          fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em',
                        }}>
                          <span>Time</span>
                          <span style={{ textAlign: 'right' }}>Home</span>
                          <span style={{ textAlign: 'center' }}>Score</span>
                          <span>Away</span>
                          <span style={{ textAlign: 'right' }}>ID</span>
                        </div>
                        {/* Rows */}
                        {lgMatches.map((m, i) => {
                          const s = parseScore(m.score);
                          const homeWin = s.home > s.away;
                          const awayWin = s.away > s.home;
                          const draw    = s.home === s.away;
                          return (
                            <div key={m.gameId || i} style={{
                              display: 'grid', gridTemplateColumns: '70px 1fr 90px 1fr 70px',
                              padding: '11px 16px', alignItems: 'center',
                              borderBottom: i < lgMatches.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none',
                              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                              transition: 'background 0.15s ease',
                            }}
                              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                              onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)'}
                            >
                              {/* Time */}
                              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: NEON, fontFamily: 'monospace' }}>{m.time}</span>
                              {/* Home */}
                              <span style={{
                                fontSize: '0.88rem', fontWeight: homeWin ? 800 : 400,
                                color: homeWin ? 'white' : 'var(--text-secondary)',
                                textAlign: 'right', paddingRight: 12,
                              }}>
                                {homeWin && <span style={{ marginRight: 4, fontSize: '0.75rem' }}>👑</span>}
                                {m.homeTeam}
                              </span>
                              {/* Score badge */}
                              <div style={{ display: 'flex', justifyContent: 'center' }}>
                                <span style={{
                                  border: `1.5px solid ${draw ? GOLD : homeWin ? GREEN : RED}`,
                                  borderRadius: 6, padding: '4px 12px',
                                  fontSize: '0.88rem', fontWeight: 900, letterSpacing: '0.05em',
                                  color: draw ? GOLD : homeWin ? GREEN : RED,
                                  background: `${draw ? GOLD : homeWin ? GREEN : RED}12`,
                                  fontFamily: 'monospace',
                                }}>{m.score}</span>
                              </div>
                              {/* Away */}
                              <span style={{
                                fontSize: '0.88rem', fontWeight: awayWin ? 800 : 400,
                                color: awayWin ? 'white' : 'var(--text-secondary)',
                                paddingLeft: 12,
                              }}>
                                {m.awayTeam}
                                {awayWin && <span style={{ marginLeft: 4, fontSize: '0.75rem' }}>👑</span>}
                              </span>
                              {/* Game ID */}
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'right', fontFamily: 'monospace' }}>#{m.gameId}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* Quick stats bar */}
                  <QuickStats matches={matches} />

                  {/* AI Analysis error */}
                  {aError && (
                    <div style={{ marginTop: 16, background: 'rgba(255,51,85,0.06)', border: '1px solid rgba(255,51,85,0.2)', borderRadius: 10, padding: '12px 16px' }}>
                      <span style={{ color: RED, fontSize: '0.83rem' }}>❌ Analysis failed: {aError}</span>
                    </div>
                  )}

                  {/* AI Analysis panel */}
                  {analysis && (
                    <AnalysisPanel id={`analysis-${dateBlock.date}`} analysis={analysis} date={dateBlock.date} matches={matches} />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* ── PAGINATION ──────────────────────────────────────────────────── */}
        {data && data.totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => goPage(1)} disabled={page === 1}
              style={paginBtn(page === 1)}>«</button>
            <button onClick={() => goPage(page - 1)} disabled={page === 1}
              style={paginBtn(page === 1)}>‹ Prev</button>

            {Array.from({ length: data.totalPages }, (_, i) => i + 1)
              .filter(p => Math.abs(p - page) <= 2 || p === 1 || p === data.totalPages)
              .reduce((acc, p, i, arr) => {
                if (i > 0 && arr[i - 1] !== p - 1) acc.push('...');
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) => p === '...'
                ? <span key={`e${i}`} style={{ color: 'var(--text-muted)', padding: '0 4px' }}>…</span>
                : <button key={p} onClick={() => goPage(p)}
                    style={{ ...paginBtn(false), ...(p === page ? { background: NEON, color: '#000', borderColor: NEON } : {}) }}>
                    {p}
                  </button>
              )
            }

            <button onClick={() => goPage(page + 1)} disabled={page === data.totalPages}
              style={paginBtn(page === data.totalPages)}>Next ›</button>
            <button onClick={() => goPage(data.totalPages)} disabled={page === data.totalPages}
              style={paginBtn(page === data.totalPages)}>»</button>

            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 8 }}>
              Page {page} of {data.totalPages} · {data.totalDates} dates total
            </span>
          </div>
        )}
      </main>

      {/* ── FOOTER ───────────────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '24px', textAlign: 'center', marginTop: '40px' }}>
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          vFootball Terminal · Real-time results powered by AI extraction ·{' '}
          <a href="/admin" style={{ color: PURPLE, textDecoration: 'none' }}>Admin</a>
        </p>
      </footer>
    </div>
  );
}

// ── Pagination button style helper ─────────────────────────────────────────
function paginBtn(disabled) {
  return {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    borderRadius: 8, padding: '7px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.82rem', fontWeight: 600, transition: 'all 0.2s ease',
    opacity: disabled ? 0.4 : 1,
  };
}

// ── Quick stats bar ────────────────────────────────────────────────────────
function QuickStats({ matches }) {
  const stats = matches.reduce((acc, m) => {
    const s = parseScore(m.score);
    acc.total += s.total;
    if (s.home > s.away) acc.homeWins++;
    else if (s.away > s.home) acc.awayWins++;
    else acc.draws++;
    return acc;
  }, { total: 0, homeWins: 0, awayWins: 0, draws: 0 });

  const avg = matches.length > 0 ? (stats.total / matches.length).toFixed(1) : 0;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: '16px',
    }}>
      {[
        { label: 'Avg Goals/Match', value: avg, color: NEON },
        { label: 'Home Wins', value: stats.homeWins, color: GREEN },
        { label: 'Draws', value: stats.draws, color: GOLD },
        { label: 'Away Wins', value: stats.awayWins, color: RED },
      ].map(s => (
        <div key={s.label} style={{
          background: `${s.color}08`, border: `1px solid ${s.color}25`,
          borderRadius: 10, padding: '10px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 900, color: s.color }}>{s.value}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Analysis Panel with Charts ────────────────────────────────────────────
function AnalysisPanel({ id, analysis, date, matches }) {
  const [activeTab, setActiveTab] = useState('overview');

  // Build chart data from analysis + raw match data
  const winnerChartData = {
    labels: ['Home Wins', 'Draws', 'Away Wins'],
    datasets: [{
      data: [analysis.winnerStats?.homeWins || 0, analysis.winnerStats?.draws || 0, analysis.winnerStats?.awayWins || 0],
      backgroundColor: [`${GREEN}CC`, `${GOLD}CC`, `${RED}CC`],
      borderColor: [GREEN, GOLD, RED],
      borderWidth: 2,
    }],
  };

  const goalDistData = {
    labels: Object.keys(analysis.goalDistribution || {}),
    datasets: [{
      label: 'Matches',
      data: Object.values(analysis.goalDistribution || {}),
      backgroundColor: [NEON, GREEN, GOLD, PURPLE, RED].map(c => `${c}99`),
      borderColor: [NEON, GREEN, GOLD, PURPLE, RED],
      borderWidth: 2,
      borderRadius: 6,
    }],
  };

  const topScorerData = {
    labels: (analysis.topScorers || []).slice(0, 8).map(t => t.team),
    datasets: [
      {
        label: 'Goals Scored',
        data: (analysis.topScorers || []).slice(0, 8).map(t => t.goalsScored),
        backgroundColor: `${GREEN}99`,
        borderColor: GREEN,
        borderWidth: 2,
        borderRadius: 4,
      },
      {
        label: 'Goals Conceded',
        data: (analysis.topScorers || []).slice(0, 8).map(t => t.goalsConceded),
        backgroundColor: `${RED}99`,
        borderColor: RED,
        borderWidth: 2,
        borderRadius: 4,
      },
    ],
  };

  // Radar: team performance
  const radarData = analysis.topScorers?.length >= 3 ? {
    labels: ['Attack', 'Defence', 'Consistency', 'Form', 'Goals/Match'],
    datasets: (analysis.topScorers || []).slice(0, 4).map((t, i) => {
      const colors = [NEON, GREEN, GOLD, PURPLE];
      const c = colors[i % colors.length];
      const scored = t.goalsScored || 0;
      const conceded = t.goalsConceded || 0;
      return {
        label: t.team,
        data: [
          Math.min(10, scored * 1.5),
          Math.max(0, 10 - conceded * 1.2),
          Math.min(10, (scored + (10 - conceded)) / 2),
          Math.min(10, scored * 1.2 + (10 - conceded) * 0.8),
          Math.min(10, scored),
        ],
        backgroundColor: `${c}22`,
        borderColor: c,
        borderWidth: 2,
        pointBackgroundColor: c,
        pointRadius: 3,
      };
    }),
  } : null;

  const TABS = ['overview', 'charts', 'insights'];

  return (
    <div id={id} style={{
      marginTop: 20,
      background: 'linear-gradient(135deg, rgba(167,139,250,0.04) 0%, rgba(0,0,0,0.3) 100%)',
      border: '1px solid rgba(167,139,250,0.2)', borderRadius: 12, overflow: 'hidden',
    }}>
      {/* Analysis header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(167,139,250,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '1.3rem' }}>🤖</span>
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: PURPLE }}>DeepSeek AI Analysis</div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{date} · {matches.length} matches analysed</div>
          </div>
          {analysis.formRating && (
            <span style={{
              background: `${PURPLE}20`, border: `1px solid ${PURPLE}40`,
              borderRadius: 20, padding: '3px 12px', fontSize: '0.72rem',
              color: PURPLE, fontWeight: 700, marginLeft: 4,
            }}>
              {analysis.formRating.label} · {analysis.formRating.score}/10
            </span>
          )}
        </div>
        {/* Tab nav */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              style={{
                background: activeTab === t ? PURPLE : 'transparent',
                color: activeTab === t ? '#000' : 'var(--text-secondary)',
                border: 'none', borderRadius: 6, padding: '5px 12px',
                cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700,
                textTransform: 'capitalize', transition: 'all 0.15s ease',
              }}>
              {t === 'overview' ? '📋 Overview' : t === 'charts' ? '📊 Charts' : '💡 Insights'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '20px' }}>

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Summary */}
            <p style={{
              margin: 0, fontSize: '0.88rem', color: 'var(--text-primary)', lineHeight: 1.7,
              padding: '14px 18px', background: 'rgba(167,139,250,0.06)',
              border: '1px solid rgba(167,139,250,0.15)', borderRadius: 10,
            }}>{analysis.summary}</p>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
              {[
                { icon: '⚽', label: 'Avg Goals/Match', value: analysis.avgGoalsPerMatch?.toFixed(1) || '—', color: NEON },
                { icon: '🏆', label: 'Highest Scoring', value: analysis.highestScoring?.score || '—', sub: analysis.highestScoring?.teams, color: GREEN },
                { icon: '🛡️', label: 'Lowest Scoring', value: analysis.lowestScoring?.score || '—', sub: analysis.lowestScoring?.teams, color: GOLD },
                { icon: '🏠', label: 'Home Wins', value: analysis.winnerStats?.homeWins || 0, color: GREEN },
                { icon: '🤝', label: 'Draws', value: analysis.winnerStats?.draws || 0, color: GOLD },
                { icon: '✈️', label: 'Away Wins', value: analysis.winnerStats?.awayWins || 0, color: RED },
              ].map(s => (
                <div key={s.label} style={{ background: `${s.color}09`, border: `1px solid ${s.color}20`, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <span>{s.icon}</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.label}</span>
                  </div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 900, color: s.color }}>{s.value}</div>
                  {s.sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sub}</div>}
                </div>
              ))}
            </div>

            {/* Prediction */}
            {analysis.prediction && (
              <div style={{ display: 'flex', gap: '10px', padding: '12px 16px', background: 'rgba(255,215,0,0.05)', border: '1px solid rgba(255,215,0,0.2)', borderRadius: 10 }}>
                <span style={{ fontSize: '1.2rem', flexShrink: 0 }}>🔮</span>
                <div>
                  <div style={{ fontSize: '0.7rem', color: GOLD, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Pattern Prediction</div>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{analysis.prediction}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── CHARTS TAB ──────────────────────────────────────────────────── */}
        {activeTab === 'charts' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              {/* Doughnut: Win/Draw/Loss */}
              <ChartCard title="🏆 Result Distribution">
                <div style={{ height: 200 }}>
                  <Doughnut data={winnerChartData} options={{
                    ...CHART_OPTS,
                    cutout: '65%',
                    plugins: {
                      ...CHART_OPTS.plugins,
                      legend: { ...CHART_OPTS.plugins.legend, position: 'bottom' },
                    },
                  }} />
                </div>
              </ChartCard>

              {/* Polar Area: Goal score types */}
              <ChartCard title="⚽ Goal Distribution">
                <div style={{ height: 200 }}>
                  <PolarArea data={goalDistData} options={{
                    ...CHART_OPTS,
                    scales: { r: { ticks: { color: '#3A4A5A', backdropColor: 'transparent' }, grid: { color: 'rgba(255,255,255,0.06)' } } },
                    plugins: { ...CHART_OPTS.plugins, legend: { ...CHART_OPTS.plugins.legend, position: 'bottom' } },
                  }} />
                </div>
              </ChartCard>
            </div>

            {/* Bar: Team attack/defence */}
            {analysis.topScorers?.length > 0 && (
              <ChartCard title="📊 Team Attack vs Defence">
                <div style={{ height: 220 }}>
                  <Bar data={topScorerData} options={{
                    ...CHART_OPTS,
                    scales: {
                      x: { ticks: { color: '#7A8AA0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                      y: { ticks: { color: '#7A8AA0' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    },
                    plugins: { ...CHART_OPTS.plugins, legend: { ...CHART_OPTS.plugins.legend, position: 'top' } },
                  }} />
                </div>
              </ChartCard>
            )}

            {/* Radar: Team comparison */}
            {radarData && (
              <ChartCard title="🕸️ Performance Radar (Top 4 Teams)">
                <div style={{ height: 260 }}>
                  <Radar data={radarData} options={{
                    ...CHART_OPTS,
                    scales: {
                      r: {
                        min: 0, max: 10,
                        ticks: { stepSize: 2, color: '#3A4A5A', backdropColor: 'transparent', font: { size: 9 } },
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        pointLabels: { color: '#7A8AA0', font: { size: 10 } },
                      },
                    },
                    plugins: { ...CHART_OPTS.plugins, legend: { ...CHART_OPTS.plugins.legend, position: 'bottom' } },
                  }} />
                </div>
              </ChartCard>
            )}
          </div>
        )}

        {/* ── INSIGHTS TAB ────────────────────────────────────────────────── */}
        {activeTab === 'insights' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {(analysis.keyInsights || []).map((insight, i) => (
              <div key={i} style={{
                display: 'flex', gap: '12px', alignItems: 'flex-start',
                padding: '14px 16px',
                background: i % 2 === 0 ? 'rgba(0,229,255,0.04)' : 'rgba(167,139,250,0.04)',
                border: `1px solid ${i % 2 === 0 ? 'rgba(0,229,255,0.12)' : 'rgba(167,139,250,0.12)'}`,
                borderRadius: 10, animation: `slide-in 0.3s ease ${i * 0.08}s both`,
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                  background: i % 2 === 0 ? `${NEON}20` : `${PURPLE}20`,
                  border: `1px solid ${i % 2 === 0 ? NEON : PURPLE}40`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.72rem', fontWeight: 900,
                  color: i % 2 === 0 ? NEON : PURPLE,
                }}>
                  {i + 1}
                </div>
                <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{insight}</p>
              </div>
            ))}

            {/* Dominant teams */}
            {analysis.dominantTeams?.length > 0 && (
              <div style={{ marginTop: 4, padding: '12px 16px', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: 10 }}>
                <div style={{ fontSize: '0.7rem', color: GREEN, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                  🏅 Dominant Teams Today
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {analysis.dominantTeams.map((t, i) => (
                    <span key={t} style={{
                      background: `${GREEN}15`, border: `1px solid ${GREEN}30`,
                      borderRadius: 20, padding: '4px 14px',
                      fontSize: '0.8rem', fontWeight: 700, color: GREEN,
                    }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chart card wrapper ─────────────────────────────────────────────────────
function ChartCard({ title, children }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {title}
      </div>
      {children}
    </div>
  );
}
