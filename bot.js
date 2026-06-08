/**
 * ESBScout — Bot de Telegram v3.0
 * - Odds reales de Betsson integradas (ganador + goles)
 * - Estrategia ganador: diff≥12%, wr≥50%, forma≥52%, edge≥3%
 * - Estrategia goles:   usa la línea real de Betsson, overMin≥60%
 *
 * Setup:
 *   1. npm install node-fetch node-cron dotenv
 *   2. Crear .env con TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
 *   3. node bot.js
 */

require('dotenv').config();
const fetch    = require('node-fetch');
const cron     = require('node-cron');
const betsson  = require('./betsson');

const fs   = require('fs');
const path = require('path');

// ── SISTEMA DE LOGS A ARCHIVO ─────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function getLogFile() {
  const d = new Date();
  const date = d.toISOString().split('T')[0];
  return path.join(logsDir, `bot-${date}.log`);
}

const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);

function writeLog(level, args) {
  const ts  = new Date().toLocaleTimeString('es-AR', { hour12: false });
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${ts}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(getLogFile(), line, 'utf-8'); } catch(e) {}
}

console.log = (...args) => { _origLog(...args); writeLog('INFO', args); };
console.error = (...args) => { _origError(...args); writeLog('ERROR', args); };

// ── CONFIG ────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const ESB        = 'https://football.esportsbattle.com/api';
const SCAN_CRON     = '*/7 * * * *';
const RESOLVE_CRON  = '*/5 * * * *';  // revisar resultados cada 5 min
const SERVER        = process.env.SERVER_URL || 'http://localhost:3000';
const TIMEOUT_MS    = 15000;

// Parámetros óptimos validados en backtest
const STRATEGY_GANADOR = {
  diffMin:  12,
  wrMin:    50,
  formMin:  52,
  edgeMin:  3,
  simOdd:   1.85,   // fallback si Betsson no tiene el partido
};

const STRATEGY_GOLES = {
  overMin:   60,    // media geométrica de Over% mínima
  edgeMin:   3,     // edge vs odd implícita de Betsson
  stdDevMax: 25,
  sampleMin: 10,
};

const notifiedMatchIds = new Set();

// ── HELPERS ───────────────────────────────────────────────────
async function apiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-store' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json();
    if (!data.ok) console.error('[TG] ❌', data.description);
    else          console.log('[TG] ✅ Enviado');
  } catch(e) {
    console.error('[TG] ❌', e.message);
  }
}

// ── TORNEOS DEL DÍA ───────────────────────────────────────────
function getTodayRange() {
  const now = new Date();
  const to  = new Date(now);
  to.setHours(to.getHours() + 4);
  const fmt = d => {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth()+1).padStart(2,'0');
    const dd   = String(d.getDate()).padStart(2,'0');
    const hh   = String(d.getHours()).padStart(2,'0');
    const min  = String(d.getMinutes()).padStart(2,'0');
    return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
  };
  return { dateFrom: fmt(now), dateTo: fmt(to) };
}

async function getTodayMatches() {
  const { dateFrom, dateTo } = getTodayRange();
  console.log(`[SCAN] 📅 ${dateFrom} → ${dateTo}`);
  try {
    const params = new URLSearchParams({ page: 1, dateFrom, dateTo });
    const data = await apiFetch(`${ESB}/tournaments?${params}`);
    const tournaments = data.tournaments || [];
    console.log(`[SCAN] 📋 Torneos: ${tournaments.length}`);

    const allMatches = [];
    await Promise.allSettled(
      tournaments.slice(0, 30).map(async t => {
        try {
          const matches = await apiFetch(`${ESB}/tournaments/${t.id}/matches`);
          if (Array.isArray(matches)) allMatches.push(...matches);
        } catch(e) {}
      })
    );

    // Status breakdown para debug
    const sc = {};
    allMatches.forEach(m => { const s = m.status_id ?? 'null'; sc[s] = (sc[s]||0)+1; });
    console.log(`[SCAN] 📊 status_id:`, JSON.stringify(sc));

    // Pendientes: status_id !== 3 y !== 4, con score null o fecha futura
    const pending = allMatches.filter(m => {
      if (!m.participant1?.nickname || !m.participant2?.nickname) return false;
      if (m.status_id === 3 || m.status_id === 4) return false;
      const s1 = m.participant1?.score;
      const s2 = m.participant2?.score;
      if (s1 === null && s2 === null) return true;
      if (m.date && new Date(m.date).getTime() > Date.now()) return true;
      return false;
    });

    console.log(`[SCAN] 🎮 Pendientes: ${pending.length}/${allMatches.length}`);
    return pending;
  } catch(e) {
    console.error('[SCAN] ❌', e.message);
    return [];
  }
}

