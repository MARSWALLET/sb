const express = require('express');
const router = express.Router();
const { TelegramUser, Transaction, SystemSettings } = require('../db_init');

// ─────────────────────────────────────────────────────────────────────────────
// Admin Billing & Telegram User Management Routes
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function(globals) {
    // GET /api/admin/system-settings
    router.get('/api/admin/system-settings', async (req, res) => {
        try {
            let settings = await SystemSettings.findById('global_config');
            if (!settings) {
                settings = await SystemSettings.create({ _id: 'global_config' });
            }
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/admin/system-settings
    // Updates global points costs and subscription rates
    router.post('/api/admin/system-settings', async (req, res) => {
        try {
            const { normalPredictionCost, aiPredictionCost, pointsRates, subscriptionRates } = req.body;
            let settings = await SystemSettings.findOneAndUpdate(
                { _id: 'global_config' },
                { $set: { normalPredictionCost, aiPredictionCost, pointsRates, subscriptionRates, updatedAt: new Date() } },
                { new: true, upsert: true }
            );
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/admin/telegram-users
    // Lists all users that have interacted with the bot
    router.get('/api/admin/telegram-users', async (req, res) => {
        try {
            const users = await TelegramUser.find({}).sort({ joinedAt: -1 }).limit(100);
            res.json({ success: true, users });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/admin/telegram-users/:id/points
    // Manually add or deduct points from a user
    router.post('/api/admin/telegram-users/:id/points', async (req, res) => {
        try {
            const { pointsToAdd } = req.body;
            const user = await TelegramUser.findById(req.params.id);
            if (!user) return res.status(404).json({ success: false, error: 'User not found' });
            
            user.pointsBalance += Number(pointsToAdd);
            await user.save();
            
            // Log transaction
            await Transaction.create({
                _id: 'MANUAL_' + Date.now(),
                telegramId: user._id,
                amount: pointsToAdd,
                method: 'manual',
                status: 'completed',
                type: 'points',
                itemBought: 'Admin Manual Adjustment'
            });

            res.json({ success: true, user });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/admin/transactions
    // List recent payments via Stars/Squad
    router.get('/api/admin/transactions', async (req, res) => {
        try {
            const txs = await Transaction.find({}).sort({ timestamp: -1 }).limit(100);
            res.json({ success: true, transactions: txs });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
