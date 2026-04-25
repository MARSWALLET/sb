const express = require("express");
const router = express.Router();

// External imports copied from index.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Jimp = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { startContinuousScraper, stopContinuousScraper, reloadContinuousScraper, getHistoricalResults, getHistoryStoreInfo, scrapeLiveListOnDemand } = require("../scraper");

const { nativeCaptureLeagueResults } = require("../native_scraper");
const { uploadMatchesToDatabase, syncMatchesToDatabase, getDatabaseHistoryLog, setDatabaseHistoryLog, dbEvents } = require("../db_uploader");
const { fetchResultsFromDatabase, fetchTodayResultsFromDatabase, todayDDMMYYYY, fetchFullDayRawResults, fetchTeamHistoryFromDatabase, fetchAvailableDates, fetchAvailableLeagues, fetchAllHistoryLogs, computeTeamForm, computeH2HForm, computeVenueAdvantage, computeAllLeagueBaselines, getLeagueBaseline, getCachedDocs } = require("../db_reader");
const { toDbLeague, SUPPORTED_LEAGUES } = require("../constants");
const { saveAnalysis, getRecentContext, getLog, deleteEntry, getEntryById, clearLog, getStrategy, updateStrategy, fetchStrategyHistory, getLeagueIntelligence, updateLeagueIntelligence, getAnalysisByScopeAndDate, saveDailyTip, getDailyTip, getAllDailyTips } = require("../ai_memory");
const { deleteLeagueData } = require("../db_admin");
const { connectDb, PatternSnapshot } = require("../db_init");
const {
    detectBehaviourPatterns,
    saveBehaviourSignals,
    fetchBehaviourSignals,
    buildBehaviourPromptInjection,
    buildLeagueBaselinePromptInjection,
    computeLeagueStreakProfile,
    compareScreenshotResults
} = require("../behaviour_pattern_engine");
const {
    callPredictionAI,
    parseAIJson,
    getActivePredictionProvider,
    setActivePredictionProvider,
    getPredictionProviderStatus,
    PREDICTION_PROVIDERS,
} = require("../prediction_ai");