// ── FORMA RECIENTE ────────────────────────────────────────────
async function getRecentForm(nickname) {
  try {
    const pages = await Promise.all([1,2,3,4].map(p =>
      apiFetch(`${ESB}/participants/${nickname}/tournaments?page=${p}`)
    ));
    const tournaments = pages
      .flatMap(r => r.tournaments || [])
      .filter(t => t.status_id === 3 || t.status_id === 4)
      .slice(0, 6);
    if (!tournaments.length) return null;

    const matchData = await Promise.all(
      tournaments.map(t => apiFetch(`${ESB}/tournaments/${t.id}/matches`))
    );
    const allMatches = matchData.flat().filter(m =>
      m.participant1?.nickname === nickname || m.participant2?.nickname === nickname
    );

    let wins=0, losses=0, draws=0, gf=0, ga=0;
    const totals = [];
    allMatches.forEach(m => {
      const isP1 = m.participant1?.nickname === nickname;
      const hg = isP1 ? m.participant1.score : m.participant2.score;
      const og = isP1 ? m.participant2.score : m.participant1.score;
      if (hg > og) wins++; else if (hg < og) losses++; else draws++;
      gf += hg; ga += og;
      totals.push(hg + og);
    });

    const total = wins + losses + draws;
    const avgTot = total > 0 ? totals.reduce((a,b)=>a+b,0)/total : 0;
    const variance = total > 1 ? totals.reduce((s,t)=>s+(t-avgTot)**2,0)/(total-1) : 0;
    const stdDev = Math.sqrt(variance);
    const over = line => total > 0 ? totals.filter(t=>t>line).length/total*100 : 0;

    return {
      recentWinPct:  total > 0 ? wins/total*100 : 0,
      recentMatches: total,
      w: wins, d: draws, l: losses,
      avgTotal: avgTot,
      stdDev:   parseFloat(stdDev.toFixed(2)),
      over45:   parseFloat(over(4).toFixed(1)),
      over55:   parseFloat(over(5).toFixed(1)),
      over65:   parseFloat(over(6).toFixed(1)),
    };
  } catch(e) { return null; }
}

// ── ESTRATEGIA GANADOR ────────────────────────────────────────
function getConfidenceGanador(favWr, rivWr, favForm, favNick, rivNick, betssonOdds) {
  const { diffMin, wrMin, formMin, edgeMin, simOdd } = STRATEGY_GANADOR;
  const diff = favWr - rivWr;

  // Usar odd real de Betsson si está disponible, sino fallback
  const oddFav = betssonOdds?.winFav || simOdd;
  const impliedProb = 1 / oddFav * 100;
  const edge = favWr - impliedProb;

  if (diff < diffMin) {
    console.log(`[CONF] ❌ ${favNick} vs ${rivNick}: diff=${diff.toFixed(1)}% < ${diffMin}%`);
    return { pass: true };
  }
  if (favWr < wrMin) {
    console.log(`[CONF] ❌ ${favNick} vs ${rivNick}: favWr=${favWr.toFixed(1)}% < ${wrMin}%`);
    return { pass: true };
  }
  if (edge < edgeMin) {
    console.log(`[CONF] ❌ ${favNick} vs ${rivNick}: edge=${edge.toFixed(1)}% < ${edgeMin}% (odd=${oddFav})`);
    return { pass: true };
  }

  let confCls, pct;
  if      (diff < diffMin * 2)    { confCls = 'mhigh'; pct = 0.03; }
  else if (diff < diffMin * 3.33) { confCls = 'high';  pct = 0.05; }
  else                            { confCls = 'vhigh'; pct = 0.06; }

  if (favForm) {
    const formAlert = Math.abs(favForm.recentWinPct - favWr) > 15;
    if (formAlert) {
      console.log(`[CONF] ⚠️ ${favNick}: forma diverge (hist=${favWr.toFixed(0)}% vs rec=${favForm.recentWinPct.toFixed(0)}%)`);
      if      (confCls === 'vhigh') { confCls = 'high';  pct = 0.05; }
      else if (confCls === 'high')  { confCls = 'mhigh'; pct = 0.04; }
      else return { pass: true };
    }
    if (favForm.recentWinPct < formMin) {
      console.log(`[CONF] ❌ ${favNick}: forma=${favForm.recentWinPct.toFixed(1)}% < ${formMin}%`);
      return { pass: true };
    }
  } else {
    console.log(`[CONF] ⚠️ ${favNick}: sin forma, bajando confianza`);
    if      (confCls === 'vhigh') { confCls = 'high';  pct = 0.05; }
    else if (confCls === 'high')  { confCls = 'mhigh'; pct = 0.03; }
    else return { pass: true };
  }

  if (confCls === 'mhigh') {
    console.log(`[CONF] ⏭️ ${favNick} vs ${rivNick}: MEDIA-ALTA, skip`);
    return { pass: true };
  }

  console.log(`[CONF] ✅ ${favNick} vs ${rivNick}: ${confCls} diff=${diff.toFixed(1)}% edge=${edge.toFixed(1)}%`);
  const labels = { vhigh: '🟢🟢 MUY ALTA', high: '🟢 ALTA' };
  return { pass: false, confCls, pct, label: labels[confCls], diff, edge, oddUsed: oddFav };
}

