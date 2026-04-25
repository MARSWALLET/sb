// ─────────────────────────────────────────────────────────────────────────────
// prediction_ai.js — Unified Text-Generation AI Router for Predictions
//
// Supported providers (OpenAI intentionally excluded per user preference):
//   deepseek : DeepSeek Chat  — fast, JSON-native, OpenAI-compatible
//   gemini   : Google Gemini  — multi-key rotation, large context window
//   claude   : Anthropic Claude — elite reasoning, complex pattern detection
//
// Quick usage:
//   const { callPredictionAI, parseAIJson, getActivePredictionProvider,
//           setActivePredictionProvider, PREDICTION_PROVIDERS } = require('./prediction_ai');
//
//   // Per-call override (optional — falls back to global setting):
//   const result = await callPredictionAI(prompt, 'claude', { maxTokens: 8000 });
//   const json   = parseAIJson(result.content);
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

let GoogleGenerativeAI;
try {
    GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
} catch {
    console.warn('[PredictionAI] ⚠️  @google/generative-ai not installed — Gemini calls will fail');
}

// ── Gemini key rotation pool ──────────────────────────────────────────────────
// Reads all GEMINI_API_KEY* vars from .env and round-robins them
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_FRIEND1,
    process.env.GEMINI_API_KEY_FRIEND2,
    process.env.GEMINI_API_KEY_FRIEND3,
    process.env.GEMINI_API_KEY_FRIEND4,
].filter(k => k && k.startsWith('AIza'));

let _geminiIdx = 0;
function _nextGeminiKey() {
    if (!GEMINI_KEYS.length) throw new Error('No valid Gemini API keys (must start with "AIza") in .env');
    const key = GEMINI_KEYS[_geminiIdx % GEMINI_KEYS.length];
    console.log(`[PredictionAI] 🔑 Gemini key ${(_geminiIdx % GEMINI_KEYS.length) + 1}/${GEMINI_KEYS.length} (…${key.slice(-6)})`);
    _geminiIdx++;
    return key;
}

// ── Provider registry ─────────────────────────────────────────────────────────
const PREDICTION_PROVIDERS = {
    deepseek: {
        id:          'deepseek',
        label:       'DeepSeek',
        emoji:       '🚀',
        model:       'deepseek-chat',
        description: 'Fast · JSON-native · Low cost',
        badge:       'DEFAULT',
        badgeColor:  '#00FF88',
        available:   () => !!(process.env.DEEPSEEK_API_KEY),
    },
    gemini: {
        id:          'gemini',
        label:       'Google Gemini',
        emoji:       '✨',
        model:       'gemini-3.1-pro-preview',
        description: `Smart · ${GEMINI_KEYS.length}-key rotation · Large context`,
        badge:       `${GEMINI_KEYS.length} KEY${GEMINI_KEYS.length !== 1 ? 'S' : ''}`,
        badgeColor:  '#00E5FF',
        available:   () => GEMINI_KEYS.length > 0,
    },
    claude: {
        id:          'claude',
        label:       'Anthropic Claude',
        emoji:       '🧠',
        model:       'claude-3-5-sonnet-20241022',
        description: 'Elite reasoning · Complex patterns',
        badge:       'ELITE',
        badgeColor:  '#A78BFA',
        available:   () => !!(process.env.ANTHROPIC_API_KEY),
    },
};

// ── Global active provider (session-level, changed via /api/ai-provider POST) ─
let _activeProvider = (() => {
    if (process.env.DEEPSEEK_API_KEY)  return 'deepseek';
    if (GEMINI_KEYS.length > 0)        return 'gemini';
    if (process.env.ANTHROPIC_API_KEY) return 'claude';
    return 'deepseek';
})();

console.log(`[PredictionAI] 🤖 Auto-selected provider: ${_activeProvider}`);

function getActivePredictionProvider() { return _activeProvider; }

