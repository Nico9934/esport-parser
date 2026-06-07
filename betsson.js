/**
 * ESBScout — Módulo Betsson
 * Scraper de odds en tiempo real de Betsson Argentina
 * Estructura confirmada via DevTools — sin login requerido
 *
 * Endpoints usados:
 *   GET /api/sb/v1/widgets/events-table/v2  → lista de eventos con IDs
 *   GET /api/sb/v1/widgets/accordion/v1     → odds de ganador y goles
 */

const fetch = require('node-fetch');

const BETSSON_BASE = 'https://pba.betsson.bet.ar';

// Headers confirmados — necesarios para evitar E_VALIDATION_INVALIDHEADER
const BETSSON_HEADERS = {
    'brandid': '238cb63a-3dcc-4fdf-b241-23a12cb71aa7',
    'marketcode': 'ag',
    'x-sb-country-code': 'AR',
    'x-sb-currency-code': 'ARS',
    'x-sb-language-code': 'ag',
    'x-sb-channel': 'Web',
    'x-sb-device-type': 'Desktop',
    'x-sb-jurisdiction': 'Iplyc',
    'x-sb-type': 'b2b',
    'x-sb-identifier': 'EVENT_TABLE_REQUEST',
    'x-sb-app-version': '7.37.24.3502-r6766298',
    'x-obg-channel': 'Web',
    'x-obg-device': 'Desktop',
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'referer': 'https://pba.betsson.bet.ar/apuestas-deportivas/futbol/efootball/batalla-de-efootball-8-minutos-de-juego',
};

const TIMEOUT_MS = 10000;

// Cache de eventos (se refresca cada 3 min para no hammear Betsson)
let eventsCache = null;
let eventsCacheTime = 0;
const CACHE_TTL = 3 * 60 * 1000;

// ── FETCH CON TIMEOUT ─────────────────────────────────────────
async function bFetch(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(`${BETSSON_BASE}${path}`, {
            headers: BETSSON_HEADERS,
            signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    } finally {
        clearTimeout(timer);
    }
}

// ── TRAER TODOS LOS EVENTOS DE ESB ───────────────────────────
async function fetchEvents() {
    const now = Date.now();
    if (eventsCache && (now - eventsCacheTime) < CACHE_TTL) {
        return eventsCache;
    }

    try {
        const params = new URLSearchParams({
            categoryIds: '1',
            competitionIds: '24814',
            eventPhase: 'Prematch',
            eventSortBy: 'StartDate',
            includeSkeleton: 'false',
            maxMarketCount: '1',
            pageNumber: '1',
            regionIds: '319',
            priceFormats: '1',
        });

        const data = await bFetch(`/api/sb/v1/widgets/events-table/v2?${params}`);
        const events = data?.data?.events || [];
        console.log(`[BETSSON] ✅ ${events.length} eventos encontrados`);

        eventsCache = events;
        eventsCacheTime = now;
        return events;
    } catch (e) {
        console.error(`[BETSSON] ❌ fetchEvents: ${e.message}`);
        return eventsCache || [];
    }
}

// ── TRAER ODDS DE UN EVENTO ───────────────────────────────────
// Devuelve { winHome, winDraw, winAway, goalsLine, oddOver, oddUnder }
async function fetchOdds(eventId) {
    try {
        const [winnerData, totalData] = await Promise.all([
            bFetch(`/api/sb/v1/widgets/accordion/v1?eventId=${eventId}&groupableId=ESFMWINNER3W`),
            bFetch(`/api/sb/v1/widgets/accordion/v1?eventId=${eventId}&groupableId=ESFMTOTAL`),
        ]);

        // Ganador
        const ws = winnerData?.data?.accordions?.ESFMWINNER3W?.selections || [];
        const winHome = ws.find(s => s.selectionTemplateId === 'HOME')?.odds || null;
        const winAway = ws.find(s => s.selectionTemplateId === 'AWAY')?.odds || null;
        const winDraw = ws.find(s => s.selectionTemplateId === 'DRAW')?.odds || null;

        // Goles — la línea viene en el marketId: m-{id}-ESFMTOTAL-5.5
        const tm = totalData?.data?.accordions?.ESFMTOTAL?.markets?.[0];
        const goalsLine = tm?.lineValue ? parseFloat(tm.lineValue) : null;
        const ts = totalData?.data?.accordions?.ESFMTOTAL?.selections || [];
        const oddOver = ts.find(s => s.selectionTemplateId === 'OVER')?.odds || null;
        const oddUnder = ts.find(s => s.selectionTemplateId === 'UNDER')?.odds || null;

        return { winHome, winDraw, winAway, goalsLine, oddOver, oddUnder };
    } catch (e) {
        console.error(`[BETSSON] ❌ fetchOdds ${eventId}: ${e.message}`);
        return null;
    }
}

// ── EXTRAER NICKNAME DE "Bayern Munchen (Pavlinho19)" ─────────
function extractNick(label) {
    if (!label) return null;
    const m = label.match(/\(([^)]+)\)/);
    return m ? m[1].trim() : null;
}

