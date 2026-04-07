// ─────────────────────────────────────────────────────────────────────────────
// ai_memory.js
//
// Persistent memory and log system for the DeepSeek AI analysis engine.
// Stores all analyses in ai_analysis_log.json so DeepSeek can reference
// past patterns, trends, and predictions in future calls.
//
// Structure of each log entry:
// {
//   id:         string (uuid-style timestamp+random)
//   createdAt:  ISO timestamp
//   scope:      'today' | 'range' | 'all'
//   dateLabel:  human-readable date description
//   dateFrom:   string DD/MM/YYYY (optional)
//   dateTo:     string DD/MM/YYYY (optional)
//   league:     string (blank = all leagues)
//   matchCount: number
//   analysis:   { summary, keyInsights, winnerStats, ... } (DeepSeek response)
//   tokensUsed: number
// }
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'ai_analysis_log.json');

// ── Read all entries ───────────────────────────────────────────────────────
function readLog() {
    try {
        if (!fs.existsSync(LOG_PATH)) return [];
        const raw = fs.readFileSync(LOG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('[AI Memory] ❌ Failed to read log:', err.message);
        return [];
    }
}

// ── Write all entries ───────────────────────────────────────────────────────
function writeLog(entries) {
    try {
        fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
    } catch (err) {
        console.error('[AI Memory] ❌ Failed to write log:', err.message);
    }
}

// ── Save a new analysis entry ──────────────────────────────────────────────
function saveAnalysis(entry) {
    const log = readLog();
    const id  = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full = { id, createdAt: new Date().toISOString(), ...entry };
    log.unshift(full); // newest first
    // Keep max 200 entries to prevent file bloat
    writeLog(log.slice(0, 200));
    console.log(`[AI Memory] ✅ Saved analysis entry ${id} (log size: ${Math.min(log.length + 1, 200)})`);
    return full;
}

// ── Get recent entries for context injection ────────────────────────────────
/**
 * Returns last N analyses as a compact context string for DeepSeek prompts.
 * Helps the AI remember its own past findings & build on predictions.
 */
function getRecentContext(n = 5) {
    const log = readLog();
    const recent = log.slice(0, n);
    if (recent.length === 0) return '';

    const lines = recent.map((entry, i) => {
        const a = entry.analysis;
        return [
            `[Memory ${i + 1}] ${entry.dateLabel} (${entry.scope}) — League: ${entry.league || 'All'}`,
            `  Summary: ${a?.summary?.slice(0, 150) || 'N/A'}`,
            `  Avg Goals: ${a?.avgGoalsPerMatch || '?'} | Home Wins: ${a?.winnerStats?.homeWins || 0} | Draws: ${a?.winnerStats?.draws || 0} | Away Wins: ${a?.winnerStats?.awayWins || 0}`,
            `  Prediction made: ${a?.prediction?.slice(0, 120) || 'N/A'}`,
            `  Dominant Teams: ${(a?.dominantTeams || []).join(', ') || 'N/A'}`,
        ].join('\n');
    });

    return `\n\n=== YOUR PAST ANALYSIS MEMORY (last ${recent.length} sessions) ===\n${lines.join('\n\n')}\n==========================================\nUse this memory to identify patterns, validate past predictions, and provide more accurate insights.\n`;
}

// ── Get full log for UI history panel ─────────────────────────────────────
function getLog(limit = 50) {
    const log = readLog();
    return log.slice(0, limit).map(entry => ({
        id:         entry.id,
        createdAt:  entry.createdAt,
        scope:      entry.scope,
        dateLabel:  entry.dateLabel,
        dateFrom:   entry.dateFrom,
        dateTo:     entry.dateTo,
        league:     entry.league,
        matchCount: entry.matchCount,
        tokensUsed: entry.tokensUsed,
        // Only include a brief summary in the list, not full analysis
        summary:    entry.analysis?.summary?.slice(0, 200) || '',
        formRating: entry.analysis?.formRating || null,
        prediction: entry.analysis?.prediction?.slice(0, 150) || '',
    }));
}

// ── Delete an entry by id ──────────────────────────────────────────────────
function deleteEntry(id) {
    const log = readLog();
    const filtered = log.filter(e => e.id !== id);
    writeLog(filtered);
    return log.length - filtered.length; // number deleted
}

// ── Get a single entry by id (for full detail view) ───────────────────────
function getEntryById(id) {
    const log = readLog();
    return log.find(e => e.id === id) || null;
}

// ── Clear entire log ───────────────────────────────────────────────────────
function clearLog() {
    writeLog([]);
    console.log('[AI Memory] 🗑️ Log cleared.');
}

module.exports = { saveAnalysis, getRecentContext, getLog, deleteEntry, getEntryById, clearLog };