function setActivePredictionProvider(p) {
    if (!PREDICTION_PROVIDERS[p]) {
        throw new Error(`Unknown provider "${p}". Valid: ${Object.keys(PREDICTION_PROVIDERS).join(', ')}`);
    }
    if (!PREDICTION_PROVIDERS[p].available()) {
        throw new Error(`Provider "${p}" has no API key in .env — configure ${p === 'deepseek' ? 'DEEPSEEK_API_KEY' : p === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'}`);
    }
    const prev = _activeProvider;
    _activeProvider = p;
    console.log(`[PredictionAI] 🔄 Provider: ${prev} → ${p} (${PREDICTION_PROVIDERS[p].label})`);
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────
async function _callDeepSeek(prompt, { maxTokens = 8000, temperature = 0.7 } = {}) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    console.log(`[PredictionAI] 🚀 DeepSeek → maxTokens=${maxTokens} temp=${temperature}`);
    const t0 = Date.now();

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body:    JSON.stringify({
            model:           'deepseek-chat',
            messages:        [{ role: 'user', content: prompt }],
            temperature,
            max_tokens:      maxTokens
        }),
    });
    if (!res.ok) {
        const txt = await res.text();
        console.error(`[PredictionAI] ❌ DeepSeek ${res.status}:`, txt.slice(0, 400));
        throw new Error(`DeepSeek ${res.status}: ${txt}`);
    }
    const d       = await res.json();
    const content = d.choices?.[0]?.message?.content || '';
    const tokens  = d.usage?.total_tokens || 0;
    console.log(`[PredictionAI] ✅ DeepSeek ${Date.now() - t0}ms | ${content.length} chars | ${tokens} tokens`);
    return { content, provider: 'deepseek', model: 'deepseek-chat', tokensUsed: tokens, ms: Date.now() - t0 };
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function _callGemini(prompt, { maxTokens = 8000, temperature = 0.7 } = {}) {
    if (!GoogleGenerativeAI) throw new Error('@google/generative-ai not installed');
    const key = _nextGeminiKey();
    console.log(`[PredictionAI] ✨ Gemini → maxTokens=${maxTokens} temp=${temperature}`);
    const t0 = Date.now();

    const genAI  = new GoogleGenerativeAI(key);
    const mkModel = (modelName) => genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
    });

    let result;
    // Prefer gemini-2.5-pro; fallback to 1.5-pro or flash variants
    for (const modelName of ['gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']) {
        try {
            result = await mkModel(modelName).generateContent(prompt);
            const content = result.response.text();
            console.log(`[PredictionAI] ✅ Gemini (${modelName}) ${Date.now() - t0}ms | ${content.length} chars`);
            return { content, provider: 'gemini', model: modelName, tokensUsed: 0, ms: Date.now() - t0 };
        } catch (err) {
            if (err.message?.includes('not found') || err.message?.includes('404') || err.message?.includes('deprecated')) {
                console.warn(`[PredictionAI] ⚠️  ${modelName} unavailable — trying next...`);
                continue;
            }
            console.error(`[PredictionAI] ❌ Gemini error:`, err.message);
            throw err;
        }
    }
    throw new Error('All Gemini model variants failed');
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function _callClaude(prompt, { maxTokens = 8000, temperature = 0.7 } = {}) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not configured in .env');
    console.log(`[PredictionAI] 🧠 Claude → maxTokens=${maxTokens} temp=${temperature}`);
    const t0 = Date.now();

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
            'Content-Type':      'application/json',
            'x-api-key':         key,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model:      'claude-3-7-sonnet-20250219',
            max_tokens: maxTokens,
            temperature,
            messages:   [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) {
        const txt = await res.text();
        console.error(`[PredictionAI] ❌ Claude ${res.status}:`, txt.slice(0, 400));
        throw new Error(`Claude ${res.status}: ${txt}`);
    }
    const d       = await res.json();
    const content = d.content?.[0]?.text || '';
    const tokens  = (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0);
    console.log(`[PredictionAI] ✅ Claude (${d.model}) ${Date.now() - t0}ms | ${content.length} chars | ${tokens} tokens`);
    return { content, provider: 'claude', model: d.model, tokensUsed: tokens, ms: Date.now() - t0 };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function callPredictionAI(prompt, providerOverride = null, options = {}) {
    const provider = (providerOverride || _activeProvider).toLowerCase();
    console.log(`[PredictionAI] 📡 Dispatching → ${provider.toUpperCase()} (${PREDICTION_PROVIDERS[provider]?.label || provider})`);

    if (!PREDICTION_PROVIDERS[provider]) {
        throw new Error(`Unknown AI provider: "${provider}". Valid: ${Object.keys(PREDICTION_PROVIDERS).join(', ')}`);
    }
    switch (provider) {
        case 'deepseek': return _callDeepSeek(prompt, options);
        case 'gemini':   return _callGemini(prompt, options);
        case 'claude':   return _callClaude(prompt, options);
        default:         throw new Error(`No handler registered for provider: ${provider}`);
    }
}

