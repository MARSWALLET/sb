// ─────────────────────────────────────────────────────────────────────────────
// firebase_reader.js
//
// Reads match results from Firebase Firestore for the public landing page.
// All data comes directly from Firestore (vfootball_results collection),
// ensuring 100% accuracy — the same data the admin uploaded.
//
// Functions:
//   fetchResultsFromFirebase({ league, dateFrom, dateTo, page, pageSize })
//   fetchTodayResultsFromFirebase({ league })
// ─────────────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

let db = null;

// ── Init Firebase (idempotent) ─────────────────────────────────────────────
function initFirebase() {
    if (admin.apps.length > 0) {
        db = admin.firestore();
        return true;
    }
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyPath)) {
        console.error('[Firebase Reader] ❌ serviceAccountKey.json not found');
        return false;
    }
    try {
        const serviceAccount = require(keyPath);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log('[Firebase Reader] ✅ Initialized Firestore for reads.');
        return true;
    } catch (err) {
        console.error('[Firebase Reader] ❌ Init failed:', err.message);
        return false;
    }
}

// ── Date helpers ───────────────────────────────────────────────────────────
// Stored date format in Firestore: DD/MM/YYYY
function todayDDMMYYYY() {
    const now  = new Date();
    const dd   = String(now.getDate()).padStart(2, '0');
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

function parseDDMMYYYY(str) {
    if (!str) return null;
    const [d, m, y] = str.split('/');
    return new Date(`${y}-${m}-${d}`);
}

// ── Group raw docs by date ─────────────────────────────────────────────────
function groupByDate(docs) {
    const byDate = {};
    docs.forEach(doc => {
        const d = doc.date || 'Unknown';
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(doc);
    });

    // Sort dates newest first
    const sorted = Object.keys(byDate).sort((a, b) => {
        const pa = parseDDMMYYYY(a) || new Date(0);
        const pb = parseDDMMYYYY(b) || new Date(0);
        return pb - pa;
    });

    return sorted.map(date => {
        // Sort matches by time descending within each date
        const matches = byDate[date].sort((a, b) => {
            const toMins = t => {
                const [h, m] = (t || '00:00').split(':');
                return Number(h) * 60 + Number(m);
            };
            return toMins(b.time) - toMins(a.time);
        });
        // Group within date by league
        const byLeague = {};
        matches.forEach(m => {
            const lg = m.league || 'Unknown';
            if (!byLeague[lg]) byLeague[lg] = [];
            byLeague[lg].push(m);
        });
        return { date, totalMatches: matches.length, leagues: byLeague };
    });
}

// ── Main fetch function ────────────────────────────────────────────────────
/**
 * Fetches match data from Firestore with optional filters.
 * @param {Object} opts
 * @param {string}  opts.league   - Filter by league name (optional)
 * @param {string}  opts.dateFrom - Start date DD/MM/YYYY (optional)
 * @param {string}  opts.dateTo   - End date DD/MM/YYYY (optional)
 * @param {number}  opts.page     - 1-indexed page number
 * @param {number}  opts.pageSize - Dates per page
 * @returns {Promise<{ dates, totalDates, totalPages, page, availableLeagues }>}
 */
async function fetchResultsFromFirebase(opts = {}) {
    const { league, dateFrom, dateTo, page = 1, pageSize = 3 } = opts;
    if (!initFirebase()) throw new Error('Firebase not initialized. Check serviceAccountKey.json.');

    console.log(`[Firebase Reader] Fetching: league=${league||'ALL'} from=${dateFrom||'ANY'} to=${dateTo||'ANY'} page=${page}`);

    // Fetch all from collection (Firestore has no DD/MM/YYYY date indexing natively)
    // We filter client-side since collection volume is manageable (~thousands)
    const snapshot = await db.collection('vfootball_results').get();
    let docs = snapshot.docs.map(d => ({ ...d.data(), _id: d.id }));

    console.log(`[Firebase Reader] Raw docs from Firestore: ${docs.length}`);

    // Apply league filter
    if (league) docs = docs.filter(d => d.league === league);

    // Apply date range filter
    const fromDate = parseDDMMYYYY(dateFrom);
    const toDate   = parseDDMMYYYY(dateTo);
    if (fromDate || toDate) {
        docs = docs.filter(d => {
            const matchDate = parseDDMMYYYY(d.date);
            if (!matchDate) return false;
            if (fromDate && matchDate < fromDate) return false;
            if (toDate   && matchDate > toDate)   return false;
            return true;
        });
    }

    // Collect unique leagues for filter UI
    const availableLeagues = [...new Set(
        snapshot.docs.map(d => d.data().league).filter(Boolean)
    )].sort();

    // Group by date, sort newest first
    const allGrouped = groupByDate(docs);
    const totalDates = allGrouped.length;
    const totalPages = Math.max(1, Math.ceil(totalDates / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const pageSlice = allGrouped.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    return { dates: pageSlice, totalDates, totalPages, page: currentPage, availableLeagues };
}

/**
 * Fetches only today's match data from Firestore.
 * @param {string} leagueFilter - Optional league name
 * @returns {Promise<Array>} flat array of today's matches
 */
async function fetchTodayResultsFromFirebase(leagueFilter = '') {
    if (!initFirebase()) throw new Error('Firebase not initialized.');
    const today = todayDDMMYYYY();
    console.log(`[Firebase Reader] Fetching today's results: ${today}`);

    const snapshot = await db.collection('vfootball_results')
        .where('date', '==', today)
        .get();

    let docs = snapshot.docs.map(d => ({ ...d.data(), _id: d.id }));
    if (leagueFilter) docs = docs.filter(d => d.league === leagueFilter);
    console.log(`[Firebase Reader] Today's docs: ${docs.length}`);
    return docs;
}

module.exports = { fetchResultsFromFirebase, fetchTodayResultsFromFirebase, todayDDMMYYYY };
