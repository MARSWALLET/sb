import React, { useState, useEffect, useCallback } from 'react';
import AIProviderSelector from './AIProviderSelector';
import PatternPerformance from './PatternPerformance';

const NEON='#00E5FF', GREEN='#00FF88', GOLD='#FFD700', PURPLE='#A78BFA', RED='#FF3355', ORANGE='#FF6B35';
const LEAGUES={'England - Virtual':{icon:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',color:NEON},'Germany - Virtual':{icon:'🇩🇪',color:GOLD},'Italy - Virtual':{icon:'🇮🇹',color:GREEN},'Spain - Virtual':{icon:'🇪🇸',color:RED},'France - Virtual':{icon:'🇫🇷',color:ORANGE}};
const lc=(lg)=>LEAGUES[lg]?.color||PURPLE;
const li=(lg)=>LEAGUES[lg]?.icon||'🌐';

function NavBar(){
  const links=[{href:'/',label:'🧠 Pattern Intel',c:GREEN},{href:'/results',label:'📊 Results',c:NEON},{href:'/daily-tips',label:'🔮 Daily Tips',c:PURPLE},{href:'/behaviour',label:'🧬 Behaviour',c:GOLD},{href:'/admin',label:'⚙️ Admin',c:'rgba(255,255,255,0.4)'}];
  const cur=window.location.pathname;
  return(
    <nav style={{background:'rgba(0,0,0,0.4)',borderBottom:'1px solid rgba(255,255,255,0.07)',padding:'0 24px',display:'flex',alignItems:'center',gap:4,overflowX:'auto'}}>
      <div style={{fontWeight:900,fontSize:'1rem',color:NEON,padding:'14px 16px 14px 0',marginRight:8,whiteSpace:'nowrap',flexShrink:0}}>vFootball <span style={{color:PURPLE}}>Terminal</span></div>
      {links.map(l=><a key={l.href} href={l.href} style={{color:cur===l.href?l.c:'rgba(255,255,255,0.5)',fontWeight:cur===l.href?800:500,fontSize:'0.82rem',padding:'14px',textDecoration:'none',whiteSpace:'nowrap',borderBottom:cur===l.href?`2px solid ${l.c}`:'2px solid transparent',transition:'all 0.2s',flexShrink:0}}>{l.label}</a>)}
    </nav>
  );
}

function OutcomePill({o}){
  const cm={Win:GREEN,Loss:RED,Draw:GOLD,'Over 1.5':NEON,'Over 2.5':ORANGE,'GG (BTTS)':PURPLE,'Home Scores':'#00BFFF','Away Scores':'#FF69B4'};
  const c=cm[o.label]||NEON;
  return(
    <div style={{display:'flex',alignItems:'center',gap:6,padding:'6px 12px',borderRadius:8,background:`${c}12`,border:`1px solid ${c}40`}}>
      <span style={{fontSize:'1rem'}}>{o.emoji}</span>
      <div>
        <div style={{fontSize:'0.78rem',fontWeight:800,color:c}}>{o.label}</div>
        <div style={{fontSize:'0.65rem',color:'rgba(255,255,255,0.5)'}}>{o.pct}% · {o.hit}✓ {o.failed}✗</div>
      </div>
    </div>
  );
}

function PatternCard({pattern,isHistory,isLive}){
  // Default to expanded when in Live tab so everything is immediately visible
  const [expanded,setExpanded]=useState(isLive ? true : false);
  const [aiPrediction,setAiPrediction]=useState(null);
  const [loadingAi,setLoadingAi]=useState(false);
  const t=pattern.mostRecentTrigger;
  const c=lc(pattern.league);
  const top=pattern.eliteOutcomes?.[0];
  const resolved=pattern.resolved;

  const handleAiPredict=async(e)=>{
    e.stopPropagation();
    if(aiPrediction||loadingAi)return;
    setLoadingAi(true);
    console.log(`[PatternCard] 🤖 Requesting AI tip for ${pattern.team}...`);
    try{
      const res=await fetch('/api/ai-predict-pattern',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pattern})});
      const json=await res.json();
      if(json.success){setAiPrediction({text:json.prediction,provider:json.provider});console.log('[PatternCard] ✅ AI tip received');}
      else throw new Error(json.error||'AI failed');
    }catch(err){console.error('[PatternCard] ❌',err.message);alert('AI Error: '+err.message);}
    finally{setLoadingAi(false);}
  };

  return(
    <div style={{background:'rgba(255,255,255,0.02)',border:`1px solid ${c}25`,borderRadius:12,overflow:'hidden',marginBottom:10}}>
      <div onClick={()=>setExpanded(e=>!e)} style={{padding:'14px 16px',cursor:'pointer',display:'flex',alignItems:'center',gap:12,background:`linear-gradient(90deg,${c}08,transparent)`}}>
        <div style={{fontSize:'1.6rem',fontWeight:900,fontFamily:'monospace',color:c,minWidth:56,textAlign:'center',background:`${c}15`,borderRadius:8,padding:'3px 7px'}}>{pattern.score}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:'0.7rem',color:c,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.07em'}}>{li(pattern.league)} {pattern.league.replace(' - Virtual','')} · <strong style={{color:'white'}}>{pattern.team} WAS {pattern.role.toUpperCase()}</strong></div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:2,flexWrap:'wrap'}}>
            <span style={{fontSize:'0.75rem',color:'rgba(255,255,255,0.55)'}}>{pattern.sampleSize} samples · {pattern.eliteOutcomes?.length} elite outcome{pattern.eliteOutcomes?.length>1?'s':''}</span>
            {t&&<span style={{fontSize:'0.68rem',color:c,background:`${c}18`,border:`1px solid ${c}35`,borderRadius:20,padding:'1px 8px',fontWeight:700,fontFamily:'monospace'}}>🕐 {t.triggerTime}</span>}
          </div>
        </div>
        {top&&<div style={{textAlign:'right',flexShrink:0}}>
          <div style={{fontSize:'1.3rem',fontWeight:900,color:GREEN}}>{top.pct}%</div>
          <div style={{fontSize:'0.6rem',color:'rgba(255,255,255,0.4)'}}>{top.emoji} {top.label}</div>
        </div>}
        {resolved&&<div style={{fontSize:'0.65rem',padding:'3px 8px',background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.3)',borderRadius:20,color:GREEN,flexShrink:0}}>✓ Resolved</div>}
        <span style={{color:'rgba(255,255,255,0.3)',transform:expanded?'rotate(180deg)':'none',transition:'transform 0.2s'}}>⏄</span>
      </div>

      {/* ── Expanded Content ── */}
      {expanded&&(
        <div style={{padding:'0 16px 16px',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
          
          {/* Elite Outcomes Grid */}
          <div style={{marginTop:16}}>
            <div style={{fontSize:'0.62rem',color:'rgba(255,255,255,0.3)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>🎯 Elite Outcomes (Next Match)</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
              {pattern.eliteOutcomes?.map(o=><OutcomePill key={o.key} o={o}/>)}
            </div>
          </div>

          {/* Most Recent Trigger */}
          {t&&<div style={{marginTop:16,padding:12,background:'rgba(0,0,0,0.3)',borderRadius:10,border:`1px solid ${c}20`}}>
            <div style={{fontSize:'0.62rem',color:c,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:6,fontWeight:700}}>📍 Most Recent Trigger — {t.triggerDate} {t.triggerTime}</div>
            <div style={{fontSize:'0.83rem',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <span style={{color:'rgba(255,255,255,0.7)'}}>{t.triggerHomeTeam}</span>
              <span style={{fontWeight:900,color:c,fontFamily:'monospace',padding:'2px 8px',background:`${c}15`,borderRadius:6}}>{t.triggerScore}</span>
              <span style={{color:'rgba(255,255,255,0.7)'}}>{t.triggerAwayTeam}</span>
              <span style={{fontSize:'0.7rem',color:'rgba(255,255,255,0.4)',marginLeft:8}}>({pattern.team} was {pattern.role})</span>
            </div>
          </div>}

          {/* Detailed Prediction Breakdown Box */}
          <div style={{marginTop:16,padding:14,background:`${c}05`,borderRadius:10,border:`1px solid ${c}25`}}>
            <div style={{fontSize:'0.68rem',color:GREEN,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8,fontWeight:800}}>🔮 Predicted Signal for {pattern.team}'s Next Match</div>
            <div style={{fontSize:'0.8rem',color:'rgba(255,255,255,0.7)',marginBottom:12,lineHeight:1.4}}>
              Based on <strong style={{color:'white'}}>{pattern.sampleSize}</strong> historical cases where <strong style={{color:c}}>{pattern.team}</strong> played a match ending <strong style={{color:'white'}}>{pattern.score}</strong> as the {pattern.role} team:
            </div>
            
            <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
              {pattern.eliteOutcomes?.map(o=>(
                <div key={`pred-${o.key}`} style={{display:'inline-flex',alignItems:'center',gap:8,padding:'6px 12px',background:`${GREEN}15`,border:`1px solid ${GREEN}40`,borderRadius:20,width:'fit-content'}}>
                  <span style={{fontSize:'0.85rem'}}>{o.emoji}</span>
                  <span style={{fontSize:'0.78rem',color:GREEN,fontWeight:700}}>{o.label} — {o.pct}% likely</span>
                </div>
              ))}
            </div>

            {/* Historical Trigger Rows — only show ones that have a resolved next match */}
            {(() => {
              // Filter out triggers that have no nextScore (e.g. the live today trigger)
              const resolvedTriggers = (pattern.recentTriggers || [])
                .filter(rt => rt.nextScore && rt.triggerDate !== pattern.mostRecentTrigger?.triggerDate)
                .slice(0, 3);
              if (resolvedTriggers.length === 0) return null;
              return (
                <div>
                  <div style={{fontSize:'0.65rem',color:'rgba(255,255,255,0.4)',marginBottom:8}}>Recent matches that triggered this pattern:</div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {resolvedTriggers.map((rt, i) => (
                      <div key={i} style={{display:'flex',alignItems:'center',gap:10,fontSize:'0.75rem',color:'rgba(255,255,255,0.6)',background:'rgba(0,0,0,0.2)',padding:'6px 10px',borderRadius:6,flexWrap:'wrap'}}>
                        <span style={{minWidth:72,color:'rgba(255,255,255,0.4)'}}>{rt.triggerDate}</span>
                        <div style={{display:'flex',gap:5,alignItems:'center',flex:1}}>
                          <span style={{color:rt.triggerHomeTeam===pattern.team?'white':'rgba(255,255,255,0.5)',fontWeight:rt.triggerHomeTeam===pattern.team?700:400}}>{rt.triggerHomeTeam}</span>
                          <span style={{color:c,fontWeight:900,fontFamily:'monospace',padding:'1px 6px',background:`${c}15`,borderRadius:4}}>{rt.triggerScore}</span>
                          <span style={{color:rt.triggerAwayTeam===pattern.team?'white':'rgba(255,255,255,0.5)',fontWeight:rt.triggerAwayTeam===pattern.team?700:400}}>{rt.triggerAwayTeam}</span>
                          <span style={{fontSize:'0.6rem',color:'rgba(255,255,255,0.3)'}}>({rt.triggerRole})</span>
                        </div>
                        <span style={{color:GOLD,fontFamily:'monospace',fontWeight:700}}>→ next: {rt.nextScore}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Resolved Check (For History tab) */}
          {resolved&&pattern.resolvedScore&&(
            <div style={{marginTop:16,padding:12,background:'rgba(0,255,136,0.05)',borderRadius:10,border:'1px solid rgba(0,255,136,0.2)'}}>
              <div style={{fontSize:'0.62rem',color:GREEN,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:6,fontWeight:700}}>✅ Resolved Next Match — {pattern.resolvedDate}</div>
              <div style={{fontSize:'0.83rem',fontFamily:'monospace',color:GREEN,fontWeight:800}}>{pattern.resolvedScore}</div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:8}}>
                {Object.entries(pattern.outcomeResults||{}).map(([label,hit])=>(
                  <span key={label} style={{fontSize:'0.68rem',padding:'2px 8px',borderRadius:20,background:hit?'rgba(0,255,136,0.1)':'rgba(255,51,85,0.1)',border:`1px solid ${hit?GREEN:RED}40`,color:hit?GREEN:RED}}>{hit?'✓':'✗'} {label}</span>
                ))}
              </div>
            </div>
          )}

          {/* AI Tip Button */}
          {!isHistory&&!aiPrediction&&(
            <button onClick={handleAiPredict} disabled={loadingAi} style={{marginTop:16,padding:'8px 16px',background:`${NEON}15`,border:`1px solid ${NEON}40`,borderRadius:6,color:NEON,fontWeight:700,fontSize:'0.75rem',cursor:loadingAi?'not-allowed':'pointer',opacity:loadingAi?0.6:1}}>
              {loadingAi?'⏳ Analysing...':'✨ Generate AI Betting Tip'}
            </button>
          )}
          {/* AI Tip Result */}
          {aiPrediction&&(
            <div style={{marginTop:16,padding:14,background:'rgba(255,255,255,0.04)',borderRadius:8,border:'1px solid rgba(255,255,255,0.1)'}}>
              <div style={{fontSize:'0.62rem',color:GOLD,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:6,fontWeight:700}}>🤖 AI Tip (via {aiPrediction.provider})</div>
              <div style={{fontSize:'0.82rem',color:'rgba(255,255,255,0.88)',lineHeight:1.6}}>{aiPrediction.text}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PatternList({patterns,loading,error,onReload,isHistory,flatMode}){
  const [currentIndex, setCurrentIndex] = useState(0);
  const [touchStart, setTouchStart] = useState(null);
  const [touchEnd, setTouchEnd] = useState(null);

  useEffect(() => {
    // eslint-disable-next-line
    setCurrentIndex(0);
    console.log(`[PatternList] 🔄 Patterns updated, resetting index to 0. Total patterns: ${patterns?.length || 0}`);
  }, [patterns]);

  if(loading)return(<div style={{textAlign:'center',padding:'60px 0'}}><div style={{width:40,height:40,border:`3px solid ${GREEN}15`,borderTopColor:GREEN,borderRadius:'50%',animation:'spin 1s linear infinite',margin:'0 auto 12px'}}/><p style={{color:'rgba(255,255,255,0.4)',fontSize:'0.85rem'}}>Scanning for patterns...</p></div>);
  if(error)return(<div style={{padding:24,textAlign:'center',background:'rgba(255,51,85,0.05)',border:`1px solid ${RED}30`,borderRadius:12}}><div style={{fontSize:'2rem',marginBottom:8}}>⚠️</div><div style={{color:RED,fontWeight:700,marginBottom:6}}>Failed to load</div><div style={{color:'rgba(255,255,255,0.4)',fontSize:'0.8rem',marginBottom:12}}>{error}</div><button onClick={onReload} style={{background:RED,color:'white',border:'none',borderRadius:8,padding:'8px 20px',cursor:'pointer',fontWeight:700}}>↺ Retry</button></div>);
  if(!patterns||patterns.length===0)return(<div style={{textAlign:'center',padding:'50px 0'}}><div style={{fontSize:'3rem',marginBottom:12}}>📭</div><div style={{fontSize:'0.95rem',fontWeight:700,color:'rgba(255,255,255,0.4)',marginBottom:6}}>No active predictions</div><div style={{fontSize:'0.8rem',color:'rgba(255,255,255,0.25)'}}>No matches today triggered a high-probability pattern yet, or adjust the Min % threshold.</div></div>);

  const handlePrev = () => {
    try {
      console.log(`[PatternList] ◀️ Navigating to previous pattern. Current index: ${currentIndex}`);
      setCurrentIndex((prev) => (prev > 0 ? prev - 1 : patterns.length - 1));
    } catch (e) {
      console.error('[PatternList] ❌ Error in handlePrev:', e);
    }
  };

  const handleNext = () => {
    try {
      console.log(`[PatternList] ▶️ Navigating to next pattern. Current index: ${currentIndex}`);
      setCurrentIndex((prev) => (prev < patterns.length - 1 ? prev + 1 : 0));
    } catch (e) {
      console.error('[PatternList] ❌ Error in handleNext:', e);
    }
  };

  const onTouchStart = (e) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const onTouchMove = (e) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const onTouchEndHandler = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe) {
      handleNext();
    } else if (isRightSwipe) {
      handlePrev();
    }
  };

  const currentPattern = patterns[currentIndex];
  if (!currentPattern) return null; // Safe fallback

  const btnStyle = {
    background: `rgba(255,255,255,0.05)`,
    border: `1px solid rgba(255,255,255,0.1)`,
    borderRadius: '50%',
    width: 48,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'white',
    fontSize: '1.2rem',
    transition: 'all 0.2s ease',
    outline: 'none',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    flexShrink: 0,
    zIndex: 10
  };

  const btnHover = (e) => {
    e.currentTarget.style.background = `rgba(0, 229, 255, 0.15)`;
    e.currentTarget.style.borderColor = `rgba(0, 229, 255, 0.4)`;
    e.currentTarget.style.transform = 'scale(1.05)';
  };
  
  const btnLeave = (e) => {
    e.currentTarget.style.background = `rgba(255,255,255,0.05)`;
    e.currentTarget.style.borderColor = `rgba(255,255,255,0.1)`;
    e.currentTarget.style.transform = 'scale(1)';
  };

  return (
    <div style={{position: 'relative', padding: '10px 0'}}>
      <style>{`@media (max-width: 768px) { .carousel-arrow { display: none !important; } }`}</style>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}}>
        <div style={{fontSize: '0.85rem', color: 'rgba(255,255,255,0.5)', fontWeight: 600}}>
          <span style={{color: NEON}}>Pattern Carousel</span> — Viewing {currentIndex + 1} of {patterns.length}
        </div>
        <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
          <div style={{fontSize: '0.8rem', fontWeight: 800, color: 'white', background: 'rgba(255,255,255,0.1)', padding: '4px 12px', borderRadius: 20}}>
            {Math.round(((currentIndex + 1) / patterns.length) * 100)}%
          </div>
        </div>
      </div>

      <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
        {patterns.length > 1 && (
          <button 
            className="carousel-arrow"
            onClick={handlePrev} 
            onMouseEnter={btnHover} 
            onMouseLeave={btnLeave}
            style={btnStyle}
            title="Previous Pattern"
          >
            ◀
          </button>
        )}
        
        <div 
          style={{flex: 1, minWidth: 0, position: 'relative', animation: 'fadeIn 0.4s ease-out', key: currentIndex, touchAction: 'pan-y'}}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEndHandler}
        >
          {/* Include context banner if in history mode (which used grouped mode) */}
          {!flatMode && currentPattern.league && (
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <div style={{width:3,height:22,background:lc(currentPattern.league),borderRadius:3}}/>
              <span style={{fontSize:'0.95rem',fontWeight:800,color:lc(currentPattern.league)}}>{li(currentPattern.league)} {currentPattern.league}</span>
              <div style={{flex:1,height:1,background:'rgba(255,255,255,0.04)'}}/>
            </div>
          )}
          
          <PatternCard 
            pattern={currentPattern} 
            isHistory={isHistory} 
            isLive={!isHistory}
          />
        </div>

        {patterns.length > 1 && (
          <button 
            className="carousel-arrow"
            onClick={handleNext} 
            onMouseEnter={btnHover} 
            onMouseLeave={btnLeave}
            style={btnStyle}
            title="Next Pattern"
          >
            ▶
          </button>
        )}
      </div>
      
      {/* Indicator dots */}
      {patterns.length > 1 && patterns.length <= 30 && (
        <div style={{display: 'flex', justifyContent: 'center', gap: 6, marginTop: 20, flexWrap: 'wrap'}}>
          {patterns.map((_, idx) => (
            <div 
              key={idx} 
              onClick={() => {
                console.log(`[PatternList] 🔵 Navigating to specific dot index: ${idx}`);
                setCurrentIndex(idx);
              }}
              style={{
                width: idx === currentIndex ? 24 : 8,
                height: 8,
                borderRadius: 4,
                background: idx === currentIndex ? NEON : 'rgba(255,255,255,0.15)',
                cursor: 'pointer',
                transition: 'all 0.3s ease'
              }}
              title={`Go to Pattern ${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UpcomingAiAnalysis() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchAnalysis = async (isPolling = false) => {
    if (!isPolling) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/pattern-intel/upcoming-ai-analysis');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to generate analysis');
      setData(json);
    } catch (err) {
      if (!isPolling) setError(err.message);
    } finally {
      if (!isPolling) setLoading(false);
    }
  };

  // Initial fetch on mount
  useEffect(() => { fetchAnalysis(); }, []);

  // Auto-poll every 15s when no results found
  useEffect(() => {
    if (!data || (data.analyses && data.analyses.length > 0)) return;
    const interval = setInterval(() => fetchAnalysis(true), 15000);
    return () => clearInterval(interval);
  }, [data]);

  return (
    <div style={{animation: 'fadeIn 0.5s ease'}}>
      <div style={{padding:'16px',background:'rgba(167,139,250,0.04)',border:'1px solid rgba(167,139,250,0.15)',borderRadius:12,marginBottom:24,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:16}}>
        <div>
          <div style={{fontSize:'0.8rem',color:PURPLE,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:6}}>🤖 Live Upcoming Fixture AI</div>
          <div style={{fontSize:'0.85rem',color:'rgba(255,255,255,0.6)',lineHeight:1.5,maxWidth:600}}>
            Cross-references the most elite historical patterns (&gt;80% accuracy) with the <strong>immediate upcoming betslip fixtures</strong>. Generates a consolidated expert analysis for the games starting in the next 5 minutes.
          </div>
        </div>
        <button onClick={() => fetchAnalysis(false)} disabled={loading} style={{padding:'12px 24px',background:loading?`rgba(255,255,255,0.1)`:`linear-gradient(135deg, ${PURPLE}30, ${NEON}30)`,border:`1px solid ${PURPLE}50`,borderRadius:8,color:'white',fontWeight:800,fontSize:'0.9rem',cursor:loading?'not-allowed':'pointer',boxShadow:`0 0 20px ${PURPLE}20`,transition:'all 0.3s'}}>
          {loading ? '⏳ Generating AI Analysis...' : '✨ Force Refresh'}
        </button>
      </div>

      {error && (
        <div style={{padding:20,background:'rgba(255,51,85,0.05)',border:`1px solid ${RED}30`,borderRadius:12,color:RED,fontWeight:600}}>{error}</div>
      )}

      {loading && (
        <div style={{textAlign:'center',padding:'60px 0'}}>
          <div style={{width:50,height:50,border:`4px solid ${PURPLE}20`,borderTopColor:PURPLE,borderRadius:'50%',animation:'spin 1s linear infinite',margin:'0 auto 16px',boxShadow:`0 0 30px ${PURPLE}40`}}/>
          <div style={{color:PURPLE,fontWeight:800,fontSize:'1.1rem',animation:'pulse 1.5s infinite'}}>Synthesizing AI Edge...</div>
          <div style={{color:'rgba(255,255,255,0.4)',fontSize:'0.85rem',marginTop:8}}>Analyzing odds, historical triggers, and opponent DNA.</div>
        </div>
      )}

      {!loading && data && data.message && (!data.analyses || data.analyses.length === 0) && (
        <div style={{textAlign:'center',padding:'50px 0',background:'rgba(255,255,255,0.02)',borderRadius:16,border:'1px solid rgba(255,255,255,0.05)'}}>
          <div style={{fontSize:'3rem',marginBottom:16}}>🕰️</div>
          <div style={{fontSize:'1.1rem',color:'white',fontWeight:700,marginBottom:8}}>{data.message}</div>
          <div style={{color:'rgba(255,255,255,0.4)',fontSize:'0.8rem',marginTop:12}}>Auto-refreshing in the background...</div>
        </div>
      )}

      {!loading && data && data.analyses && data.analyses.length > 0 && (

        <div style={{display:'grid',gap:20,gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))'}}>
          {data.analyses.map((item, idx) => (
            <div key={idx} style={{background:'rgba(10,15,30,0.8)',border:`1px solid ${item.color||PURPLE}40`,borderRadius:16,overflow:'hidden',boxShadow:`0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)`}}>
              <div style={{padding:'16px 20px',background:`linear-gradient(90deg, ${item.color||PURPLE}15, transparent)`,borderBottom:`1px solid rgba(255,255,255,0.05)`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:'0.7rem',color:item.color||PURPLE,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:4,display:'flex',alignItems:'center'}}>
                    {item.team} MATCH 
                    {item.time && (
                      <span style={{
                        marginLeft:8, 
                        color: item.time.includes('LIVE') ? RED : 'white', 
                        background: item.time.includes('LIVE') ? `${RED}20` : 'rgba(255,255,255,0.15)', 
                        border: item.time.includes('LIVE') ? `1px solid ${RED}50` : '1px solid transparent',
                        padding:'2px 8px', 
                        borderRadius:6, 
                        textTransform:'none',
                        display:'inline-flex',
                        alignItems:'center',
                        gap: 5
                      }}>
                        {item.time.includes('LIVE') ? (
                          <span style={{width: 6, height: 6, borderRadius: '50%', background: RED, boxShadow: `0 0 8px ${RED}`, animation: 'pulse 1.5s infinite'}} />
                        ) : '🕒 '}
                        {item.time.replace(/\s?\(LIVE\)/i, '')} {item.time.includes('LIVE') && 'LIVE'}
                      </span>
                    )}
                  </div>
                  <div style={{fontSize:'1.1rem',fontWeight:900,color:'white'}}>{item.match}</div>
                </div>
                <div style={{background:`${item.color||PURPLE}20`,color:item.color||PURPLE,padding:'6px 12px',borderRadius:20,fontWeight:900,fontSize:'0.85rem',border:`1px solid ${item.color||PURPLE}50`}}>
                  {item.signal}
                </div>
              </div>
              <div style={{padding:'20px'}}>
                <div style={{fontSize:'0.75rem',color:'rgba(255,255,255,0.4)',marginBottom:12,padding:'8px 12px',background:'rgba(0,0,0,0.4)',borderRadius:8,borderLeft:`3px solid ${item.color||PURPLE}`}}>
                  <strong style={{color:'white'}}>Trigger:</strong> {item.pattern}
                </div>
                <div style={{fontSize:'0.9rem',color:'rgba(255,255,255,0.85)',lineHeight:1.6}}>
                  {item.analysis}
                </div>
                <div style={{marginTop:16,display:'flex',alignItems:'center',gap:10}}>
                  <div style={{flex:1,height:4,background:'rgba(255,255,255,0.1)',borderRadius:2,overflow:'hidden'}}>
                    <div style={{width:`${item.confidence}%`,height:'100%',background:item.color||PURPLE,borderRadius:2}}/>
                  </div>
                  <div style={{fontSize:'0.8rem',fontWeight:800,color:item.color||PURPLE}}>{item.confidence}% Confidence</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PatternIntelligence(){
  const [tab,setTab]=useState('live');
  const [liveData,setLiveData]=useState(null);
  const [liveLoading,setLiveLoading]=useState(true);
  const [liveError,setLiveError]=useState(null);
  const [minPct,setMinPct]=useState(80);
  const [leagueFilter,setLeagueFilter]=useState('');
  const [histDates,setHistDates]=useState([]);
  const [histDate,setHistDate]=useState('');
  const [histPatterns,setHistPatterns]=useState([]);
  const [histLoading,setHistLoading]=useState(false);
  const [histError,setHistError]=useState(null);

  const loadLive=useCallback(async()=>{
    setLiveLoading(true);setLiveError(null);
    const params=new URLSearchParams({minPct,minSamples:3});
    if(leagueFilter)params.set('league',leagueFilter);
    console.log('[PatternIntel] 🔍 Fetching live patterns...',params.toString());
    try{
      const res=await fetch(`/api/pattern-intel?${params}`);
      const json=await res.json();
      if(!json.success)throw new Error(json.error||'Failed');
      console.log(`[PatternIntel] ✅ ${json.totalPatterns} live patterns, ${json.totalAllTime} all-time`);
      setLiveData(json);
    }catch(e){console.error('[PatternIntel] ❌',e.message);setLiveError(e.message);}
    setLiveLoading(false);
  },[minPct,leagueFilter]);

  useEffect(()=>{
    loadLive();
    const es=new EventSource('/api/db-stream');
    es.onmessage=(evt)=>{try{const p=JSON.parse(evt.data);if(p.type==='db-updated'){console.log('[PatternIntel] 📡 DB updated — reloading...');loadLive();}}catch(err){console.warn(err);}};
    return()=>es.close();
  },[loadLive]);

  useEffect(()=>{
    fetch('/api/pattern-intel/dates').then(r=>r.json()).then(j=>{
      if(j.success){setHistDates(j.dates);if(j.dates.length>0&&!histDate)setHistDate(j.dates[0]);}
    }).catch(e=>console.warn('[PatternIntel] dates fetch error:',e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(()=>{
    if(tab!=='history'||!histDate)return;
    setHistLoading(true);setHistError(null);
    console.log(`[PatternIntel] 📅 Loading history for ${histDate}...`);
    fetch(`/api/pattern-intel/history?date=${encodeURIComponent(histDate)}`).then(r=>r.json()).then(j=>{
      if(j.success){setHistPatterns(j.patterns);console.log(`[PatternIntel] ✅ ${j.patterns.length} snapshots for ${histDate}`);}
      else throw new Error(j.error);
    }).catch(e=>{console.error('[PatternIntel] ❌ history:',e.message);setHistError(e.message);})
    .finally(()=>setHistLoading(false));
  },[tab,histDate]);

  const leagues=liveData?[...new Set(liveData.patterns.map(p=>p.league))].sort():[];
  const TABS=[{id:'live',label:'🟢 Live Today'},{id:'upcoming-ai',label:'🤖 AI Upcoming'},{id:'history',label:'📅 History'},{id:'performance',label:'📊 Performance'}];

  return(
    <div style={{minHeight:'100vh',background:'var(--bg-primary,#0A0F1E)',fontFamily:'Inter,sans-serif',color:'white'}}>
      <NavBar/>
      <header style={{background:`linear-gradient(180deg,rgba(0,255,136,0.06) 0%,transparent 100%)`,borderBottom:'1px solid rgba(0,255,136,0.1)',padding:'28px 24px 20px'}}>
        <div style={{maxWidth:1100,margin:'0 auto',display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:16}}>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
              <div style={{width:9,height:9,borderRadius:'50%',background:GREEN,boxShadow:`0 0 10px ${GREEN}`,animation:'pulse 1.5s infinite'}}/>
              <span style={{fontSize:'0.7rem',color:GREEN,fontWeight:700,letterSpacing:'0.12em',textTransform:'uppercase'}}>Pattern Intelligence Engine</span>
            </div>
            <h1 style={{margin:'0 0 4px',fontSize:'2rem',fontWeight:900,letterSpacing:'-0.02em'}}>🧠 Score <span style={{color:GREEN,textShadow:`0 0 20px ${GREEN}55`}}>Pattern Intel</span></h1>
            <p style={{margin:0,color:'rgba(255,255,255,0.45)',fontSize:'0.85rem'}}>Live predictions · Historical archive · Performance analytics</p>
          </div>
          <div style={{width:270}}><AIProviderSelector/></div>
        </div>

        {/* Tabs */}
        <div style={{maxWidth:1100,margin:'16px auto 0',display:'flex',gap:4}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'9px 20px',borderRadius:8,border:`1px solid ${tab===t.id?GREEN:'rgba(255,255,255,0.08)'}`,background:tab===t.id?`${GREEN}15`:'transparent',color:tab===t.id?GREEN:'rgba(255,255,255,0.5)',fontWeight:tab===t.id?800:500,fontSize:'0.83rem',cursor:'pointer',transition:'all 0.2s'}}>
              {t.label}
            </button>
          ))}
          {liveData&&<div style={{marginLeft:'auto',display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
            {[{l:'Today',v:liveData.today,c:GOLD},{l:"Live Signals",v:liveData.totalPatterns,c:GREEN},{l:"All-Time",v:liveData.totalAllTime,c:NEON}].map(s=>(
              <div key={s.l} style={{background:`${s.c}10`,border:`1px solid ${s.c}25`,borderRadius:8,padding:'5px 12px',textAlign:'center'}}>
                <div style={{fontSize:'1rem',fontWeight:900,color:s.c}}>{s.v}</div>
                <div style={{fontSize:'0.58rem',color:'rgba(255,255,255,0.35)',textTransform:'uppercase'}}>{s.l}</div>
              </div>
            ))}
          </div>}
        </div>
      </header>

      <main style={{maxWidth:1100,margin:'0 auto',padding:'24px'}}>

        {/* LIVE TAB */}
        {tab==='live'&&(<>
          <div style={{padding:'12px 16px',background:'rgba(0,229,255,0.04)',border:'1px solid rgba(0,229,255,0.15)',borderRadius:10,marginBottom:18}}>
            <div style={{fontSize:'0.72rem',color:NEON,fontWeight:700,marginBottom:4}}>ℹ️ How This Works</div>
            <div style={{fontSize:'0.76rem',color:'rgba(255,255,255,0.5)',lineHeight:1.6}}>Only shows patterns where a team played a match <strong style={{color:GOLD}}>today</strong>. When their score matches a historical pattern with ≥{minPct}% probability, it appears here as an actionable live prediction for their <strong style={{color:GREEN}}>next upcoming fixture</strong>. Auto-refreshes when new results arrive.</div>
          </div>
          <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:18,padding:'14px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:10}}>
            <select id="league-filter" value={leagueFilter} onChange={e=>setLeagueFilter(e.target.value)} style={{background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.1)',color:'white',borderRadius:8,padding:'8px 12px',fontSize:'0.8rem',outline:'none'}}>
              <option value="">🌍 All Leagues</option>
              {leagues.map(lg=><option key={lg} value={lg}>{li(lg)} {lg.replace(' - Virtual','')}</option>)}
            </select>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:'0.75rem',color:'rgba(255,255,255,0.5)'}}>Min %:</span>
              <input id="min-pct" type="number" value={minPct} min={70} max={100} onChange={e=>setMinPct(Number(e.target.value))} style={{width:60,background:'rgba(0,0,0,0.3)',border:'1px solid rgba(255,255,255,0.1)',color:'white',borderRadius:8,padding:'8px 10px',fontSize:'0.8rem',outline:'none',textAlign:'center'}}/>
            </div>
            <button id="reload-patterns" onClick={loadLive} style={{background:`${GREEN}15`,border:`1px solid ${GREEN}40`,color:GREEN,borderRadius:8,padding:'8px 16px',cursor:'pointer',fontSize:'0.8rem',fontWeight:700}}>↺ Reload</button>
          </div>
          <PatternList patterns={liveData?.patterns} loading={liveLoading} error={liveError} onReload={loadLive} isHistory={false}/>
        </>)}

        {/* UPCOMING AI TAB */}
        {tab==='upcoming-ai'&&(
          <UpcomingAiAnalysis />
        )}

        {/* HISTORY TAB */}
        {tab==='history'&&(<>
          <div style={{padding:'12px 16px',background:'rgba(255,215,0,0.04)',border:'1px solid rgba(255,215,0,0.15)',borderRadius:10,marginBottom:18}}>
            <div style={{fontSize:'0.72rem',color:GOLD,fontWeight:700,marginBottom:4}}>📅 Historical Archive</div>
            <div style={{fontSize:'0.76rem',color:'rgba(255,255,255,0.5)',lineHeight:1.6}}>Browse every past date's triggered patterns. Resolved entries show the actual outcome of the next match so you can verify accuracy over time.</div>
          </div>
          {histDates.length===0
            ?<div style={{textAlign:'center',padding:'40px 0',color:'rgba(255,255,255,0.3)',fontSize:'0.85rem'}}>No historical snapshots yet. They are saved automatically as patterns trigger each day.</div>
            :<>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:20}}>
                {histDates.map(d=>(
                  <button key={d} onClick={()=>setHistDate(d)} style={{padding:'7px 16px',borderRadius:8,border:`1px solid ${d===histDate?GOLD:'rgba(255,255,255,0.1)'}`,background:d===histDate?`${GOLD}15`:'rgba(255,255,255,0.02)',color:d===histDate?GOLD:'rgba(255,255,255,0.5)',fontWeight:d===histDate?800:400,fontSize:'0.78rem',cursor:'pointer',transition:'all 0.2s'}}>
                    {d}
                  </button>
                ))}
              </div>
              <PatternList patterns={histPatterns} loading={histLoading} error={histError} onReload={()=>setHistDate(histDate)} isHistory={true}/>
            </>
          }
        </>)}

        {/* PERFORMANCE TAB */}
        {tab==='performance'&&(<>
          <div style={{padding:'12px 16px',background:'rgba(167,139,250,0.04)',border:'1px solid rgba(167,139,250,0.15)',borderRadius:10,marginBottom:18}}>
            <div style={{fontSize:'0.72rem',color:PURPLE,fontWeight:700,marginBottom:4}}>📊 Pattern Performance Overview</div>
            <div style={{fontSize:'0.76rem',color:'rgba(255,255,255,0.5)',lineHeight:1.6}}>Full accuracy breakdown across all resolved predictions. Outcomes are auto-resolved as new match results enter the database — no manual input needed.</div>
          </div>
          <PatternPerformance/>
        </>)}

      </main>
      <footer style={{borderTop:'1px solid rgba(255,255,255,0.06)',padding:'18px 24px',textAlign:'center',marginTop:32}}>
        <p style={{margin:0,fontSize:'0.75rem',color:'rgba(255,255,255,0.25)'}}>Pattern Intelligence Engine · vFootball Terminal · <a href="/results" style={{color:PURPLE,textDecoration:'none'}}>Back to Results</a></p>
      </footer>
      <style>{`@keyframes spin{100%{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}@keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}