// ── JSON parser — 4-strategy cascade (works across all providers) ─────────────
function parseAIJson(content) {
    if (!content || typeof content !== 'string') throw new Error('AI returned empty/null content');
    const cleaned = content.replace(/```json\s*|```\s*/g, '').trim();

    // Strategy 1: direct parse
    try { return JSON.parse(cleaned); } catch {}

    // Strategy 2: first {...} via regex
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch {}
        // Strategy 3: outermost brace search within the match
        const s = m[0].indexOf('{'), e = m[0].lastIndexOf('}');
        if (s !== -1 && e > s) {
            try { return JSON.parse(m[0].slice(s, e + 1)); } catch {}
        }
    }

    // Strategy 4: scan full cleaned string
    const fs2 = cleaned.indexOf('{'), fe = cleaned.lastIndexOf('}');
    if (fs2 !== -1 && fe > fs2) {
        try { return JSON.parse(cleaned.slice(fs2, fe + 1)); } catch {}
    }

    console.error('[PredictionAI] ❌ JSON parse failed. First 600 chars of AI output:\n', content.slice(0, 600));
    throw new Error('Cannot parse AI response as JSON — check server logs for raw output');
}

// ── Implied Probability Math Engine ──────────────────────────────────────────────
function calculateImpliedProbability(oddsString) {
    // Expected format: "1(1.50) X(3.20) 2(5.00)" or similar
    const result = { home: 0, draw: 0, away: 0, valid: false };
    if (!oddsString) return result;

    try {
        // Extract numbers inside parenthesis
        const matches = [...oddsString.matchAll(/\(([\d.]+)\)/g)];
        if (matches.length >= 3) {
            const odd1 = parseFloat(matches[0][1]);
            const oddX = parseFloat(matches[1][1]);
            const odd2 = parseFloat(matches[2][1]);

            if (odd1 && oddX && odd2) {
                // Implied Probability = (1 / decimal odds) * 100
                const prob1 = (1 / odd1) * 100;
                const probX = (1 / oddX) * 100;
                const prob2 = (1 / odd2) * 100;
                
                // Margin (Overround) calculation
                const totalMargin = prob1 + probX + prob2;

                // True Probability = (Implied / Total Margin) * 100
                result.home = Math.round((prob1 / totalMargin) * 100);
                result.draw = Math.round((probX / totalMargin) * 100);
                result.away = Math.round((prob2 / totalMargin) * 100);
                result.valid = true;
            }
        }
    } catch (err) {
        console.warn('[PredictionAI] Failed to calculate implied probability:', err.message);
    }
    return result;
}

function generateSmartPrompt(league, home, away, oddsStr) {
    const probs = calculateImpliedProbability(oddsStr);
    let insights = '';

    if (probs.valid) {
        insights = `Mathematical Implied Probabilities based on Bookmaker Odds:
- Home Win: ${probs.home}%
- Draw: ${probs.draw}%
- Away Win: ${probs.away}%

Identify the highest value bet. If one team has >55% probability, consider a direct win or Over 1.5. 
If probabilities are tight, consider Double Chance or Under 2.5/3.5 goals.`;
    } else {
        insights = `No valid odds provided. Rely on general team strength for this context.`;
    }

    return `Act as an elite virtual football quantitative analyst.
Analyze the following live match:
League: ${league}
Match: ${home} vs ${away}
Live Odds String: ${oddsStr}

${insights}

Calculate the best outcome based strictly on mathematical edge.
Return ONLY a JSON object exactly like this:
{"tip": "String (e.g. Over 2.5 Goals, 1X, Home Win)", "confidence": "String (e.g. 85%)"}
Do not wrap in markdown \`\`\`json. Just the raw JSON object.`;
}

// ── Provider status (for the /api/ai-provider endpoint) ──────────────────────
function getPredictionProviderStatus() {
    return {
        active:         _activeProvider,
        geminiKeyCount: GEMINI_KEYS.length,
        providers: Object.values(PREDICTION_PROVIDERS).map(p => ({
            id:          p.id,
            label:       p.label,
            emoji:       p.emoji,
            model:       p.model,
            description: p.description,
            badge:       p.badge,
            badgeColor:  p.badgeColor,
            available:   p.available(),
            isActive:    p.id === _activeProvider,
        })),
    };
}

module.exports = {
    callPredictionAI,
    parseAIJson,
    calculateImpliedProbability,
    generateSmartPrompt,
    getActivePredictionProvider,
    setActivePredictionProvider,
    getPredictionProviderStatus,
    PREDICTION_PROVIDERS,
    GEMINI_KEYS,
};
