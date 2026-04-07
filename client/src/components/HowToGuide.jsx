import React, { useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// HowToGuide — Contextual sidebar guide that explains the active tab's
// scraping architecture in human-friendly language.
// Props:
//   activeTab: 'live' | 'history'
// ─────────────────────────────────────────────────────────────────────────────

const GUIDES = {
  live: {
    title: 'Live Odds — How It Works',
    dotColor: 'var(--accent-live)',
    animated: true,
    steps: [
      {
        label: 'Stealth Browser Launch',
        body: 'On server start, Puppeteer-Core launches a headless Chrome window that disguises itself as a real user session (spoofed User-Agent + hidden webdriver flag).',
      },
      {
        label: 'DOM Hydration Wait',
        body: 'After navigation, we wait for network-idle to allow vFootball\'s dynamic JS widgets to fully render odds into the DOM.',
      },
      {
        label: 'Text-Node Parser',
        body: 'Every 5 seconds, we read the raw innerText of the page and extract match rows by detecting "ID: XXXXX" markers — making it resistant to CSS class obfuscation.',
      },
      {
        label: 'Memory Cache + Push',
        body: 'Parsed results are stored in a server-side variable. The frontend polls /api/scores every 2 seconds for the latest odds snapshot.',
      },
    ],
    note: {
      color: 'var(--accent-neon)',
      bg: 'rgba(0, 229, 255, 0.07)',
      border: 'rgba(0, 229, 255, 0.2)',
      text: 'Live odds update in ~2–5s. If the scraper detects a WAF block, it retries silently without crashing.',
    },
  },
  history: {
    title: 'Previous Results — How It Works',
    dotColor: 'var(--accent-purple)',
    animated: false,
    steps: [
      {
        label: 'On-Demand Ephemeral Browser',
        body: 'Unlike the live scraper, each /api/vfootball/history request launches a brand-new Puppeteer window for clean, isolated DOM state with no cross-request contamination.',
      },
      {
        label: 'vFootball Tab Click',
        body: 'The scraper navigates to the SportyBet Results portal, then programmatically clicks the vFootball tab selector using robust multi-selector search logic.',
      },
      {
        label: 'Pagination DOM Clicks',
        body: 'To reach page N, the scraper loops and clicks the "Load More" button (N-1) times, waiting 2.5 seconds between each click for DOM hydration.',
      },
      {
        label: 'Smart Parse + Fallback',
        body: 'Results are extracted first via class-selector heuristics, then by raw pattern matching. If both return 0 matches, realistic mock data is served so the UI never breaks.',
      },
      {
        label: 'Close & Respond',
        body: 'The ephemeral browser is closed immediately after parsing to prevent memory leaks. The JSON response is returned to the frontend for rendering.',
      },
    ],
    note: {
      color: 'var(--accent-gold)',
      bg: 'rgba(255, 215, 0, 0.06)',
      border: 'rgba(255, 215, 0, 0.2)',
      text: 'Deeper pages take longer: ~5s base + 2.5s per page click. Page 5 ≈ 15s.',
    },
  },
};

export default function HowToGuide({ activeTab = 'live' }) {
  const [expanded, setExpanded] = useState(null);
  const guide = GUIDES[activeTab] ?? GUIDES.live;

  const toggleStep = (idx) => {
    console.log(`[DEBUG] [HowToGuide] Toggling step ${idx} on "${activeTab}" guide`);
    setExpanded((prev) => (prev === idx ? null : idx));
  };

  return (
    <div className="glass-panel" style={{ position: 'sticky', top: '40px' }}>
      {/* Header */}
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.95rem', fontWeight: 700 }}>
        <span
          className="pulse-dot"
          style={{
            backgroundColor: guide.dotColor,
            boxShadow: `0 0 8px ${guide.dotColor}`,
            animation: guide.animated ? undefined : 'none',
          }}
        />
        {guide.title}
      </h3>

      {/* Steps — collapsible accordion */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '16px' }}>
        {guide.steps.map((step, idx) => (
          <div
            key={idx}
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--glass-border)',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              transition: 'border-color 0.2s',
              borderColor: expanded === idx ? 'rgba(255,255,255,0.14)' : 'var(--glass-border)',
            }}
          >
            {/* Step header (clickable) */}
            <button
              id={`guide-step-${activeTab}-${idx}`}
              onClick={() => toggleStep(idx)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                fontFamily: 'Inter, sans-serif',
                textAlign: 'left',
              }}
            >
              <span style={{
                flexShrink: 0,
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: `rgba(255,255,255,0.06)`,
                border: '1px solid var(--glass-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.72rem',
                fontWeight: 700,
                color: 'var(--text-secondary)',
              }}>
                {idx + 1}
              </span>
              <span style={{ fontSize: '0.84rem', fontWeight: 600, flex: 1 }}>{step.label}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', flexShrink: 0 }}>
                {expanded === idx ? '▲' : '▼'}
              </span>
            </button>

            {/* Step body */}
            {expanded === idx && (
              <div style={{
                padding: '0 14px 12px 46px',
                fontSize: '0.82rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.65,
                borderTop: '1px solid var(--glass-border)',
                marginTop: 0,
                paddingTop: '10px',
              }}>
                {step.body}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Callout note */}
      <div style={{
        marginTop: '20px',
        padding: '12px 14px',
        background: guide.note.bg,
        border: `1px solid ${guide.note.border}`,
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.82rem',
        color: guide.note.color,
        lineHeight: 1.55,
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
      }}>
        <span style={{ flexShrink: 0 }}>💡</span>
        <span>{guide.note.text}</span>
      </div>
    </div>
  );
}