// ── ESTRATEGIA GOLES ──────────────────────────────────────────
// Usa la línea REAL de Betsson en vez de asumir siempre 5.5
function getGoalsSignal(form1, form2, betssonOdds) {
  const { overMin, edgeMin, stdDevMax, sampleMin } = STRATEGY_GOLES;

  if (!form1 || !form2) return null;
  if (form1.recentMatches < sampleMin || form2.recentMatches < sampleMin) return null;

  // Si no hay odds de Betsson, no podemos calcular edge real → skip
  if (!betssonOdds?.goalsLine || !betssonOdds?.oddOver) return null;

  const line    = betssonOdds.goalsLine;
  const oddOver = betssonOdds.oddOver;

  // Elegir el Over% correspondiente a la línea real de Betsson
  let o1, o2;
  if      (line <= 4.5) { o1 = form1.over45; o2 = form2.over45; }
  else if (line <= 5.5) { o1 = form1.over55; o2 = form2.over55; }
  else                  { o1 = form1.over65; o2 = form2.over65; }

  // Media geométrica
  const overGeo     = Math.sqrt(o1 * o2);
  const stdDevPair  = (form1.stdDev + form2.stdDev) / 2;
  const impliedProb = 1 / oddOver * 100;
  const edge        = overGeo - impliedProb;

  if (overGeo < overMin)      return null;
  if (edge    < edgeMin)      return null;
  if (stdDevPair > stdDevMax) return null;

  return {
    line,
    overGeo:    parseFloat(overGeo.toFixed(1)),
    o1, o2,
    stdDevPair: parseFloat(stdDevPair.toFixed(1)),
    edge:       parseFloat(edge.toFixed(1)),
    oddOver,
    oddUnder:   betssonOdds.oddUnder,
  };
}

// ── ANALIZAR UN PAR ───────────────────────────────────────────
async function analyzePair(nick1, nick2, matchId, scheduledAt) {
  try {
    // Win rates históricos
    const compare = await apiFetch(`${ESB}/participants/${nick1}/compare/${nick2}`);
    if (!Array.isArray(compare) || compare.length < 2 || !compare[0] || !compare[1]) return null;

    const p1  = compare[0], p2 = compare[1];
    const wr1 = p1.totalMatches > 0 ? p1.totalWin/p1.totalMatches*100 : 0;
    const wr2 = p2.totalMatches > 0 ? p2.totalWin/p2.totalMatches*100 : 0;

    const isP1Fav = wr1 >= wr2;
    const favNick = isP1Fav ? nick1 : nick2;
    const rivNick = isP1Fav ? nick2 : nick1;
    const favWr   = isP1Fav ? wr1 : wr2;
    const rivWr   = isP1Fav ? wr2 : wr1;

    console.log(`[ANALYZE] ${nick1}(${wr1.toFixed(1)}%) vs ${nick2}(${wr2.toFixed(1)}%)`);

    // Forma reciente + Betsson en paralelo
    const [favForm, rivForm, betssonRaw] = await Promise.all([
      getRecentForm(favNick),
      getRecentForm(rivNick),
      betsson.getMatchOdds(nick1, nick2),
    ]);

    // Normalizar odds de Betsson en perspectiva del favorito
    let betssonOdds = null;
    if (betssonRaw) {
      const favIsNick1 = favNick.toLowerCase() === nick1.toLowerCase();
      betssonOdds = {
        homeTeam:  betssonRaw.homeTeam,
        awayTeam:  betssonRaw.awayTeam,
        homeNick:  betssonRaw.homeNick,
        awayNick:  betssonRaw.awayNick,
        winFav:    favIsNick1 ? betssonRaw.winNick1 : betssonRaw.winNick2,
        winRiv:    favIsNick1 ? betssonRaw.winNick2 : betssonRaw.winNick1,
        winDraw:   betssonRaw.winDraw,
        goalsLine: betssonRaw.goalsLine,
        oddOver:   betssonRaw.oddOver,
        oddUnder:  betssonRaw.oddUnder,
        url:       betssonRaw.url,
      };
    }

    const confGanador = getConfidenceGanador(favWr, rivWr, favForm, favNick, rivNick, betssonOdds);
    const goalsSignal = getGoalsSignal(favForm, rivForm, betssonOdds);

    if (confGanador.pass && !goalsSignal) return null;

    return {
      matchId, scheduledAt,
      nick1, nick2, favNick, rivNick,
      favWr, rivWr,
      favForm, rivForm,
      confGanador, goalsSignal,
      betssonOdds,
    };
  } catch(e) {
    console.error(`[ANALYZE] ❌ ${nick1} vs ${nick2}: ${e.message}`);
    return null;
  }
}

