const TelegramBot = require('node-telegram-bot-api');
const { TelegramUser, SystemSettings } = require('./db_init');
const { callPredictionAI, parseAIJson } = require('./prediction_ai');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;
let systemGlobals = null;

if (token) {
    bot = new TelegramBot(token, { polling: true });
    console.log('[TelegramBot] 🤖 Bot connected and polling initialized.');
} else {
    console.warn('[TelegramBot] ⚠️ TELEGRAM_BOT_TOKEN missing. Bot will not start.');
}

// Ensure global settings exist
async function getSettings() {
    let settings = await SystemSettings.findById('global_config');
    if (!settings) {
        settings = await SystemSettings.create({ _id: 'global_config' });
    }
    return settings;
}

// Auth utility ensures user exists in db
async function authenticateUser(msg) {
    const chatId = msg.chat.id.toString();
    const username = msg.from.username || msg.from.first_name || 'User';
    
    let user = await TelegramUser.findById(chatId);
    if (!user) {
        user = await TelegramUser.create({
            _id: chatId,
            username,
            pointsBalance: 0,
            subscriptionTier: 'none'
        });
    }
    return user;
}

// Generate the Main Menu Inline Keyboard
function getMainMenu(user) {
    const webAppUrl = process.env.MINI_APP_URL || 'https://vfootball-dashboard.web.app'; // Placeholder
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📱 Open vFootball App', web_app: { url: webAppUrl } }],
                [
                    { text: '🔮 AI Predict', callback_data: 'predict_ai' },
                    { text: '⚡ Normal Predict', callback_data: 'predict_normal' }
                ],
                [
                    { text: '💳 Buy Points', callback_data: 'buy_points' },
                    { text: '💎 Subscribe PRO', callback_data: 'subscribe' }
                ],
                [{ text: `💰 Balance: ${user.pointsBalance} PTS`, callback_data: 'balance' }]
            ]
        }
    };
}

