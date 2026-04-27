const express = require('express');
const { TelegramUser, SystemSettings } = require('../db_init');
const { callPredictionAI, parseAIJson, generateBatchSmartPrompt, calculateImpliedProbability } = require('../prediction_ai');
const { computeTeamForm, computeH2HForm } = require('../db_reader');

async function getSettings() {
    let s = await SystemSettings.findById('global_config');
    if (!s) s = await SystemSettings.create({ _id: 'global_config' });
    return s;
}

module.exports = function (globalsPass) {
    const router = express.Router();

    // GET User WebApp State
    router.get('/api/webapp/user', async (req, res) => {
        const { tgId } = req.query;
        if (!tgId) return res.status(400).json({ error: 'Missing tgId' });

        try {
            const user = await TelegramUser.findById(String(tgId));
            if (!user) {
                return res.status(404).json({ error: 'User not found in vFootball DB' });
            }
            res.json({
                balance: user.pointsBalance,
                subscriptionTier: user.subscriptionTier,
                isSubscribed: user.subscriptionTier !== 'none' && user.subscriptionExpiry && new Date() < user.subscriptionExpiry
            });
        } catch (e) {
            console.error('[WebApp API] User fetch error:', e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // POST Predict Batch (8 items)
    router.post('/api/webapp/predict', async (req, res) => {
        const { tgId, type } = req.query; // type: 'ai' | 'normal'
        if (!tgId) return res.status(400).json({ error: 'Missing tgId' });

        try {
            const user = await TelegramUser.findById(String(tgId));
            if (!user) return res.status(404).json({ error: 'User not found' });

            const settings = await getSettings();
            const hasActiveSub = user.subscriptionTier !== 'none' && user.subscriptionExpiry && new Date() < user.subscriptionExpiry;
            
            // Dynamic cost from admin-configurable SystemSettings
            const BATCH_COST = type === 'ai' ? settings.aiPredictionCost : settings.normalPredictionCost;
            if (!hasActiveSub && user.pointsBalance < BATCH_COST) {
                return res.status(400).json({ error: `Not enough points! Need ${BATCH_COST} points for a Batch Oracle.` });
            }

            const globalData = globalsPass.globalData;
            if (!globalData || Object.keys(globalData).length === 0) {
                return res.status(400).json({ error: 'No live matches available across any leagues right now.' });
            }

            const latestScrape = globalData[0] || {};
            const leagues = Object.keys(latestScrape);
            if (leagues.length === 0) {
                return res.status(400).json({ error: 'No live matches found in current scrape payload.' });
            }

            // Collect up to 8 live matches randomly across leagues
            let matchBatch = [];
            for (let i = 0; i < 8; i++) {
                const targetLeagueKey = leagues[Math.floor(Math.random() * leagues.length)];
                const matches = latestScrape[targetLeagueKey];
                if (matches && matches.length > 0) {
                    const matchObj = matches[Math.floor(Math.random() * matches.length)];
                    matchBatch.push({ league: targetLeagueKey, ...matchObj });
                }
            }

            if (matchBatch.length === 0) {
                 return res.status(400).json({ error: 'Failed to extract matches for batching.' });
            }

            // Decorate matches with Form Analytics simultaneously
            let augmentedBatch = [];
            for (let mb of matchBatch) {
                const [homeTeam, awayTeam] = mb.match.split(' vs ').map(t => t.trim());
                mb.homeTeamObj = homeTeam; mb.awayTeamObj = awayTeam;
                const homeForm = await computeTeamForm(homeTeam, mb.league);
                const awayForm = await computeTeamForm(awayTeam, mb.league);
                const h2hForm = await computeH2HForm(homeTeam, awayTeam, mb.league);

                augmentedBatch.push({
                    league: mb.league,
                    home: homeTeam,
                    away: awayTeam,
                    match: mb.match,
                    oddsStr: mb.odds,
                    homeForm: homeForm || 'Unknown',
                    awayForm: awayForm || 'Unknown',
                    h2hForm: h2hForm || 'Unknown'
                });
            }

            // Execute Batch Engine
            let predictions = [];
            if (type === 'ai') {
                const prompt = generateBatchSmartPrompt(augmentedBatch);
                globalsPass.broadcastAiStatus('generating', 'Oracle computing batch AI probabilities...');
                const aiResult = await callPredictionAI(prompt);
                const parsedArray = parseAIJson(aiResult.content);

                if (Array.isArray(parsedArray)) {
                    predictions = parsedArray.map(p => ({
                        league: 'Virtual League',
                        match: p.match || 'Match',
                        tip: p.tip || 'Unknown edge',
                        confidence: p.confidence || ''
                    }));
                } else {
                    return res.status(500).json({ error: 'AI failed to format JSON array response.' });
                }
            } else {
                // Fast Normal Probability
                for (let bt of augmentedBatch) {
                    const probs = calculateImpliedProbability(bt.oddsStr);
                    let tip = "No Edge";
                    let confidence = "50%";

                    if (probs.valid) {
                       const max = Math.max(probs.home, probs.draw, probs.away);
                       if (probs.home === max && probs.home > 40) tip = "Home Win";
                       else if (probs.away === max && probs.away > 40) tip = "Away Win";
                       else if (probs.draw === max && probs.draw > 30) tip = "Draw (Risky)";
                       else tip = "Over 1.5 Goals";
                       confidence = `${max || 60}%`;
                    }
                    
                    predictions.push({
                        league: bt.league,
                        match: bt.match,
                        tip: tip,
                        confidence: confidence
                    });
                }
            }

            // Deduct Points
            if (!hasActiveSub) {
                user.pointsBalance -= BATCH_COST;
                user.totalPredictionsRequested += 1;
                await user.save();
            }

            globalsPass.broadcastAiStatus('idle', 'Batch successful.');
            
            res.json({
                success: true,
                newBalance: user.pointsBalance,
                predictions: predictions.slice(0, 8)
            });

        } catch (e) {
            console.error('[WebApp API] Predict Batch Error:', e);
            res.status(500).json({ error: 'Prediction processor crashed' });
        }
    });

    return router;
};
