require('dotenv').config();
const mongoose = require('mongoose');

let isConnected = false;

async function connectDb() {
    if (isConnected) return;

    if (!process.env.MONGO_URI) {
        console.error('[db_init] ❌ MONGO_URI missing in .env');
        // Let's not throw immediately so the server doesn't crash on start,
        // but warn clearly.
    }

    try {
        const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/live-sports-dashboard';
        await mongoose.connect(uri);
        isConnected = true;
        console.log('[db_init] ✅ MongoDB connection established.');
    } catch (err) {
        console.error('[db_init] ❌ Failed to connect to MongoDB:', err.message);
        throw err;
    }
}

// ── Models ─────────────────────────────────────────────────────────────────

const resultSchema = new mongoose.Schema({
    _id: String, // use constructed ID to act exactly like Firestore to avoid duplicates
    date: String,
    gameId: String,
    league: String,
    homeTeam: String,
    awayTeam: String,
    score: String,
    sourceTag: String,
    uploadedAt: { type: Date, default: Date.now },
}, { strict: false }); // Allow all scraped fields

const historyLogSchema = new mongoose.Schema({
    _id: String,
    status: String,
    uploadedPages: [Number],
    updatedAt: { type: Date, default: Date.now }
}, { strict: false });

const leagueIntelligenceSchema = new mongoose.Schema({
    _id: String,
    league: String,
    updatedAt: { type: Date, default: Date.now }
}, { strict: false });

const dailyTipSchema = new mongoose.Schema({
    _id: String,
    date: String,
    league: String,
    uploadedAt: { type: Date, default: Date.now }
}, { strict: false });

const analysisLogSchema = new mongoose.Schema({
    // allow auto _id if not provided
    dateLabel: String,
    league: String,
    scope: String,
    createdAt: { type: Date, default: Date.now }
}, { strict: false });

const behaviorSignalSchema = new mongoose.Schema({
    _id: String, // e.g. "teamName_date"
    team: String,
    dateLabel: String,
    lastComputed: { type: Date, default: Date.now }
}, { strict: false }); // for behaviour_pattern_engine.js

const systemStrategySchema = new mongoose.Schema({
    _id: String,
    currentStrategy: String,
    activeRules: [String],
    timesUsed: Number,
    successfulHits: Number,
    failures: Number,
    updatedAt: Date
}, { strict: false });

const strategyHistorySchema = new mongoose.Schema({
    _id: String, // timestamp string
    date: Date,
    action: String,
    added: [String],
    removed: [String],
    monitored: [String]
}, { strict: false });

const leagueBaselineSchema = new mongoose.Schema({
    _id: String, // league name
    league: String,
    matchCount: Number,
    stats: Object,
    topScores: Array,
    lastComputed: { type: Date, default: Date.now }
}, { strict: false });

const Result = mongoose.models.Result || mongoose.model('Result', resultSchema, 'vfootball_results');
const HistoryLog = mongoose.models.HistoryLog || mongoose.model('HistoryLog', historyLogSchema, 'history_logs');
const LeagueIntelligence = mongoose.models.LeagueIntelligence || mongoose.model('LeagueIntelligence', leagueIntelligenceSchema, 'ai_league_intelligence');
const DailyTip = mongoose.models.DailyTip || mongoose.model('DailyTip', dailyTipSchema, 'daily_tips');
const AnalysisLog = mongoose.models.AnalysisLog || mongoose.model('AnalysisLog', analysisLogSchema, 'ai_analysis_log');
const BehaviorSignal = mongoose.models.BehaviorSignal || mongoose.model('BehaviorSignal', behaviorSignalSchema, 'behavior_signals');
const SystemStrategy = mongoose.models.SystemStrategy || mongoose.model('SystemStrategy', systemStrategySchema, 'ai_system');
const StrategyHistory = mongoose.models.StrategyHistory || mongoose.model('StrategyHistory', strategyHistorySchema, 'ai_strategy_history');
const LeagueBaseline = mongoose.models.LeagueBaseline || mongoose.model('LeagueBaseline', leagueBaselineSchema, 'league_baselines');