// ── FORMATEAR MENSAJE ─────────────────────────────────────────
function formatMessage(result, bankroll) {
  const { nick1, nick2, favNick, rivNick, favWr, rivWr,
          favForm, rivForm, confGanador, goalsSignal,
          betssonOdds, scheduledAt } = result;

  const hora = scheduledAt
    ? new Date(scheduledAt).toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit', hour12:false})
    : '—';

  const lines = [];

  // Cabecera — con equipos si Betsson los tiene
  if (betssonOdds?.homeTeam && betssonOdds?.awayTeam) {
    lines.push(`🏟 <b>${betssonOdds.homeTeam} vs ${betssonOdds.awayTeam}</b>`);
  }
  lines.push(`👤 <b>${nick1} vs ${nick2}</b>  🕐 ${hora}`);
  lines.push('');

  // ── GANADOR ──
  if (!confGanador.pass) {
    const betAmt = bankroll && confGanador.pct > 0
      ? `$${Math.floor(bankroll * confGanador.pct).toLocaleString('es-AR')}`
      : `${(confGanador.pct*100).toFixed(0)}% bankroll`;

    const formStr = favForm
      ? `${favForm.recentWinPct.toFixed(0)}% (${favForm.w}W/${favForm.d}D/${favForm.l}L · ${favForm.recentMatches}p)`
      : 'sin datos';

    // Odds de Betsson o aviso de fallback
    const oddFavStr  = betssonOdds?.winFav  ? betssonOdds.winFav.toFixed(2)  : '—';
    const oddRivStr  = betssonOdds?.winRiv  ? betssonOdds.winRiv.toFixed(2)  : '—';
    const oddDrawStr = betssonOdds?.winDraw ? betssonOdds.winDraw.toFixed(2) : '—';
    const oddsLine   = betssonOdds
      ? `Fav: <b>${oddFavStr}</b>  ·  Riv: ${oddRivStr}  ·  Empate: ${oddDrawStr}`
      : `Odds Betsson: no disponible (usando estimada)`;

    lines.push(`🎯 <b>GANADOR — ${confGanador.label}</b>`);
    lines.push(`   Apostar a: <b>${favNick}</b>`);
    lines.push(`   Win%: fav ${favWr.toFixed(1)}%  ·  riv ${rivWr.toFixed(1)}%  ·  diff +${confGanador.diff.toFixed(1)}%`);
    lines.push(`   ${oddsLine}`);
    lines.push(`   Edge real: <b>+${confGanador.edge.toFixed(1)}%</b>`);
    lines.push(`   Forma reciente: ${formStr}`);
    lines.push(`   💰 Sugerido: <b>${betAmt}</b>`);
    lines.push('');
  }

  // ── GOLES ──
  if (goalsSignal) {
    const { line, overGeo, o1, o2, edge, stdDevPair, oddOver, oddUnder } = goalsSignal;
    const betAmtG = bankroll
      ? `$${Math.floor(bankroll * 0.03).toLocaleString('es-AR')}`
      : '3% bankroll';

    const avgPair = (favForm && rivForm)
      ? ((favForm.avgTotal + rivForm.avgTotal) / 2).toFixed(1)
      : '—';

    const oddOverStr  = oddOver  ? oddOver.toFixed(2)  : '—';
    const oddUnderStr = oddUnder ? oddUnder.toFixed(2) : '—';

    lines.push(`📊 <b>GOLES — Over ${line}</b>`);
    lines.push(`   Over% geo: <b>${overGeo.toFixed(1)}%</b>  (${favNick}: ${o1.toFixed(0)}% · ${rivNick}: ${o2.toFixed(0)}%)`);
    lines.push(`   Promedio goles del par: ${avgPair}`);
    lines.push(`   Betsson: Over <b>${oddOverStr}</b>  ·  Under ${oddUnderStr}`);
    lines.push(`   Edge real: <b>+${edge.toFixed(1)}%</b>  ·  StdDev: ${stdDevPair.toFixed(1)}`);
    lines.push(`   💰 Sugerido: <b>${betAmtG}</b>`);
    lines.push('');
  }

  // Link a Betsson
  if (betssonOdds?.url) {
    lines.push(`🔗 <a href="https://pba.betsson.bet.ar/apuestas-deportivas/futbol/efootball/batalla-de-efootball-8-minutos-de-juego">Ver en Betsson</a>`);
  } else {
    lines.push(`⚠️ <i>Partido no encontrado en Betsson — buscá: ${nick1} vs ${nick2}</i>`);
  }

  return lines.join('\n');
}