module.exports = function(globals) {
    const { broadcastAiStatus, broadcastLiveScores, getLivePage } = globals;

    const globalDataRef = {};
    Object.defineProperty(globalDataRef, "current", {
        get: () => globals.globalData,
        set: (v) => globals.globalData = v
    });

router.get('/api/vfootball/daily-tips', async (req, res) => {
    try {
        const { date, league } = req.query;
        if (!date || !league) return res.status(400).json({ success: false, error: 'date and league are required' });

        const tip = await getDailyTip(date, league);
        if (tip) {
            return res.json({ success: true, tipData: tip.tipData, cached: true });
        } else {
            return res.json({ success: true, tipData: null, cached: false });
        }
    } catch (err) {
        console.error('[/api/vfootball/daily-tips]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/behaviour-patterns', async (req, res) => {
    try {
        const { league, mode } = req.query;
        console.log(`[/api/vfootball/behaviour-patterns] league=${league || 'ALL'} mode=${mode || 'history'}`);

        if (mode === 'streak-profile') {
            // Return current win/loss streak profile for all teams in a league
            if (!league) return res.status(400).json({ success: false, error: 'league is required for streak-profile mode' });
            console.log(`[BPE API] 📊 Running live streak profile for ${league}...`);
            const profile = await computeLeagueStreakProfile(league);
            return res.json({ success: true, streakProfile: profile, league, generatedAt: new Date().toISOString() });
        }

        // Default: return saved behaviour signal history from Firestore
        const history = await fetchBehaviourSignals(league || null, 20);
        res.json({ success: true, history, league: league || 'ALL' });
    } catch (err) {
        console.error('[/api/vfootball/behaviour-patterns]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/vfootball/behaviour-patterns/analyse', async (req, res) => {
    try {
        const { league, fixtures, latestMatches, previousMatches } = req.body;
        if (!league || !fixtures || !Array.isArray(fixtures)) {
            return res.status(400).json({ success: false, error: 'league and fixtures[] are required' });
        }
        console.log(`[BPE API] 🧠 Ad-hoc behaviour analysis: ${fixtures.length} fixtures in ${league}`);

        // Run pattern detection
        const signals = await detectBehaviourPatterns(fixtures, league);

        // Optional: compare two screenshot result sets if provided
        let comparisonReport = null;
        if (Array.isArray(latestMatches) && Array.isArray(previousMatches) && latestMatches.length > 0) {
            console.log('[BPE API] 🔍 Running screenshot comparison analysis...');
            comparisonReport = compareScreenshotResults(latestMatches, previousMatches);
        }

        // Save signals to Database for dashboard history
        const today = todayDDMMYYYY();
        await saveBehaviourSignals(signals, league, today).catch(e =>
            console.error('[BPE API] Save error (non-fatal):', e.message)
        );

        res.json({
            success: true,
            signals,
            totalSignals: signals.reduce((sum, s) => sum + (s.signals?.length || 0), 0),
            promptInjection: buildBehaviourPromptInjection(signals),
            comparisonReport,
            league,
            analyzedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('[/api/vfootball/behaviour-patterns/analyse]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/league-baselines', async (req, res) => {
    try {
        const { LeagueBaseline } = require('./db_init');
        const { league } = req.query;
        console.log(`[/api/vfootball/league-baselines] Fetching baselines — league=${league || 'ALL'}`);

        const query = league ? { _id: league } : {};
        const baselines = await LeagueBaseline.find(query).lean();

        // Sort by match count descending (most data first)
        baselines.sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));

        const lastComputed = baselines.length > 0
            ? baselines.reduce((latest, bl) => {
                const d = new Date(bl.lastComputed || 0);
                return d > latest ? d : latest;
            }, new Date(0))
            : null;

        console.log(`[/api/vfootball/league-baselines] Returning ${baselines.length} baselines.`);
        res.json({ success: true, baselines, count: baselines.length, lastComputed });
    } catch (err) {
        console.error('[/api/vfootball/league-baselines] Error:', err.message);
        res.status(500).json({ success: false, error: `Failed to load baselines: ${err.message}` });
    }
});

router.post('/api/vfootball/league-baselines/compute', async (req, res) => {
    try {
        const { daysBack = 7 } = req.body || {};
        console.log(`[/api/league-baselines/compute] 🧬 Triggering DNA recompute (last ${daysBack} days)...`);
        broadcastAiStatus('progress', `🧬 Computing League DNA Baselines from last ${daysBack} days...`);

        const baselines = await computeAllLeagueBaselines(Number(daysBack));

        broadcastAiStatus('success', `✅ League DNA computed for ${baselines.length} leagues.`);
        console.log(`[/api/league-baselines/compute] ✅ Computed ${baselines.length} baselines.`);

        res.json({
            success: true,
            computed: baselines.length,
            leagues: baselines.map(b => b.league),
            summary: baselines.map(b => ({
                league: b.league,
                matchCount: b.matchCount,
                over1_5: b.stats?.over1_5Percent,
                over2_5: b.stats?.over2_5Percent,
                btts: b.stats?.bttsPercent,
                homeWin: b.stats?.homeWinPercent,
                draw: b.stats?.drawPercent,
                topScore: b.topScores?.[0]?.score,
            }))
        });
    } catch (err) {
        console.error('[/api/league-baselines/compute] Error:', err.message);
        broadcastAiStatus('error', `DNA compute failed: ${err.message}`);
        res.status(500).json({ success: false, error: `Baseline compute failed: ${err.message}` });
    }
});

router.get('/api/vfootball/daily-tips/history', async (req, res) => {
    try {
        const { league } = req.query;
        const history = await getAllDailyTips(league);
        res.json({ success: true, history });
    } catch (err) {
        console.error('[/api/vfootball/daily-tips/history]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/vfootball/league-intelligence/:league', async (req, res) => {
    try {
        const { league } = req.params;
        const decoded = decodeURIComponent(league);
        const intelDoc = await getLeagueIntelligence(decoded);

        if (intelDoc) {
            res.json({ success: true, data: intelDoc.merged || intelDoc.profile || intelDoc, rawDoc: intelDoc });
        } else {
            res.json({ success: true, data: null });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/api/admin/league/:leagueName', async (req, res) => {
    try {
        const { leagueName } = req.params;
        const { date } = req.query; // optional date DD/MM/YYYY
        console.log(`[DEBUG] [DELETE /api/admin/league] Request to delete league: ${leagueName}${date ? ` on date ${date}` : ''}`);

        if (!leagueName) {
            return res.status(400).json({ success: false, error: 'League name is required' });
        }

        const stats = await deleteLeagueData(leagueName, date);
        console.log(`[Admin] ✅ Deleted league ${leagueName} (date: ${date || 'ALL'}):`, stats);
        
        const scopeStr = date ? `for date ${date}` : 'and all historical records';
        res.json({ 
            success: true, 
            message: `Successfully removed ${leagueName} ${scopeStr}.`, 
            stats 
        });
    } catch (err) {
        console.error('[Database Index Debug/Error Details]: [DELETE /api/admin/league]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/pattern-intel', async (req, res) => {
    try {
        const leagueFilter = req.query.league || null;
        const minPct = parseFloat(req.query.minPct) || 80;
        const minSamples = parseInt(req.query.minSamples) || 3;

        console.log(`[PatternIntel] 🧠 Computing pattern intel — league=${leagueFilter || 'ALL'} minPct=${minPct}% minSamples=${minSamples}`);

        const allDocs = await getCachedDocs();
        console.log(`[PatternIntel] Loaded ${allDocs.length} total match records from cache`);

        // ── Step 1: Group all docs into per-team chronological histories ──────
        const teamMatchMap = {}; // { [league]: { [team]: [...matchRecords sorted by date] } }

        let minDate = null, maxDate = null;

        for (const m of allDocs) {
            if (!m.score || !/^\d+[:\-]\d+$/.test(m.score.trim())) continue;
            const lg = m.league || 'Unknown';
            if (leagueFilter && lg !== leagueFilter) continue;

            const parts = m.date ? m.date.split('/') : null;
            const time = m.time ? m.time.split(':') : ['0','0'];
            const parsedDate = parts && parts.length === 3
                ? new Date(parts[2], parts[1]-1, parts[0], parseInt(time[0])||0, parseInt(time[1])||0)
                : new Date(0);

            if (parsedDate.getTime() !== 0) {
                if (!minDate || parsedDate < minDate) minDate = parsedDate;
                if (!maxDate || parsedDate > maxDate) maxDate = parsedDate;
            }

            if (!teamMatchMap[lg]) teamMatchMap[lg] = {};

            const addEntry = (team, isHome) => {
                if (!team) return;
                if (!teamMatchMap[lg][team]) teamMatchMap[lg][team] = [];
                teamMatchMap[lg][team].push({ ...m, isHome, parsedDate });
            };
            addEntry(m.homeTeam, true);
            addEntry(m.awayTeam, false);
        }

        // Sort each team's matches chronologically
        for (const lg of Object.keys(teamMatchMap)) {
            for (const team of Object.keys(teamMatchMap[lg])) {
                teamMatchMap[lg][team].sort((a, b) => a.parsedDate - b.parsedDate);
            }
        }

        // ── Step 2: Compute pattern statistics ────────────────────────────────
        // patternStore[lg][score][role][team] = { total, nextWin, nextLoss, nextDraw, nextOver15, nextOver25, nextGG, nextHomeOver05, nextAwayOver05, triggers: [] }
        const patternStore = {};

        for (const lg of Object.keys(teamMatchMap)) {
            patternStore[lg] = {};
            for (const team of Object.keys(teamMatchMap[lg])) {
                const matches = teamMatchMap[lg][team];
                for (let i = 0; i < matches.length - 1; i++) {
                    const cur = matches[i];
                    const nxt = matches[i+1];
                    const score = cur.score.replace('-', ':').trim();
                    const role = cur.isHome ? 'Home' : 'Away';

                    if (!patternStore[lg][score]) patternStore[lg][score] = {};
                    if (!patternStore[lg][score][role]) patternStore[lg][score][role] = {};
                    if (!patternStore[lg][score][role][team]) {
                        patternStore[lg][score][role][team] = {
                            total: 0, nextWin: 0, nextLoss: 0, nextDraw: 0,
                            nextOver15: 0, nextOver25: 0, nextGG: 0,
                            nextHomeOver05: 0, nextAwayOver05: 0,
                            triggers: []
                        };
                    }

                    const st = patternStore[lg][score][role][team];
                    st.total++;

                    const np = nxt.score.replace('-', ':').split(':').map(Number);
                    const ngf = nxt.isHome ? np[0] : np[1];
                    const nga = nxt.isHome ? np[1] : np[0];
                    const ntg = ngf + nga;

                    if (ngf > nga) st.nextWin++;
                    else if (ngf < nga) st.nextLoss++;
                    else st.nextDraw++;
                    if (ntg > 1.5) st.nextOver15++;
                    if (ntg > 2.5) st.nextOver25++;
                    if (ngf > 0 && nga > 0) st.nextGG++;
                    if (np[0] > 0) st.nextHomeOver05++;
                    if (np[1] > 0) st.nextAwayOver05++;

                    // Store the trigger (current match) and the next match together
                    st.triggers.push({
                        team,
                        triggerDate: cur.date,
                        triggerTime: cur.time,
                        triggerScore: cur.score,
                        triggerHomeTeam: cur.homeTeam,
                        triggerAwayTeam: cur.awayTeam,
                        triggerRole: role,
                        nextDate: nxt.date,
                        nextTime: nxt.time,
                        nextScore: nxt.score,
                        nextHomeTeam: nxt.homeTeam,
                        nextAwayTeam: nxt.awayTeam,
                        nextIsHome: nxt.isHome,
                        parsedDate: cur.parsedDate
                    });
                }
            }
        }

        // ── Step 3: Filter patterns that hit ≥ minPct% ──────────────────────
        const elitePatterns = [];

        for (const lg of Object.keys(patternStore).sort()) {
            for (const score of Object.keys(patternStore[lg]).sort()) {
                for (const role of ['Home', 'Away']) {
                    if (!patternStore[lg][score][role]) continue;
                    for (const team of Object.keys(patternStore[lg][score][role])) {
                        const st = patternStore[lg][score][role][team];
                        if (!st || st.total < minSamples) continue;

                        const pct = (k) => Math.round((st[k] / st.total) * 100);
                        const eliteOutcomes = [];

                        const checkAdd = (key, label, emoji) => {
                            const p = pct(key);
                            if (p >= minPct) {
                                eliteOutcomes.push({
                                    key, label, emoji, pct: p,
                                    hit: st[key], failed: st.total - st[key]
                                });
                            }
                        };

                        checkAdd('nextWin',       'Win',             '🏆');
                        checkAdd('nextLoss',      'Loss',            '❌');
                        checkAdd('nextDraw',      'Draw',            '🤝');
                        checkAdd('nextOver15',    'Over 1.5',        '⚽');
                        checkAdd('nextOver25',    'Over 2.5',        '🔥');
                        checkAdd('nextGG',        'GG (BTTS)',       '🥅');
                        checkAdd('nextHomeOver05','Home Scores',     '🏠');
                        checkAdd('nextAwayOver05','Away Scores',     '✈️');

                        if (eliteOutcomes.length === 0) continue;

                        // Sort triggers by date descending — most recent first
                        st.triggers.sort((a, b) => b.parsedDate - a.parsedDate);

                        // Most recent trigger (the match we want to act on)
                        const mostRecent = st.triggers[0] || null;

                        elitePatterns.push({
                            league: lg,
                            score,
                            role,
                            team,
                            sampleSize: st.total,
                            eliteOutcomes,
                            mostRecentTrigger: mostRecent,
                            recentTriggers: st.triggers.slice(0, 5) // show 5 for context
                        });
                    }
                }
            }
        }

        // ── Step 4: Find LIVE ACTIVE Predictions for Today ─────────────────────
        // We only show a pattern if a team's ABSOLUTE LATEST MATCH (played today)
        // matches an elite pattern. This means their "next match" hasn't happened yet,
        // making this a true live prediction for their upcoming fixture!
        
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        const todayStr = `${dd}/${mm}/${yyyy}`; // DD/MM/YYYY

        const activeLivePatterns = [];

        for (const lg of Object.keys(teamMatchMap)) {
            for (const team of Object.keys(teamMatchMap[lg])) {
                const matches = teamMatchMap[lg][team];
                if (matches.length === 0) continue;

                // The absolute latest match this team played
                const latestMatch = matches[matches.length - 1];

                // Only care if their latest match was played TODAY
                if (latestMatch.date !== todayStr) continue;

                const score = latestMatch.score.replace('-', ':').trim();
                const role = latestMatch.isHome ? 'Home' : 'Away';

                // Do they have an elite historical pattern for this score/role?
                const st = patternStore[lg]?.[score]?.[role]?.[team];
                if (!st || st.total < minSamples) continue;

                const pct = (k) => Math.round((st[k] / st.total) * 100);
                const eliteOutcomes = [];

                const checkAdd = (key, label, emoji) => {
                    const p = pct(key);
                    if (p >= minPct) {
                        eliteOutcomes.push({
                            key, label, emoji, pct: p,
                            hit: st[key], failed: st.total - st[key]
                        });
                    }
                };

                checkAdd('nextWin',       'Win',             '🏆');
                checkAdd('nextLoss',      'Loss',            '❌');
                checkAdd('nextDraw',      'Draw',            '🤝');
                checkAdd('nextOver15',    'Over 1.5',        '⚽');
                checkAdd('nextOver25',    'Over 2.5',        '🔥');
                checkAdd('nextGG',        'GG (BTTS)',       '🥅');
                checkAdd('nextHomeOver05','Home Scores',     '🏠');
                checkAdd('nextAwayOver05','Away Scores',     '✈️');

                // If they have elite outcomes, this is an ACTIVE LIVE PREDICTION!
                if (eliteOutcomes.length > 0) {
                    const mostRecent = {
                        team,
                        triggerDate: latestMatch.date,
                        triggerTime: latestMatch.time,
                        triggerScore: latestMatch.score,
                        triggerHomeTeam: latestMatch.homeTeam,
                        triggerAwayTeam: latestMatch.awayTeam,
                        triggerRole: role,
                        // No next match info because it hasn't happened yet!
                    };

                    // Re-sort historical triggers descending to show recent context
                    // Only include triggers that have a resolved next match (exclude today's live one)
                    st.triggers.sort((a, b) => b.parsedDate - a.parsedDate);
                    const resolvedTriggers = st.triggers.filter(tr => tr.nextScore);

                    activeLivePatterns.push({
                        league: lg,
                        score,
                        role,
                        team,
                        sampleSize: st.total,
                        eliteOutcomes,
                        mostRecentTrigger: mostRecent,
                        recentTriggers: resolvedTriggers.slice(0, 5) // show 5 historical examples with results
                    });
                }
            }
        }

        console.log(`[PatternIntel] ✅ Found ${elitePatterns.length} total elite patterns — ${activeLivePatterns.length} LIVE predictions right now (${todayStr})`);

        // Sort live patterns by their trigger time — most recently triggered first
        activeLivePatterns.sort((a, b) => {
            const tA = a.mostRecentTrigger?.triggerTime || '00:00';
            const tB = b.mostRecentTrigger?.triggerTime || '00:00';
            return tB.localeCompare(tA); // latest time first
        });
        console.log(`[PatternIntel] 🕐 Patterns sorted by trigger time. First: ${activeLivePatterns[0]?.team} @ ${activeLivePatterns[0]?.mostRecentTrigger?.triggerTime}`);

        // ── Auto-save snapshot to MongoDB for historical browsing ──────────────
        if (activeLivePatterns.length > 0) {
            PatternSnapshot.bulkWrite(activeLivePatterns.map(p => {
                const safe = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '');
                const id = `${todayStr}_${safe(p.league)}_${safe(p.team)}_${safe(p.score)}_${p.role}`;
                return {
                    updateOne: {
                        filter: { _id: id },
                        update: { $set: { snapshotDate: todayStr, ...p, savedAt: new Date() }, $setOnInsert: { resolved: false, outcomeResults: {} } },
                        upsert: true,
                    }
                };
            }), { ordered: false }).catch(e => console.warn('[PatternSnapshot] ⚠️ Auto-save failed (non-fatal):', e.message));
        }

        res.json({
            success: true,
            today: todayStr,
            totalPatterns: activeLivePatterns.length,
            totalAllTime: elitePatterns.length,
            dataRange: {
                from: minDate ? minDate.toDateString() : 'Unknown',
                to: maxDate ? maxDate.toDateString() : 'Unknown'
            },
            patterns: activeLivePatterns,
            config: { minPct, minSamples }
        });

    } catch (err) {
        console.error('[PatternIntel] ❌ Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/ai-predict-pattern', express.json(), async (req, res) => {
    try {
        const { pattern } = req.body;
        if (!pattern || !pattern.team || !pattern.score) {
            return res.status(400).json({ success: false, error: 'Pattern data is required' });
        }

        const { callPredictionAI, getActivePredictionProvider } = require('./prediction_ai');
        const { computeTeamForm, getLeagueBaseline } = require('./db_reader');
        const { getLeagueIntelligence } = require('./ai_memory');
        
        const activeProvider = getActivePredictionProvider();

        const [teamForm, leagueBaseline, leagueIntel] = await Promise.all([
            computeTeamForm(pattern.league, pattern.team),
            getLeagueBaseline(pattern.league),
            getLeagueIntelligence(pattern.league)
        ]);

        const prompt = `
You are an elite, world-class sports betting algorithmic analyst. 
Your goal is to synthesize multiple data points to guarantee an extraordinary, highly profitable betting prediction.

1. PATTERN TRIGGER (PRIMARY SIGNAL)
Team: ${pattern.team}
League: ${pattern.league}
Event: ${pattern.team} just played a match ending in ${pattern.score} as the ${pattern.role} team.
When this exact scenario happens, historical data for their NEXT match shows:
${pattern.eliteOutcomes.map(o => `- ${o.label}: ${o.pct}% probability (Hits: ${o.hit}, Fails: ${o.failed})`).join('\n')}
(Sample Size: ${pattern.sampleSize} historical matches)

2. CURRENT TEAM FORM (LAST 10 MATCHES)
Streak: ${teamForm.streak}
Win Rate: ${Math.round((teamForm.wins/(teamForm.matchesAnalysed||1))*100)}% (W${teamForm.wins} D${teamForm.draws} L${teamForm.losses})
Avg Goals Scored: ${teamForm.goalsScored} / Avg Conceded: ${teamForm.goalsConceded}
Over 2.5 Hit Rate: ${teamForm.over2_5_percent}% / BTTS Hit Rate: ${teamForm.btts_percent}%

3. LEAGUE DNA & TACTICAL INTELLIGENCE
League Baseline Avg Goals: ${leagueBaseline?.stats?.avgGoals || 'N/A'}
League Over 2.5 Rate: ${leagueBaseline?.stats?.over2_5Percent || 'N/A'}%
AI Tactical Intel: ${leagueIntel?.tacticalSummary || 'No tactical intel available.'}

INSTRUCTIONS:
Synthesize the Pattern Trigger with the Team Form and League DNA to provide a true expert edge. 
Do NOT just blindly repeat the stats. Cross-reference the pattern with their current actual form and league tendencies to validate or challenge the primary signal.
Write a very brief, punchy, expert-level betting recommendation (2-3 sentences max).
Focus on the most mathematically sound and logical outcome.
Return ONLY the recommendation text, no formatting, no JSON, no preamble.
`;

        console.log(`[PatternIntel] 🤖 Asking ${activeProvider} to predict pattern for ${pattern.team}...`);
        
        const result = await callPredictionAI(prompt, activeProvider, {
            temperature: 0.7,
            maxTokens: 150
        });

        res.json({ success: true, prediction: result.content.trim(), provider: activeProvider });

    } catch (err) {
        console.error('[PatternIntel] ❌ AI Prediction Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/pattern-intel/upcoming-ai-analysis', async (req, res) => {
    try {
        console.log('[Upcoming AI] 🤖 Generating consolidated AI analysis for best upcoming fixtures...');
        const minPct = 80;
        
        // 1. Fetch current active patterns
        const port = process.env.PORT || 3001;
        const patternRes = await fetch(`http://localhost:${port}/api/pattern-intel?minPct=${minPct}`);
        const patternJson = await patternRes.json();
        
        if (!patternJson.success) throw new Error(patternJson.error || 'Failed to fetch pattern intel');
        
        let patterns = patternJson.patterns || [];
        
        // 2. Filter top patterns (must have elite outcomes > 80%)
        patterns = patterns.filter(p => p.eliteOutcomes && p.eliteOutcomes.some(o => o.pct >= minPct));
        
        // Sort by highest probability outcome
        patterns.sort((a, b) => {
            const maxA = Math.max(...a.eliteOutcomes.map(o => o.pct));
            const maxB = Math.max(...b.eliteOutcomes.map(o => o.pct));
            return maxB - maxA;
        });
        
        // 3. Cross-reference STRICTLY with the live list.
        // Patterns are derived from completed results — the "next match" for each pattern
        // team MUST be what is currently live. We never fall back to upcoming/betslip fixtures
        // (globals.globalData) because those haven't started yet and would give wrong predictions.
        const liveListGames = await scrapeLiveListOnDemand();
        const liveMatchCount = liveListGames.reduce((acc, g) => acc + (g.matches?.length || 0), 0);
        console.log(`[Upcoming AI] Live list scraped: ${liveListGames.length} league groups, ${liveMatchCount} total live matches.`);

        if (!liveListGames || liveListGames.length === 0 || liveMatchCount === 0) {
            console.log('[Upcoming AI] Live list is empty — waiting for next match round.');
            return res.json({
                success: true,
                message: 'The live list is empty right now. Waiting for the next match round to start (usually within 5 minutes).',
                analyses: []
            });
        }

        const upcomingMatches = [];
        const topPatterns = patterns.slice(0, 15); // Don't check too many

        for (const pattern of topPatterns) {
            let foundFixture = null;

            // STRICTLY search the live list only — no globals.globalData fallback
            for (const group of liveListGames) {
                const pCountry = pattern.league.split(' ')[0];
                // Match by exact league name, or by the country prefix (e.g. "England"), or catch-all virtual groups
                if (
                    group.league !== pattern.league &&
                    group.league !== 'vFootball Live Odds' &&
                    group.league !== 'vFootball Live' &&
                    (!group.league || !group.league.includes(pCountry))
                ) continue;

                const fixture = group.matches.find(m =>
                    m.home?.includes(pattern.team) ||
                    m.away?.includes(pattern.team) ||
                    pattern.team.includes(m.home) ||
                    pattern.team.includes(m.away)
                );

                if (fixture) {
                    foundFixture = fixture;
                    console.log(`[Upcoming AI] ✅ Pattern team "${pattern.team}" (${pattern.league}) is LIVE: ${fixture.home} vs ${fixture.away}`);
                    break;
                }
            }

            if (!foundFixture) {
                console.log(`[Upcoming AI] ⏳ Pattern team "${pattern.team}" (${pattern.league}) not found in live list — skipping this round.`);
                continue; // This team isn't playing yet — skip, don't pollute analysis
            }

            const isHome = foundFixture.home?.includes(pattern.team) || pattern.team.includes(foundFixture.home);
            
            let displayTime = 'LIVE';
            if (foundFixture.status === 'IN-PLAY') {
                displayTime = foundFixture.time ? `${foundFixture.time} (IN-PLAY)` : 'IN-PLAY';
            } else if (foundFixture.status === 'UPCOMING') {
                displayTime = foundFixture.time ? `${foundFixture.time} (Next)` : 'Next Match';
            } else {
                displayTime = foundFixture.time ? `${foundFixture.time} (LIVE)` : 'LIVE';
            }

            upcomingMatches.push({
                pattern,
                fixture: {
                    time: displayTime,
                    code: foundFixture.code || '',
                    home: foundFixture.home,
                    away: foundFixture.away,
                    odds: foundFixture.score,
                    teamRole: isHome ? 'Home' : 'Away',
                    opponent: isHome ? foundFixture.away : foundFixture.home
                }
            });
        }

        // Take top 5 best live matches
        const finalMatches = upcomingMatches.slice(0, 5);
        console.log(`[Upcoming AI] ${finalMatches.length} live pattern matches found for AI analysis.`);

        if (finalMatches.length === 0) {
            return res.json({
                success: true,
                message: 'None of the elite pattern teams are currently live. The live list is active but no pattern team is playing right now — check back in a few minutes.',
                analyses: []
            });
        }
        
        // 4. Send to AI
        const { callPredictionAI, getActivePredictionProvider, parseAIJson } = require('./prediction_ai');
        const activeProvider = getActivePredictionProvider();
        
        const matchDataStr = finalMatches.map((m, i) => `
MATCH ${i+1}:
Team with Pattern: ${m.pattern.team} (${m.pattern.league})
Upcoming Fixture: ${m.fixture.home} vs ${m.fixture.away} (Time: ${m.fixture.time})
Odds string: ${m.fixture.odds}
Pattern Trigger: Just played ending in ${m.pattern.score} as ${m.pattern.role}.
Historical Next Match Outcomes (Sample: ${m.pattern.sampleSize}):
${m.pattern.eliteOutcomes.map(o => `- ${o.label}: ${o.pct}% probability`).join('\n')}
`).join('\n');

        const prompt = `
You are an elite sports betting algorithmic analyst. 
I am providing you with the top ${finalMatches.length} mathematically backed predictions for fixtures starting in the NEXT 5 MINUTES.
Your task is to analyze these upcoming fixtures based on the historical pattern data.

DATA:
${matchDataStr}

INSTRUCTIONS:
Return a JSON array of analysis objects. DO NOT return markdown blocks around the JSON, just the raw JSON array.
Each object in the array must have the following keys:
- "match": string (e.g. "Chelsea vs Arsenal")
- "time": string (The match starting time from the data provided)
- "team": string (The team the pattern is about)
- "league": string (The league name provided in the data, e.g. "England - Virtual")
- "pattern": string (Brief summary of the pattern trigger)
- "signal": string (The highest probability outcome, e.g. "Win (85%)")
- "analysis": string (A punchy 2-3 sentence expert explanation synthesizing the pattern against the specific opponent. Be extremely confident and professional.)
- "confidence": number (A score out of 100 based on the probability)
- "color": string (A hex color code representing the outcome type: e.g. Win=#00FF88, Goals=#00E5FF)
`;

        const result = await callPredictionAI(prompt, activeProvider, {
            temperature: 0.4,
            maxTokens: 2000
        });
        
        const analyses = parseAIJson(result.content);
        
        res.json({
            success: true,
            provider: activeProvider,
            analyses: Array.isArray(analyses) ? analyses : [analyses]
        });

    } catch (err) {
        console.error('[Upcoming AI] ❌ Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/pattern-intel/save-snapshot', express.json(), async (req, res) => {
    try {
        const { patterns, snapshotDate } = req.body;
        if (!patterns || !snapshotDate) {
            return res.status(400).json({ success: false, error: 'patterns and snapshotDate required' });
        }
        console.log(`[PatternSnapshot] 💾 Saving ${patterns.length} pattern snapshots for ${snapshotDate}...`);

        const ops = patterns.map(p => {
            const safe = (s) => s.replace(/[^a-zA-Z0-9]/g, '');
            const id = `${snapshotDate}_${safe(p.league)}_${safe(p.team)}_${safe(p.score)}_${p.role}`;
            return {
                updateOne: {
                    filter: { _id: id },
                    update: {
                        $set: {
                            snapshotDate,
                            league: p.league,
                            team: p.team,
                            score: p.score,
                            role: p.role,
                            sampleSize: p.sampleSize,
                            eliteOutcomes: p.eliteOutcomes,
                            mostRecentTrigger: p.mostRecentTrigger,
                            recentTriggers: p.recentTriggers || [],
                            savedAt: new Date(),
                        },
                        $setOnInsert: { resolved: false, outcomeResults: {} }
                    },
                    upsert: true,
                }
            };
        });

        if (ops.length > 0) await PatternSnapshot.bulkWrite(ops, { ordered: false });
        console.log(`[PatternSnapshot] ✅ Saved/updated ${ops.length} snapshots for ${snapshotDate}`);
        res.json({ success: true, saved: ops.length });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ Save error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/pattern-intel/dates', async (req, res) => {
    try {
        const dates = await PatternSnapshot.distinct('snapshotDate');
        // Sort DD/MM/YYYY descending
        dates.sort((a, b) => {
            const parse = d => { const [dd,mm,yyyy] = d.split('/'); return new Date(`${yyyy}-${mm}-${dd}`); };
            return parse(b) - parse(a);
        });
        console.log(`[PatternSnapshot] 📅 Found ${dates.length} snapshot dates`);
        res.json({ success: true, dates });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ dates error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/pattern-intel/history', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ success: false, error: 'date query param required' });
        console.log(`[PatternSnapshot] 📖 Fetching history for ${date}...`);
        const docs = await PatternSnapshot.find({ snapshotDate: date }).lean();
        console.log(`[PatternSnapshot] ✅ Found ${docs.length} snapshots for ${date}`);
        res.json({ success: true, date, patterns: docs });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ history error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/api/pattern-intel/performance', async (req, res) => {
    try {
        console.log('[PatternSnapshot] 📊 Computing performance overview...');
        const allDocs = await PatternSnapshot.find({}).lean();

        // ── Auto-resolve: check if team's next match exists in vfootball_results ──
        const allResults = await getCachedDocs();
        const todayStr = todayDDMMYYYY();
        let autoResolved = 0;

        for (const snap of allDocs) {
            if (snap.resolved) continue;
            // Find the next match for this team AFTER snapshotDate
            const parseDate = (d) => { if (!d) return new Date(0); const [dd,mm,yyyy] = d.split('/'); return new Date(`${yyyy}-${mm}-${dd}`); };
            const triggerDate = parseDate(snap.snapshotDate);

            const teamMatches = allResults.filter(m =>
                m.league === snap.league &&
                (m.homeTeam === snap.team || m.awayTeam === snap.team) &&
                m.score && /^\d+[:\-]\d+$/.test(m.score.trim())
            );

            const laterMatches = teamMatches.filter(m => parseDate(m.date) > triggerDate)
                .sort((a, b) => parseDate(a.date) - parseDate(b.date));

            if (laterMatches.length === 0) continue; // still pending

            const nextMatch = laterMatches[0];
            const parts = nextMatch.score.replace('-', ':').split(':').map(Number);
            const isHome = nextMatch.homeTeam === snap.team;
            const gf = isHome ? parts[0] : parts[1];
            const ga = isHome ? parts[1] : parts[0];
            const tg = gf + ga;

            const resolvedOutcomes = {
                win: gf > ga,
                loss: gf < ga,
                draw: gf === ga,
                over15: tg > 1.5,
                over25: tg > 2.5,
                gg: gf > 0 && ga > 0,
                homeScores: parts[0] > 0,
                awayScores: parts[1] > 0,
            };

            const keyMap = { Win: 'win', Loss: 'loss', Draw: 'draw', 'Over 1.5': 'over15', 'Over 2.5': 'over25', 'GG (BTTS)': 'gg', 'Home Scores': 'homeScores', 'Away Scores': 'awayScores' };
            const outcomeResults = {};
            (snap.eliteOutcomes || []).forEach(o => {
                const k = keyMap[o.label];
                if (k !== undefined) outcomeResults[o.label] = resolvedOutcomes[k];
            });

            await PatternSnapshot.findByIdAndUpdate(snap._id, {
                $set: {
                    resolved: true,
                    resolvedDate: nextMatch.date,
                    resolvedScore: nextMatch.score,
                    resolvedOutcomes,
                    outcomeResults,
                }
            });
            Object.assign(snap, { resolved: true, resolvedDate: nextMatch.date, resolvedScore: nextMatch.score, resolvedOutcomes, outcomeResults });
            autoResolved++;
        }

        if (autoResolved > 0) console.log(`[PatternSnapshot] ✅ Auto-resolved ${autoResolved} pending snapshots`);

        // ── Compute global statistics ──────────────────────────────────────────
        const resolved = allDocs.filter(d => d.resolved);
        const pending  = allDocs.filter(d => !d.resolved);

        // Per-outcome aggregate stats
        const outcomeStats = {};
        const outcomeKeys = ['Win', 'Loss', 'Draw', 'Over 1.5', 'Over 2.5', 'GG (BTTS)', 'Home Scores', 'Away Scores'];
        outcomeKeys.forEach(k => { outcomeStats[k] = { predictions: 0, hits: 0, misses: 0 }; });

        for (const snap of resolved) {
            const results = snap.outcomeResults || {};
            for (const [label, hit] of Object.entries(results)) {
                if (!outcomeStats[label]) outcomeStats[label] = { predictions: 0, hits: 0, misses: 0 };
                outcomeStats[label].predictions++;
                if (hit === true)  outcomeStats[label].hits++;
                if (hit === false) outcomeStats[label].misses++;
            }
        }

        const outcomeSummary = Object.entries(outcomeStats)
            .filter(([, s]) => s.predictions > 0)
            .map(([label, s]) => ({
                label,
                predictions: s.predictions,
                hits: s.hits,
                misses: s.misses,
                hitRate: s.predictions > 0 ? Math.round((s.hits / s.predictions) * 100) : 0,
            }))
            .sort((a, b) => b.hitRate - a.hitRate);

        // Per-date summary
        const byDate = {};
        for (const snap of resolved) {
            const d = snap.snapshotDate;
            if (!byDate[d]) byDate[d] = { date: d, total: 0, hits: 0, misses: 0 };
            byDate[d].total++;
            const r = snap.outcomeResults || {};
            const allHit  = Object.values(r).every(v => v === true);
            const anyMiss = Object.values(r).some(v => v === false);
            if (allHit)  byDate[d].hits++;
            if (anyMiss) byDate[d].misses++;
        }
        const dateSummary = Object.values(byDate).sort((a, b) => {
            const parse = d => { const [dd,mm,yy] = d.split('/'); return new Date(`${yy}-${mm}-${dd}`); };
            return parse(b.date) - parse(a.date);
        });

        // Best performing patterns (score+role combinations)
        const patternPerf = {};
        for (const snap of resolved) {
            const key = `${snap.score}_${snap.role}_${snap.league}`;
            if (!patternPerf[key]) patternPerf[key] = { score: snap.score, role: snap.role, league: snap.league, total: 0, hits: 0 };
            patternPerf[key].total++;
            const r = snap.outcomeResults || {};
            if (Object.values(r).every(v => v === true)) patternPerf[key].hits++;
        }
        const topPatterns = Object.values(patternPerf)
            .filter(p => p.total >= 2)
            .map(p => ({ ...p, hitRate: Math.round((p.hits / p.total) * 100) }))
            .sort((a, b) => b.hitRate - a.hitRate)
            .slice(0, 10);

        const totalPredictions = resolved.reduce((s, snap) => s + Object.keys(snap.outcomeResults || {}).length, 0);
        const totalHits = resolved.reduce((s, snap) => s + Object.values(snap.outcomeResults || {}).filter(v => v === true).length, 0);

        res.json({
            success: true,
            overview: {
                totalSnapshots: allDocs.length,
                resolvedSnapshots: resolved.length,
                pendingSnapshots: pending.length,
                totalPredictions,
                totalHits,
                overallHitRate: totalPredictions > 0 ? Math.round((totalHits / totalPredictions) * 100) : 0,
            },
            outcomeSummary,
            dateSummary,
            topPatterns,
        });
    } catch (err) {
        console.error('[PatternSnapshot] ❌ performance error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

    return router;
};
