const express = require('express');
const router = express.Router();
const { TelegramUser, Transaction } = require('../db_init');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Payments & Webhooks (Squad API)
// ─────────────────────────────────────────────────────────────────────────────
module.exports = function(globals) {

    // POST /api/payments/squad/webhook
    // This receives the server-to-server webhook from Squad when a user completes payment
    router.post('/api/payments/squad/webhook', async (req, res) => {
        try {
            // Validate the webhook signature
            const squadSecret = process.env.SQUAD_SECRET_KEY;
            if (squadSecret) {
                const hash = crypto.createHmac('sha512', squadSecret).update(JSON.stringify(req.body)).digest('hex').toUpperCase();
                if (hash !== req.headers['x-squad-encrypted-body']) {
                    return res.status(401).send('Invalid signature');
                }
            }

            const { Event, TransactionRef, Amount, Status, MetaData } = req.body;
            
            // We only care about successful charges
            if (Event !== 'charge_successful' && Status !== 'success') {
                return res.status(200).send('Ignored');
            }

            // Check if transaction was already processed
            const existingTx = await Transaction.findById(TransactionRef);
            if (existingTx) {
                return res.status(200).send('Already processed');
            }

            // The frontend or Telegram bot should have passed telegramId in the Squad Payment Link metadata
            // e.g. MetaData: { telegramId: "12345678", points: 500 }
            if (!MetaData || !MetaData.telegramId) {
                return res.status(200).send('Missing telegramId in metadata');
            }

            const type = MetaData.type || 'points';
            const user = await TelegramUser.findById(MetaData.telegramId);

            if (user) {
                let itemBought = '';

                if (type === 'points') {
                    const pointsToAdd = Number(MetaData.points || 0);
                    if (pointsToAdd > 0) {
                        user.pointsBalance += pointsToAdd;
                        itemBought = `${pointsToAdd} Points Pack via Squad`;
                        
                        const { bot } = require('../telegram_bot');
                        if (bot) {
                            bot.sendMessage(user._id, `✅ Squad Payment Successful! You bought ${pointsToAdd} points.\n\nYour new balance is ${user.pointsBalance} PTS.`);
                        }
                    }
                } else if (type === 'pro') {
                    user.subscriptionTier = 'pro';
                    user.subscriptionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
                    itemBought = '1 Month PRO Subscription via Squad';

                    const { bot } = require('../telegram_bot');
                    if (bot) {
                        bot.sendMessage(user._id, `💎 Squad Payment Successful! You are now a PRO completely unrestricted for 30 days.`);
                    }
                }

                await user.save();

                // Track transaction internally
                if (itemBought) {
                    await Transaction.create({
                        _id: TransactionRef,
                        telegramId: MetaData.telegramId,
                        amount: Amount,
                        currency: 'NGN',
                        method: 'squad_api',
                        status: 'completed',
                        type: type,
                        itemBought: itemBought
                    });
                }
            }

            res.status(200).send('Success');
        } catch (err) {
            console.error('[Squad Webhook Error]', err);
            res.status(500).send('Server Error');
        }
    });

    return router;
};