// ── GUARDAR SEÑAL EN DB ───────────────────────────────────────
async function saveSignal(result, bankroll) {
  const { nick1, nick2, favNick, rivNick, favWr, rivWr,
          confGanador, goalsSignal, betssonOdds, scheduledAt } = result;
  try {
    const signals = [];
    if (!confGanador.pass) {
      signals.push({
        match_id: result.matchId, nick1, nick2,
        home_team: betssonOdds?.homeTeam || null,
        away_team: betssonOdds?.awayTeam || null,
        bet_type: 'ganador', bet_on: favNick,
        odd: betssonOdds?.winFav || STRATEGY_GANADOR.simOdd,
        amount: bankroll ? Math.floor(bankroll * confGanador.pct) : null,
        confidence: confGanador.confCls,
        fav_wr: favWr, riv_wr: rivWr,
        diff: confGanador.diff, edge: confGanador.edge,
        scheduled_at: scheduledAt,
      });
    }
    if (goalsSignal) {
      signals.push({
        match_id: result.matchId + '_goles', nick1, nick2,
        home_team: betssonOdds?.homeTeam || null,
        away_team: betssonOdds?.awayTeam || null,
        bet_type: 'goles', bet_on: `over ${goalsSignal.line}`,
        odd: goalsSignal.oddOver,
        amount: bankroll ? Math.floor(bankroll * 0.03) : null,
        confidence: 'signal',
        fav_wr: favWr, riv_wr: rivWr,
        diff: favWr - rivWr, edge: goalsSignal.edge,
        over_pct: goalsSignal.overGeo, goals_line: goalsSignal.line,
        scheduled_at: scheduledAt,
      });
    }
    for (const sig of signals) {
      await fetch(`${SERVER}/api/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sig),
      });
    }
    console.log(`[SIGNALS] ✅ ${signals.length} señal(es) guardada(s): ${nick1} vs ${nick2}`);
  } catch(e) {
    console.error(`[SIGNALS] ❌ ${e.message}`);
  }
}

// ── RESOLVER SEÑALES PENDIENTES ───────────────────────────────
async function resolveSignals() {
  try {
    const r = await fetch(`${SERVER}/api/signals/pending`);
    if (!r.ok) {
      console.error(`[RESOLVE] ❌ /api/signals/pending devolvió ${r.status}`);
      return;
    }
    const pending = await r.json();
    if (!pending.length) {
      console.log(`[RESOLVE] ✓ Sin señales pendientes`);
      return;
    }
    console.log(`[RESOLVE] 🔍 ${pending.length} señal(es) pendiente(s)`);

    for (const sig of pending) {
      try {
        const sigTime = sig.scheduled_at ? new Date(sig.scheduled_at).getTime() : null;

        // No intentar resolver si el partido todavía no debería haber terminado (20 min min)
        if (sigTime && Date.now() < sigTime + 20 * 60 * 1000) {
          console.log(`[RESOLVE] ⏰ ${sig.nick1} vs ${sig.nick2} — partido aún no debería haber terminado`);
          continue;
        }

        console.log(`[RESOLVE] 🔎 Buscando: ${sig.nick1} vs ${sig.nick2} | scheduled: ${sig.scheduled_at || 'N/A'}`);

        const pages = await Promise.all([1,2].map(p =>
          apiFetch(`${ESB}/participants/${sig.nick1}/tournaments?page=${p}`)
        ));
        const tournaments = pages
          .flatMap(r => r.tournaments || [])
          .filter(t => t.status_id === 4)
          .slice(0, 6);

        console.log(`[RESOLVE] 📋 Torneos finalizados: ${tournaments.length}`);

        // Recolectar TODOS los partidos candidatos de todos los torneos
        const candidates = [];
        for (const t of tournaments) {
          const matches = await apiFetch(`${ESB}/tournaments/${t.id}/matches`);
          for (const m of matches) {
            const n1 = m.participant1?.nickname;
            const n2 = m.participant2?.nickname;
            const sameNicks = (n1 === sig.nick1 && n2 === sig.nick2) ||
                              (n1 === sig.nick2 && n2 === sig.nick1);
            if (!sameNicks) continue;
            if (m.status_id !== 3) continue;
            if (m.participant1?.score === null || m.participant2?.score === null) continue;
            candidates.push(m);
          }
        }

        if (!candidates.length) {
          console.log(`[RESOLVE] ⏳ ${sig.nick1} vs ${sig.nick2} — sin resultado en ESB todavía`);
          continue;
        }

        // Elegir el candidato cuya fecha sea la más cercana al scheduled_at
        let bestMatch = candidates[0];
        if (sigTime && candidates.length > 1) {
          candidates.sort((a, b) => {
            const diffA = Math.abs(new Date(a.date).getTime() - sigTime);
            const diffB = Math.abs(new Date(b.date).getTime() - sigTime);
            return diffA - diffB;
          });
          bestMatch = candidates[0];
          const diffMin = Math.abs(new Date(bestMatch.date).getTime() - sigTime) / 60000;
          console.log(`[RESOLVE] 🎯 Mejor match: diff ${diffMin.toFixed(0)} min | ${candidates.length} candidatos`);

          // Si el más cercano está a más de 3 horas, es sospechoso
          if (diffMin > 180) {
            console.log(`[RESOLVE] ⚠️ ${sig.nick1} vs ${sig.nick2} — match más cercano a ${diffMin.toFixed(0)} min, esperando...`);
            continue;
          }
        }

        const s1 = bestMatch.participant1?.score;
        const s2 = bestMatch.participant2?.score;
        const totalGoals = s1 + s2;

        let betResult;
        if (sig.bet_type === 'ganador') {
          const favWon = (bestMatch.participant1?.nickname === sig.bet_on && s1 > s2) ||
                         (bestMatch.participant2?.nickname === sig.bet_on && s2 > s1);
          betResult = favWon ? 'win' : 'loss';
        } else {
          betResult = totalGoals > parseFloat(sig.goals_line) ? 'win' : 'loss';
        }

        await fetch(`${SERVER}/api/signals/${sig.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: betResult, score1: s1, score2: s2, total_goals: totalGoals }),
        });

        const profit = betResult === 'win'
          ? parseFloat(sig.amount) * (parseFloat(sig.odd) - 1)
          : -parseFloat(sig.amount);
        const emoji = betResult === 'win' ? '✅' : '❌';
        const tipo  = sig.bet_type === 'ganador' ? '🎯 Ganador' : '📊 Goles';
        const hora  = sig.scheduled_at
          ? new Date(sig.scheduled_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
          : '—';

        await sendTelegram([
          `${emoji} <b>RESULTADO — ${tipo}</b>`,
          ``,
          sig.home_team ? `🏟 <b>${sig.home_team} vs ${sig.away_team}</b>` : '',
          `👤 <b>${sig.nick1} vs ${sig.nick2}</b>  🕐 ${hora}`,
          `⚽ Marcador: <b>${s1} - ${s2}</b>${sig.bet_type === 'goles' ? ` (total ${totalGoals})` : ''}`,
          `🎯 Apostado a: ${sig.bet_on} @ ${sig.odd}`,
          `📊 <b>${betResult === 'win' ? 'GANÓ 🎉' : 'PERDIÓ 😞'}</b>`,
          sig.amount ? `💰 P&L: <b>${profit >= 0 ? '+' : ''}$${profit.toFixed(0)}</b>` : '',
        ].filter(Boolean).join('\n'));

        console.log(`[RESOLVE] ${emoji} ${sig.nick1} vs ${sig.nick2} | ${sig.bet_type} | ${betResult} | ${s1}-${s2} | P&L: $${profit.toFixed(0)}`);

      } catch(e) {
        console.error(`[RESOLVE] ❌ señal ${sig.id}: ${e.message}`);
      }
    }
  } catch(e) {
    console.error(`[RESOLVE] ❌ Error general: ${e.message}`);
  }
}