// ── Pattern Snapshot Schema ────────────────────────────────────────────────────
// Each document is one "daily snapshot" of all triggered patterns for a given date.
// The engine saves this when patterns are computed, and later the next day's
// result-upload resolves the outcome so we can track accuracy over time.
const patternSnapshotSchema = new mongoose.Schema({
    _id: String,              // e.g. "23/04/2026_EnglandVirtual_Arsenal_1:1_Home"
    snapshotDate: String,     // DD/MM/YYYY — the date the TRIGGER match was played
    resolvedDate: String,     // DD/MM/YYYY — the date the NEXT match was played (set post-fact)
    league: String,
    team: String,
    score: String,            // trigger score e.g. "1:1"
    role: String,             // "Home" | "Away"
    sampleSize: Number,
    eliteOutcomes: Array,     // [{key, label, emoji, pct, hit, failed}]
    mostRecentTrigger: Object,
    recentTriggers: Array,
    // Resolution fields (filled in after the next match result is known)
    resolved: { type: Boolean, default: false },
    resolvedScore: String,    // actual score of next match
    resolvedOutcomes: Object, // { win, loss, draw, over15, over25, gg, homeScores, awayScores }
    // Per-outcome accuracy: true=hit, false=miss, null=pending
    outcomeResults: { type: Object, default: {} },
    savedAt: { type: Date, default: Date.now },
}, { strict: false });

const PatternSnapshot = mongoose.models.PatternSnapshot || mongoose.model('PatternSnapshot', patternSnapshotSchema, 'pattern_snapshots');

// ── Telegram Monetization Schemas ──────────────────────────────────────────────
const telegramUserSchema = new mongoose.Schema({
    _id: String, // telegram chat ID
    username: String,
    
    // Auth & Identity
    email: { type: String, default: null },
    isEmailVerified: { type: Boolean, default: false },
    otpCode: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    botState: { type: String, enum: ['none', 'awaiting_email', 'awaiting_otp'], default: 'none' },

    // Financial
    pointsBalance: { type: Number, default: 0 },
    subscriptionTier: { type: String, enum: ['none', 'pro', 'vip'], default: 'none' },
    subscriptionExpiry: { type: Date, default: null },
    totalPredictionsRequested: { type: Number, default: 0 },
    hasAcceptedTerms: { type: Boolean, default: false },
    
    // Referrals & Rewards
    referredBy: { type: String, default: null }, // ID of whoever referred them
    referralsCount: { type: Number, default: 0 },
    totalReferralEarnings: { type: Number, default: 0 },
    lastBonusClaimDate: { type: Date, default: null },
    joinedAt: { type: Date, default: Date.now }
}, { strict: false });

const transactionSchema = new mongoose.Schema({
    _id: String, // system generated transaction id
    telegramId: String,
    amount: Number,
    currency: { type: String, default: 'STARS' }, // 'STARS', 'NGN', 'USD'
    method: { type: String, enum: ['telegram_stars', 'squad_api', 'manual'], default: 'telegram_stars' },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
    reference: String, // Payment Gateway reference
    type: { type: String, enum: ['points', 'subscription'], default: 'points' },
    itemBought: String, // e.g., "100 Points Pack", "1 Month PRO"
    timestamp: { type: Date, default: Date.now }
}, { strict: false });

const systemSettingsSchema = new mongoose.Schema({
    _id: String, // usually just 'global_config'
    normalPredictionCost: { type: Number, default: 1 },
    aiPredictionCost: { type: Number, default: 5 },
    referralRewardPoints: { type: Number, default: 10 },
    pointsRates: { type: Object, default: { '100': 100, '500': 450, '1000': 800 } }, // Star/Currency cost per point pack
    subscriptionRates: { type: Object, default: { 'pro_monthly': 2500, 'vip_monthly': 5000 } },
    updatedAt: { type: Date, default: Date.now }
}, { strict: false });

const TelegramUser = mongoose.models.TelegramUser || mongoose.model('TelegramUser', telegramUserSchema, 'telegram_users');
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema, 'transactions');
const SystemSettings = mongoose.models.SystemSettings || mongoose.model('SystemSettings', systemSettingsSchema, 'system_settings');

module.exports = {
    connectDb,
    mongoose,
    Result,
    HistoryLog,
    LeagueIntelligence,
    DailyTip,
    AnalysisLog,
    BehaviorSignal,
    SystemStrategy,
    StrategyHistory,
    LeagueBaseline,
    PatternSnapshot,
    TelegramUser,
    Transaction,
    SystemSettings
};