if (bot) {
    bot.onText(/\/start/, async (msg) => {
        const user = await authenticateUser(msg);
        bot.sendMessage(msg.chat.id, `👋 Welcome to vFootball AI, ${user.username}!\n\nGet live AI-powered predictions for virtual football matches right here.\n\nUse the menu below to get started.`, getMainMenu(user));
    });

    // Callback Query Handler for Inline Buttons
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const msgId = query.message.message_id;
        const action = query.data;
        const user = await authenticateUser(query.message);
        const settings = await getSettings();

        // Check if user has active subscription
        const hasActiveSub = user.subscriptionTier !== 'none' && user.subscriptionExpiry && new Date() < user.subscriptionExpiry;

        try {
            if (action === 'predict_ai' || action === 'predict_normal') {
                const cost = action === 'predict_ai' ? settings.aiPredictionCost : settings.normalPredictionCost;
                
                if (!hasActiveSub && user.pointsBalance < cost) {
                    await bot.answerCallbackQuery(query.id, { text: `❌ Not enough points! Need ${cost} points.`, show_alert: true });
                    return bot.sendMessage(chatId, `You need ${cost} points for this prediction. Buy points or subscribe!`, getMainMenu(user));
                }

                if (!hasActiveSub) {
                    user.pointsBalance -= cost;
                    user.totalPredictionsRequested += 1;
                    await user.save();
                }

                // Normal & AI Prediction extraction based on Live State
                bot.answerCallbackQuery(query.id, { text: `Searching live games...` });
                
                const typeName = action === 'predict_ai' ? '🤖 AI Deep' : '⚡ Normal';
                let tipText = "No live virtual games available right now for prediction. Try again later!";
                
                if (systemGlobals && systemGlobals.globalData && Object.keys(systemGlobals.globalData).length > 0) {
                    const latestScrape = systemGlobals.globalData[0] || {};
                    const leagues = Object.keys(latestScrape);
                    
                    if (leagues.length > 0) {
                        const targetLeague = leagues[Math.floor(Math.random() * leagues.length)];
                        const matches = latestScrape[targetLeague];
                        if (matches && matches.length > 0) {
                            const match = matches[0];
                            
                            if (action === 'predict_ai') {
                                bot.sendMessage(chatId, `🧠 Connecting to AI Core...\nAnalyzing ${match.home} vs ${match.away} in ${targetLeague}...`);
                                try {
                                    const prompt = `Act as an expert virtual football analyst. Analyze the following live match and provide a high-probability tip and a confidence percentage (between 70% and 99%).
                                    League: ${targetLeague}
                                    Match: ${match.home} vs ${match.away}
                                    Current Score: ${match.score}
                                    Return ONLY a JSON object exactly like this: {"tip": "String (e.g. Over 2.5 Goals, Home Win)", "confidence": "String (e.g. 85%)"}`;
                                    
                                    const aiResult = await callPredictionAI(prompt);
                                    const parsedDetails = parseAIJson(aiResult.content);

                                    tipText = `🔍 **${typeName} Prediction Generated**\n\n` +
                                              `League: ${targetLeague}\n` +
                                              `Match: ${match.home} vs ${match.away}\n` +
                                              `Score: ${match.score}\n\n` +
                                              `💡 **Tip:** ${parsedDetails.tip}\n` +
                                              `📈 **Confidence:** ${parsedDetails.confidence}`;
                                } catch (aiError) {
                                    console.error('[Bot AI Error]', aiError);
                                    tipText = "⚠️ The AI Core is currently busy or down. Please try again or use Normal predict.";
                                }
                            } else {
                                tipText = `🔍 **${typeName} Prediction Generated**\n\n` +
                                          `League: ${targetLeague}\n` +
                                          `Match: ${match.home} vs ${match.away}\n` +
                                          `Score: ${match.score}\n\n` +
                                          `Tip: Home to Score Next (1X) 📊\n` +
                                          `Confidence: 70%`;
                            }
                        }
                    }
                }

                bot.sendMessage(chatId, tipText, { parse_mode: 'Markdown' });
            
            } else if (action === 'buy_points') {
                bot.answerCallbackQuery(query.id);
                // Prompt user with point packages (can link to Squad API or send Telegram Stars invoice here)
                const pointPackages = {
                    inline_keyboard: [
                        [{ text: '⭐ 100 Points - 100 Stars', callback_data: 'purchase_stars_100' },
                         { text: '⭐ 500 Points - 450 Stars', callback_data: 'purchase_stars_500' }],
                        [{ text: '💳 500 Points - ₦2500 (Squad)', url: 'https://pay.squadco.com/vfootball500' }],
                        [{ text: '🔙 Back', callback_data: 'main_menu' }]
                    ]
                };
                bot.editMessageText(`Choose a package to buy points.`, { chat_id: chatId, message_id: msgId, reply_markup: pointPackages.inline_keyboard });
            
            } else if (action === 'purchase_stars_100' || action === 'purchase_stars_500') {
                bot.answerCallbackQuery(query.id);
                const is100 = action === 'purchase_stars_100';
                const pkgPoints = is100 ? 100 : 500;
                const pkgPrices = [ { label: 'Points', amount: is100 ? 100 : 450 } ];
                
                bot.sendInvoice(
                    chatId,
                    `vFootball ${pkgPoints} Points Pack`,
                    `Purchase ${pkgPoints} points to use for AI Live Matches and Normal Predictions.`,
                    `stars_points_${pkgPoints}_${Date.now()}`,
                    '', // Provider token must be empty for Telegram Stars
                    'XTR', // Telegram Stars Currency
                    pkgPrices
                );
            } else if (action === 'balance') {
                bot.answerCallbackQuery(query.id, { text: `💰 Balance: ${user.pointsBalance} Points\n💎 Sub: ${user.subscriptionTier.toUpperCase()}`, show_alert: true });
            
            } else if (action === 'main_menu') {
                bot.answerCallbackQuery(query.id);
                bot.editMessageText(`Welcome to vFootball AI!`, { chat_id: chatId, message_id: msgId, reply_markup: getMainMenu(user).reply_markup });
            }

        } catch (err) {
            console.error('[Bot Error]', err);
            bot.answerCallbackQuery(query.id, { text: 'An error occurred. Please try again later.', show_alert: true });
        }
    });

    // Handle Telegram Stars Pre-Checkout
    bot.on('pre_checkout_query', (query) => {
        // We can validate if user is allowed to buy, stock available, etc.
        // For digital goods (points), we generally always approve.
        bot.answerPreCheckoutQuery(query.id, true);
    });

    // Handle Telegram Stars Successful Payment
    bot.on('successful_payment', async (msg) => {
        const chatId = msg.chat.id.toString();
        const payload = msg.successful_payment.invoice_payload;
        
        let pointsToAdd = 0;
        if (payload.includes('stars_points_100')) pointsToAdd = 100;
        if (payload.includes('stars_points_500')) pointsToAdd = 500;
        
        if (pointsToAdd > 0) {
            const user = await TelegramUser.findById(chatId);
            if (user) {
                user.pointsBalance += pointsToAdd;
                await user.save();
                
                // Log transaction
                const { Transaction } = require('./db_init');
                await Transaction.create({
                    _id: msg.successful_payment.telegram_payment_charge_id,
                    telegramId: chatId,
                    amount: pointsToAdd,
                    currency: 'STARS',
                    method: 'telegram_stars',
                    status: 'completed',
                    type: 'points',
                    itemBought: `${pointsToAdd} Points Pack`
                });

                bot.sendMessage(chatId, `✅ Payment Successful! You bought ${pointsToAdd} points.\n\nYour new balance is ${user.pointsBalance} PTS.`, getMainMenu(user));
            }
        }
    });

    bot.on('polling_error', (error) => {
        console.warn('[TelegramBot Polling Error]', error.message);
    });
}

function startBot(globals) {
    systemGlobals = globals;
    console.log('[TelegramBot] Bridge initialized with global state context.');
}

module.exports = {
    bot,
    startBot
};