// ── HELPERS BETSSON ───────────────────────────────────────────
const extractNick = label => { const m = label?.match(/\(([^)]+)\)/); return m ? m[1].trim() : null; };
const extractTeam = label => label?.replace(/\s*\([^)]+\)\s*$/, '').trim() || '';

// ── SCAN PRINCIPAL ────────────────────────────────────────────
async function scan() {
  console.log(`\n[SCAN] 🔍 ${new Date().toLocaleTimeString('es-AR')}`);

  try {
    // 1. PRIMERO: traer eventos de Betsson — solo analizamos lo apostable
    betsson.invalidateCache();
    const betssonEvents = await betsson.fetchEvents();

    if (!betssonEvents.length) {
      console.log('[SCAN] Sin eventos en Betsson por ahora.');
      return;
    }
    console.log(`[SCAN] 🎰 Betsson: ${betssonEvents.length} eventos disponibles`);

    // Construir lista de pares desde Betsson
    const uniqueMatches = [];
    betssonEvents.forEach(ev => {
      const p0 = ev.participants?.[0];
      const p1 = ev.participants?.[1];
      if (!p0 || !p1) return;
      const nick1 = extractNick(p0.label);
      const nick2 = extractNick(p1.label);
      if (!nick1 || !nick2) return;
      const matchId = ev.id;
      if (notifiedMatchIds.has(matchId)) return;
      uniqueMatches.push({
        matchId, nick1, nick2,
        scheduledAt: ev.startDate,
      });
    });

    console.log(`[SCAN] 🎮 Pares a analizar: ${uniqueMatches.length}`);
    if (!uniqueMatches.length) return;

    // Bankroll actual
    let bankroll = null;
    try {
      const bankrollResponse = await fetch(`${SERVER}/api/bankroll`).then(r=>r.json());
      bankroll = bankrollResponse.bankroll;
    } catch(e) {}

    // 2. DESPUÉS: para cada par de Betsson, analizar con ESB de a 2
    const recommendations = [];
    for (let i = 0; i < uniqueMatches.length; i += 2) {
      const batch = uniqueMatches.slice(i, i+2);
      const results = await Promise.allSettled(
        batch.map(m => analyzePair(m.nick1, m.nick2, m.matchId, m.scheduledAt))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) recommendations.push(r.value);
      });
    }

    console.log(`[SCAN] ✅ Recomendaciones: ${recommendations.length}`);

    for (const rec of recommendations) {
      const msg = formatMessage(rec, bankroll);
      await sendTelegram(msg);
      await saveSignal(rec, bankroll);   // guardar en DB para seguimiento
      notifiedMatchIds.add(rec.matchId);
      console.log(`[SCAN] 📩 ${rec.nick1} vs ${rec.nick2}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!recommendations.length) console.log('[SCAN] Sin apuestas recomendadas.');

  } catch(e) {
    console.error('[SCAN] ❌', e.message);
  }
}

// ── POLLING DE COMANDOS ───────────────────────────────────────
let lastUpdateId = 0;

async function pollCommands() {
  try {
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=5`;
    const data = await fetch(url).then(r=>r.json());
    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const text   = update.message?.text || '';
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== CHAT_ID) continue;

      // /analizar Nick1 vs Nick2
      if (text.startsWith('/analizar')) {
        const parts = text.replace('/analizar','').trim().split(/\s+vs\s+/i);
        if (parts.length === 2) {
          const n1 = parts[0].trim(), n2 = parts[1].trim();
          await sendTelegram(`🔍 Analizando <b>${n1} vs ${n2}</b>...`);
          const result = await analyzePair(n1, n2, `manual-${n1}-${n2}`, null);
          if (result) await sendTelegram(formatMessage(result, null));
          else await sendTelegram(
            `❌ <b>${n1} vs ${n2}</b> no cumple ninguna estrategia.\n` +
            `Ganador: diff≥${STRATEGY_GANADOR.diffMin}%, wr≥${STRATEGY_GANADOR.wrMin}%, forma≥${STRATEGY_GANADOR.formMin}%\n` +
            `Goles: over%≥${STRATEGY_GOLES.overMin}%, edge≥${STRATEGY_GOLES.edgeMin}%`
          );
        } else {
          await sendTelegram('⚠️ Formato: <code>/analizar Nick1 vs Nick2</code>');
        }
      }

      // /odds — ver tabla de Betsson ahora mismo
      if (text === '/odds') {
        await sendTelegram('🔍 Consultando Betsson...');
        await betsson.debugPrintAll();
        await sendTelegram('✅ Tabla de odds impresa en consola del servidor.');
      }

      // /status
      if (text === '/status') {
        let bankroll = null;
        try { const br = await fetch(`${SERVER}/api/bankroll`).then(r=>r.json()); bankroll = br.bankroll; } catch(e) {}
        await sendTelegram([
          `📊 <b>ESBScout Bot v3.0</b>`,
          ``,
          `✅ Activo · escaneo cada 7 min`,
          `📋 Partidos notificados: ${notifiedMatchIds.size}`,
          bankroll ? `💰 Bankroll: <b>$${bankroll.toLocaleString('es-AR')}</b>` : `💰 Bankroll: no disponible`,
          ``,
          `🎯 Ganador: diff≥${STRATEGY_GANADOR.diffMin}% · wr≥${STRATEGY_GANADOR.wrMin}% · forma≥${STRATEGY_GANADOR.formMin}%`,
          `📊 Goles: over%≥${STRATEGY_GOLES.overMin}% · edge≥${STRATEGY_GOLES.edgeMin}% · stdDev≤${STRATEGY_GOLES.stdDevMax}`,
          ``,
          `Comandos: /analizar /odds /limpiar /status`,
        ].join('\n'));
      }

      // /resumen — ver performance del bot
      if (text === '/resumen') {
        try {
          const r = await fetch(`${SERVER}/api/signals/summary`);
          const data = await r.json();
          const t = data.totals;
          const lines = [
            `📊 <b>ESBScout Bot — Performance</b>`,
            ``,
            `📈 Total señales: ${t.total}  ·  Pendientes: ${t.pending}`,
            `✅ Wins: ${t.wins}  ·  ❌ Losses: ${t.losses}`,
            `🎯 Win rate: <b>${t.win_rate ?? '—'}%</b>`,
            `💰 Profit total: <b>${t.total_profit >= 0 ? '+' : ''}$${t.total_profit}</b>`,
            `📊 ROI: <b>${t.roi >= 0 ? '+' : ''}${t.roi ?? '—'}%</b>`,
            ``,
          ];
          data.by_type.forEach(bt => {
            lines.push(`<b>${bt.bet_type.toUpperCase()}</b>: ${bt.wins}W/${bt.losses}L · WR ${bt.win_rate}% · ROI ${bt.roi >= 0 ? '+' : ''}${bt.roi}%`);
          });
          await sendTelegram(lines.join('\n'));
        } catch(e) {
          await sendTelegram('❌ Error obteniendo resumen: ' + e.message);
        }
      }

      // /limpiar
      if (text === '/limpiar') {
        const count = notifiedMatchIds.size;
        notifiedMatchIds.clear();
        betsson.invalidateCache();
        await sendTelegram(`🧹 Cache limpiada. ${count} IDs borrados.`);
      }
    }
  } catch(e) { /* silenciar */ }
}