// ── EXTRAER EQUIPO DE "Bayern Munchen (Pavlinho19)" ───────────
function extractTeam(label) {
    if (!label) return null;
    return label.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

/**
 * Busca en Betsson el partido entre nick1 y nick2
 * y devuelve sus odds + equipos.
 *
 * @returns {object|null} {
 *   eventId, homeTeam, awayTeam, homeNick, awayNick, startDate,
 *   winHome, winDraw, winAway,
 *   goalsLine, oddOver, oddUnder,
 *   url
 * }
 */
async function getMatchOdds(nick1, nick2) {
    try {
        const events = await fetchEvents();
        const n1 = nick1.toLowerCase();
        const n2 = nick2.toLowerCase();

        // Buscar el evento que tenga ambos nicknames
        const ev = events.find(ev => {
            const p1nick = extractNick(ev.participants?.[0]?.label || '')?.toLowerCase();
            const p2nick = extractNick(ev.participants?.[1]?.label || '')?.toLowerCase();
            return (p1nick === n1 && p2nick === n2) ||
                (p1nick === n2 && p2nick === n1);
        });

        if (!ev) {
            console.log(`[BETSSON] ⚠️ No encontrado en Betsson: ${nick1} vs ${nick2}`);
            return null;
        }

        const homeLabel = ev.participants?.[0]?.label || '';
        const awayLabel = ev.participants?.[1]?.label || '';
        const homeNick = extractNick(homeLabel);
        const awayNick = extractNick(awayLabel);
        const homeTeam = extractTeam(homeLabel);
        const awayTeam = extractTeam(awayLabel);

        const odds = await fetchOdds(ev.id);
        if (!odds) return null;

        // Si nick1 es el away, invertir winHome/winAway para que siempre
        // winNick1 corresponda a nick1 sin importar el orden
        const nick1IsHome = homeNick?.toLowerCase() === n1;

        console.log(`[BETSSON] ✅ ${homeTeam} (${homeNick}) vs ${awayTeam} (${awayNick}) | 1=${odds.winHome} X=${odds.winDraw} 2=${odds.winAway} | Over${odds.goalsLine}=${odds.oddOver}`);

        return {
            eventId: ev.id,
            homeTeam, awayTeam,
            homeNick, awayNick,
            startDate: ev.startDate,
            url: `${BETSSON_BASE}/apuestas-deportivas/futbol/efootball/batalla-de-efootball-8-minutos-de-juego/${ev.slug || ''}`,
            // Odds de ganador — en perspectiva de nick1/nick2
            winNick1: nick1IsHome ? odds.winHome : odds.winAway,
            winNick2: nick1IsHome ? odds.winAway : odds.winHome,
            winDraw: odds.winDraw,
            winHome: odds.winHome,
            winAway: odds.winAway,
            // Goles
            goalsLine: odds.goalsLine,
            oddOver: odds.oddOver,
            oddUnder: odds.oddUnder,
        };
    } catch (e) {
        console.error(`[BETSSON] ❌ getMatchOdds: ${e.message}`);
        return null;
    }
}

/**
 * Invalida el cache de eventos (útil al inicio de cada scan)
 */
function invalidateCache() {
    eventsCache = null;
    eventsCacheTime = 0;
}

/**
 * Debug: imprime tabla de todos los eventos con odds
 */
async function debugPrintAll() {
    invalidateCache();
    const events = await fetchEvents();
    if (!events.length) { console.log('[BETSSON] Sin eventos'); return; }

    console.log(`\n[BETSSON] ═══ ${events.length} EVENTOS ═══`);
    for (let i = 0; i < events.length; i += 3) {
        const batch = events.slice(i, i + 3);
        const results = await Promise.all(batch.map(async ev => {
            const odds = await fetchOdds(ev.id);
            const hora = new Date(ev.startDate).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            return { label: ev.label, hora, odds };
        }));
        results.forEach(r => {
            const o = r.odds;
            console.log(`  ${r.hora} | ${r.label}`);
            if (o) console.log(`         1=${o.winHome} X=${o.winDraw} 2=${o.winAway} | Over${o.goalsLine}=${o.oddOver} Under=${o.oddUnder}`);
            else console.log(`         sin odds`);
        });
    }
    console.log('[BETSSON] ══════════════════════════════');
}

module.exports = { getMatchOdds, invalidateCache, debugPrintAll };