// ── CARGAR NOTIFICADOS DESDE DB AL ARRANCAR ──────────────────
async function loadNotifiedFromDB() {
  try {
    const response = await fetch(`${SERVER}/api/signals`);
    if (!response.ok) return;
    const signals = await response.json();
    signals.forEach(signal => {
      const baseMatchId = signal.match_id.replace('_goles', '');
      notifiedMatchIds.add(baseMatchId);
    });
    console.log(`[INIT] ✅ ${notifiedMatchIds.size} partidos cargados desde DB (no se repetirán)`);
  } catch(e) {
    console.error(`[INIT] ❌ Error cargando historial desde DB: ${e.message}`);
  }
}

// ── RESOLVER PENDIENTES AL ARRANCAR ───────────────────────────
async function resolvePendingOnStartup() {
  try {
    const response = await fetch(`${SERVER}/api/signals/pending`);
    if (!response.ok) return;
    const pendingSignals = await response.json();
    if (!pendingSignals.length) {
      console.log('[INIT] Sin señales pendientes para resolver al arrancar');
      return;
    }

    const now = Date.now();
    const vencidas = pendingSignals.filter(signal => {
      if (!signal.scheduled_at) return false;
      const scheduledTime = new Date(signal.scheduled_at).getTime();
      return now > scheduledTime + 15 * 60 * 1000;
    });

    if (!vencidas.length) {
      console.log('[INIT] Sin señales vencidas para resolver');
      return;
    }

    console.log(`[INIT] 🔍 Resolviendo ${vencidas.length} señal(es) vencida(s)...`);

    for (const signal of vencidas) {
      try {
        const signalScheduledTime = new Date(signal.scheduled_at).getTime();

        const tournamentsPages = await Promise.all([1, 2].map(page =>
          apiFetch(`${ESB}/participants/${signal.nick1}/tournaments?page=${page}`)
        ));
        const completedTournaments = tournamentsPages
          .flatMap(pageData => pageData.tournaments || [])
          .filter(t => t.status_id === 4)
          .slice(0, 4);

        let resolved = false;
        for (const tournament of completedTournaments) {
          const matches = await apiFetch(`${ESB}/tournaments/${tournament.id}/matches`);

          const match = matches.find(m => {
            const n1 = m.participant1?.nickname;
            const n2 = m.participant2?.nickname;
            const sameNicks = (n1 === signal.nick1 && n2 === signal.nick2) ||
                              (n1 === signal.nick2 && n2 === signal.nick1);
            if (!sameNicks) return false;
            if (m.date && signal.scheduled_at) {
              const matchTime = new Date(m.date).getTime();
              const diffMin = Math.abs(matchTime - signalScheduledTime) / 60000;
              if (diffMin > 180) return false;
            }
            return true;
          });

          if (!match || match.status_id !== 3) continue;

          const score1 = match.participant1?.score;
          const score2 = match.participant2?.score;
          if (score1 === null || score2 === null) continue;

          const totalGoals = score1 + score2;
          let betOutcome;
          if (signal.bet_type === 'ganador') {
            const favWon = (match.participant1?.nickname === signal.bet_on && score1 > score2) ||
                           (match.participant2?.nickname === signal.bet_on && score2 > score1);
            betOutcome = favWon ? 'win' : 'loss';
          } else {
            betOutcome = totalGoals > parseFloat(signal.goals_line) ? 'win' : 'loss';
          }

          await fetch(`${SERVER}/api/signals/${signal.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result: betOutcome, score1, score2, total_goals: totalGoals }),
          });

          const profitOrLoss = betOutcome === 'win'
            ? parseFloat(signal.amount) * (parseFloat(signal.odd) - 1)
            : -parseFloat(signal.amount);
          const resultEmoji = betOutcome === 'win' ? '✅' : '❌';
          const betTypeLabel = signal.bet_type === 'ganador' ? '🎯 Ganador' : '📊 Goles';
          const matchTime = signal.scheduled_at
            ? new Date(signal.scheduled_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
            : '—';

          await sendTelegram([
            `${resultEmoji} <b>RESULTADO — ${betTypeLabel}</b>`,
            ``,
            signal.home_team ? `🏟 <b>${signal.home_team} vs ${signal.away_team}</b>` : '',
            `👤 <b>${signal.nick1} vs ${signal.nick2}</b>  🕐 ${matchTime}`,
            `⚽ Marcador: <b>${score1} - ${score2}</b>${signal.bet_type === 'goles' ? ` (total ${totalGoals})` : ''}`,
            `🎯 Apostado a: ${signal.bet_on} @ ${signal.odd}`,
            `📊 <b>${betOutcome === 'win' ? 'GANÓ 🎉' : 'PERDIÓ 😞'}</b>`,
            signal.amount ? `💰 P&L: <b>${profitOrLoss >= 0 ? '+' : ''}$${profitOrLoss.toFixed(0)}</b>` : '',
          ].filter(Boolean).join('\n'));

          console.log(`[INIT] ${resultEmoji} ${signal.nick1} vs ${signal.nick2} | ${betOutcome} | ${score1}-${score2} | P&L: $${profitOrLoss.toFixed(0)}`);
          resolved = true;
          break;
        }

        if (!resolved) {
          console.log(`[INIT] ⏳ ${signal.nick1} vs ${signal.nick2} — sin resultado en ESB todavía`);
        }
      } catch(e) {
        console.error(`[INIT] ❌ señal ${signal.id}: ${e.message}`);
      }
    }
  } catch(e) {
    console.error(`[INIT] ❌ Error resolviendo pendientes al arrancar: ${e.message}`);
  }
}

// ── INICIO ────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('🤖 ESBScout Bot v3.0');
  console.log(`🎯 Ganador: diff≥${STRATEGY_GANADOR.diffMin}% wr≥${STRATEGY_GANADOR.wrMin}% forma≥${STRATEGY_GANADOR.formMin}%`);
  console.log(`📊 Goles:   over%≥${STRATEGY_GOLES.overMin}% edge≥${STRATEGY_GOLES.edgeMin}% stdDev≤${STRATEGY_GOLES.stdDevMax}`);
  console.log('════════════════════════════════════════════════');

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env');
    process.exit(1);
  }

  await sendTelegram([
    `🤖 <b>ESBScout Bot v3.0 iniciado</b>`,
    ``,
    `✅ Odds reales de Betsson integradas`,
    `🎯 Ganador: ALTA o MUY ALTA confianza`,
    `📊 Goles: línea real de Betsson + edge calculado`,
    ``,
    `Comandos: /analizar /odds /resumen /status /limpiar`,
  ].join('\n'));

  await loadNotifiedFromDB();
  await resolvePendingOnStartup();

  await scan();
  cron.schedule(SCAN_CRON, scan);
  cron.schedule(RESOLVE_CRON, resolveSignals);  // resolver resultados cada 5 min
  setInterval(pollCommands, 3000);
}

main();