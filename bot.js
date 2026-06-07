/**
 * ESBScout — Bot de Telegram v2.0
 * - Fix endpoint torneos: usa dateFrom/dateTo (endpoint real de ESB)
 * - Estrategia ganador: diff≥12%, wr≥50%, forma≥52%, edge≥3%
 * - Estrategia goles:   Over 5.5 con overMin≥60%, edge≥3%, stdDev≤25%
 * - Mensajes separados por tipo de apuesta
 *
 * Setup:
 *   1. npm install node-fetch node-cron dotenv
 *   2. Crear .env con TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
 *   3. node bot.js
 */

require('dotenv').config();
const fetch = require('node-fetch');
const cron  = require('node-cron');

// ── CONFIG ────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const ESB        = 'https://football.esportsbattle.com/api';
const SCAN_CRON  = '*/7 * * * *';  // cada 7 minutos
const TIMEOUT_MS = 15000;

// Parámetros óptimos validados en backtest — GANADOR
const STRATEGY_GANADOR = {
  diffMin:  12,
  wrMin:    50,
  formMin:  52,
  edgeMin:  3,
  simOdd:   1.85,
};

// Parámetros óptimos validados en backtest — GOLES (Over 5.5, ROI +51.6%)
const STRATEGY_GOLES = {
  line:      5.5,   // Over 5.5
  overMin:   60,    // media geométrica de Over% mínima
  edgeMin:   3,     // edge vs odd implícita
  stdDevMax: 25,    // variabilidad máxima aceptada
  sampleMin: 10,    // partidos mínimos para calcular Over%
  simOdd:    1.85,  // odd de referencia (ajustá si ESB da otra)
};

// IDs ya notificados (evita spam)
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
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const data = await r.json();
    if (!data.ok) console.error('[TG] ❌', data.description);
    else          console.log('[TG] ✅ Enviado');
  } catch(e) {
    console.error('[TG] ❌ Fetch error:', e.message);
  }
}

// ── OBTENER TORNEOS DEL DÍA (fix con dateFrom/dateTo) ─────────
function getTodayRange() {
  const now = new Date();

  // dateFrom: ahora mismo (no desde las 00:00 — ya terminaron esos)
  const from = new Date(now);

  // dateTo: dentro de 4 horas (ventana razonable para próximos torneos)
  const to = new Date(now);
  to.setHours(to.getHours() + 4);

  const fmt = d => {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const min  = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
  };

  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

async function getTodayMatches() {
  const { dateFrom, dateTo } = getTodayRange();
  const params = new URLSearchParams({ page: 1, dateFrom, dateTo });
  const url = `${ESB}/tournaments?${params}`;
  console.log(`[SCAN] 📅 Buscando torneos: ${dateFrom} → ${dateTo}`);

  try {
    const data = await apiFetch(url);
    const tournaments = data.tournaments || [];
    console.log(`[SCAN] 📋 Torneos encontrados: ${tournaments.length}`);

    // Traer matches de todos los torneos del día
    const allMatches = [];
    await Promise.allSettled(
      tournaments.slice(0, 30).map(async t => {
        try {
          const matches = await apiFetch(`${ESB}/tournaments/${t.id}/matches`);
          if (Array.isArray(matches)) allMatches.push(...matches);
        } catch(e) {}
      })
    );

    // Debug: ver qué status_id tienen los partidos
    const statusCounts = {};
    allMatches.forEach(m => {
      const s = m.status_id ?? 'null';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    console.log(`[SCAN] 📊 status_id breakdown:`, JSON.stringify(statusCounts));

    // Loguear muestra de los primeros 3 partidos para ver estructura real
    allMatches.slice(0, 3).forEach((m, i) => {
      console.log(`[SCAN] 🔎 Match[${i}]:`, JSON.stringify({
        id: m.id,
        status_id: m.status_id,
        date: m.date || m.scheduled_at,
        p1: m.participant1?.nickname,
        p2: m.participant2?.nickname,
        score1: m.participant1?.score,
        score2: m.participant2?.score,
      }));
    });

    // status_id=3 → finalizado en ESB. Pendiente = null scores O fecha futura
    const pending = allMatches.filter(m => {
      const n1 = m.participant1?.nickname;
      const n2 = m.participant2?.nickname;
      if (!n1 || !n2) return false;

      // Ya finalizado → skip
      if (m.status_id === 3 || m.status_id === 4) return false;

      // Score null en ambos → pendiente claro
      const s1 = m.participant1?.score;
      const s2 = m.participant2?.score;
      if (s1 === null && s2 === null) return true;

      // Tiene fecha futura → pendiente
      if (m.date) {
        const matchTime = new Date(m.date).getTime();
        if (matchTime > Date.now()) return true;
      }

      return false;
    });

    console.log(`[SCAN] 🎮 Partidos pendientes: ${pending.length} de ${allMatches.length} totales`);
    return pending;

  } catch(e) {
    console.error('[SCAN] ❌ Error obteniendo torneos:', e.message);
    return [];
  }
}

// ── FORMA RECIENTE (igual que index.html) ─────────────────────
async function getRecentForm(nickname) {
  try {
    const pages = await Promise.all([1, 2, 3, 4].map(p =>
      apiFetch(`${ESB}/participants/${nickname}/tournaments?page=${p}`)
    ));
    const tournaments = pages
      .flatMap(r => r.tournaments || [])
      .filter(t => t.status_id === 4)
      .slice(0, 6);

    if (!tournaments.length) return null;

    const matchData = await Promise.all(
      tournaments.map(t => apiFetch(`${ESB}/tournaments/${t.id}/matches`))
    );

    const allMatches = matchData.flat().filter(m =>
      m.participant1?.nickname === nickname ||
      m.participant2?.nickname === nickname
    );

    let wins = 0, losses = 0, draws = 0, gf = 0, ga = 0;
    const totals = [];
    allMatches.forEach(m => {
      const isP1 = m.participant1?.nickname === nickname;
      const hg = isP1 ? m.participant1.score : m.participant2.score;
      const og = isP1 ? m.participant2.score : m.participant1.score;
      if (hg > og) wins++;
      else if (hg < og) losses++;
      else draws++;
      gf += hg; ga += og;
      totals.push(hg + og);
    });

    const total = wins + losses + draws;
    const avgTot = total > 0 ? totals.reduce((a,b)=>a+b,0)/total : 0;
    const variance = total > 1
      ? totals.reduce((s,t)=>s+(t-avgTot)**2,0)/(total-1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const over = line => total > 0 ? totals.filter(t=>t>line).length/total*100 : 0;

    return {
      recentWinPct:   total > 0 ? (wins/total*100) : 0,
      recentMatches:  total,
      w: wins, d: draws, l: losses,
      avgGF:   total > 0 ? gf/total : 0,
      avgGA:   total > 0 ? ga/total : 0,
      avgTotal: avgTot,
      stdDev:  parseFloat(stdDev.toFixed(2)),
      over45:  parseFloat(over(4).toFixed(1)),
      over55:  parseFloat(over(5).toFixed(1)),
      over65:  parseFloat(over(6).toFixed(1)),
    };
  } catch(e) {
    return null;
  }
}

// ── ESTRATEGIA GANADOR ────────────────────────────────────────
function getConfidenceGanador(favWr, rivWr, favForm) {
  const { diffMin, wrMin, formMin, edgeMin, simOdd } = STRATEGY_GANADOR;
  const diff = favWr - rivWr;
  const impliedProb = 1 / simOdd * 100;
  const hasEdge = favWr >= impliedProb + edgeMin;

  if (diff < diffMin || favWr < wrMin || !hasEdge)
    return { pass: true };

  let confCls, pct;
  if      (diff < diffMin * 2)    { confCls = 'mhigh'; pct = 0.03; }
  else if (diff < diffMin * 3.33) { confCls = 'high';  pct = 0.05; }
  else                            { confCls = 'vhigh'; pct = 0.06; }

  if (favForm) {
    const formAlert = Math.abs(favForm.recentWinPct - favWr) > 15;
    if (formAlert) {
      if      (confCls === 'vhigh') { confCls = 'high';  pct = 0.05; }
      else if (confCls === 'high')  { confCls = 'mhigh'; pct = 0.04; }
      else return { pass: true };
    }
    if (favForm.recentWinPct < formMin) return { pass: true };
  }

  // Solo notificar ALTA o MUY ALTA
  if (confCls === 'mhigh') return { pass: true };

  const labels = { vhigh: '🟢🟢 MUY ALTA', high: '🟢 ALTA' };
  return {
    pass: false, confCls, pct,
    label: labels[confCls],
    diff, edge: favWr - impliedProb,
  };
}

// ── ESTRATEGIA GOLES ──────────────────────────────────────────
function getGoalsSignal(form1, form2) {
  const { line, overMin, edgeMin, stdDevMax, sampleMin, simOdd } = STRATEGY_GOLES;

  if (!form1 || !form2) return null;
  if (form1.recentMatches < sampleMin || form2.recentMatches < sampleMin) return null;

  const lineKey = line === 4.5 ? 'over45' : line === 5.5 ? 'over55' : 'over65';
  const o1 = form1[lineKey];
  const o2 = form2[lineKey];

  // Media geométrica
  const overGeo = Math.sqrt(o1 * o2);
  const stdDevPair = (form1.stdDev + form2.stdDev) / 2;
  const impliedProb = 1 / simOdd * 100;
  const edge = overGeo - impliedProb;

  if (overGeo < overMin)   return null;
  if (edge < edgeMin)      return null;
  if (stdDevPair > stdDevMax) return null;

  return {
    line,
    overGeo:    parseFloat(overGeo.toFixed(1)),
    o1, o2,
    stdDevPair: parseFloat(stdDevPair.toFixed(1)),
    edge:       parseFloat(edge.toFixed(1)),
  };
}

// ── ANALIZAR UN PAR ───────────────────────────────────────────
async function analyzePair(nick1, nick2, matchId, scheduledAt) {
  try {
    const compare = await apiFetch(`${ESB}/participants/${nick1}/compare/${nick2}`);
    if (!Array.isArray(compare) || compare.length < 2 || !compare[0] || !compare[1]) return null;

    const p1 = compare[0], p2 = compare[1];
    const wr1 = p1.totalMatches > 0 ? (p1.totalWin / p1.totalMatches * 100) : 0;
    const wr2 = p2.totalMatches > 0 ? (p2.totalWin / p2.totalMatches * 100) : 0;

    const isP1Fav = wr1 >= wr2;
    const favNick = isP1Fav ? nick1 : nick2;
    const rivNick = isP1Fav ? nick2 : nick1;
    const favWr   = isP1Fav ? wr1 : wr2;
    const rivWr   = isP1Fav ? wr2 : wr1;

    // Forma reciente de ambos (necesaria para ganador Y goles)
    const [favForm, rivForm] = await Promise.all([
      getRecentForm(favNick),
      getRecentForm(rivNick),
    ]);

    // Evaluar ambas estrategias
    const confGanador = getConfidenceGanador(favWr, rivWr, favForm);
    const goalsSignal = getGoalsSignal(favForm, rivForm);

    // Si ninguna estrategia recomienda, saltar
    if (confGanador.pass && !goalsSignal) return null;

    return {
      matchId, scheduledAt,
      nick1, nick2,
      favNick, rivNick,
      favWr, rivWr,
      favForm, rivForm,
      confGanador,
      goalsSignal,
    };

  } catch(e) {
    console.error(`[ANALYZE] ❌ ${nick1} vs ${nick2}: ${e.message}`);
    return null;
  }
}

// ── FORMATEAR MENSAJE ─────────────────────────────────────────
function formatMessage(result, bankroll) {
  const { nick1, nick2, favNick, rivNick, favWr, rivWr,
          favForm, confGanador, goalsSignal, scheduledAt } = result;

  const hora = scheduledAt
    ? new Date(scheduledAt).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', hour12:false })
    : '—';

  const lines = [];
  lines.push(`⚽ <b>${nick1} vs ${nick2}</b>  🕐 ${hora}`);
  lines.push('');

  // ── Bloque GANADOR ──
  if (!confGanador.pass) {
    const betAmt = bankroll && confGanador.pct > 0
      ? `$${Math.floor(bankroll * confGanador.pct).toLocaleString('es-AR')}`
      : `${(confGanador.pct * 100).toFixed(0)}% bankroll`;

    const formStr = favForm
      ? `${favForm.recentWinPct.toFixed(0)}% (${favForm.w}W/${favForm.d}D/${favForm.l}L)`
      : 'sin datos';

    lines.push(`🎯 <b>GANADOR — ${confGanador.label}</b>`);
    lines.push(`   Apostar a: <b>${favNick}</b>`);
    lines.push(`   Win% fav: ${favWr.toFixed(1)}%  |  riv: ${rivWr.toFixed(1)}%  |  diff: +${confGanador.diff.toFixed(1)}%`);
    lines.push(`   Edge vs 1.85: +${confGanador.edge.toFixed(1)}%`);
    lines.push(`   Forma reciente: ${formStr}`);
    lines.push(`   💰 Monto sugerido: <b>${betAmt}</b>`);
    lines.push('');
  }

  // ── Bloque GOLES ──
  if (goalsSignal) {
    const { line, overGeo, o1, o2, edge, stdDevPair } = goalsSignal;
    const betAmtG = bankroll
      ? `$${Math.floor(bankroll * 0.03).toLocaleString('es-AR')}`
      : '3% bankroll';

    lines.push(`⚽ <b>GOLES — Over ${line} recomendado</b>`);
    lines.push(`   Over% geo: <b>${overGeo.toFixed(1)}%</b>  (fav: ${o1.toFixed(0)}% · riv: ${o2.toFixed(0)}%)`);
    lines.push(`   Edge vs 1.85: +${edge.toFixed(1)}%`);
    lines.push(`   StdDev par: ${stdDevPair.toFixed(1)}`);
    lines.push(`   💰 Monto sugerido: <b>${betAmtG}</b>`);
    lines.push('');
  }

  lines.push(`⚠️ <i>Verificá las odds reales antes de apostar</i>`);
  return lines.join('\n');
}

// ── SCAN PRINCIPAL ────────────────────────────────────────────
async function scan() {
  console.log(`\n[SCAN] 🔍 ${new Date().toLocaleTimeString('es-AR')}`);

  try {
    const pendingMatches = await getTodayMatches();
    if (!pendingMatches.length) {
      console.log('[SCAN] Sin partidos pendientes.');
      return;
    }

    // Deduplicar por par de nicknames
    const seen = new Set();
    const uniqueMatches = [];
    pendingMatches.forEach(m => {
      const n1 = m.participant1?.nickname;
      const n2 = m.participant2?.nickname;
      if (!n1 || !n2) return;
      const key = [n1, n2].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const matchId = m.id || key;
      if (notifiedMatchIds.has(matchId)) return;
      uniqueMatches.push({
        matchId,
        nick1: n1,
        nick2: n2,
        scheduledAt: m.date || m.scheduled_at || null,
      });
    });

    console.log(`[SCAN] 🎮 Pares únicos a analizar: ${uniqueMatches.length}`);
    if (!uniqueMatches.length) return;

    // Obtener bankroll
    let bankroll = null;
    try {
      const br = await fetch('http://localhost:3000/api/bankroll').then(r => r.json());
      bankroll = br.bankroll;
    } catch(e) {}

    // Analizar de a 2 en paralelo
    const recommendations = [];
    for (let i = 0; i < uniqueMatches.length; i += 2) {
      const batch = uniqueMatches.slice(i, i + 2);
      const results = await Promise.allSettled(
        batch.map(m => analyzePair(m.nick1, m.nick2, m.matchId, m.scheduledAt))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) recommendations.push(r.value);
      });
    }

    console.log(`[SCAN] ✅ Recomendaciones: ${recommendations.length}`);

    // Enviar mensajes
    for (const rec of recommendations) {
      const msg = formatMessage(rec, bankroll);
      await sendTelegram(msg);
      notifiedMatchIds.add(rec.matchId);
      console.log(`[SCAN] 📩 ${rec.nick1} vs ${rec.nick2}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!recommendations.length) {
      console.log('[SCAN] Sin apuestas recomendadas en este ciclo.');
    }

  } catch(e) {
    console.error('[SCAN] ❌', e.message);
  }
}

// ── POLLING DE COMANDOS ───────────────────────────────────────
let lastUpdateId = 0;

async function pollCommands() {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const data = await fetch(url).then(r => r.json());
    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const text   = update.message?.text || '';
      const chatId = update.message?.chat?.id?.toString();
      if (chatId !== CHAT_ID) continue;

      // /analizar Nick1 vs Nick2
      if (text.startsWith('/analizar')) {
        const parts = text.replace('/analizar', '').trim().split(/\s+vs\s+/i);
        if (parts.length === 2) {
          const nick1 = parts[0].trim();
          const nick2 = parts[1].trim();
          await sendTelegram(`🔍 Analizando <b>${nick1} vs ${nick2}</b>...`);
          const result = await analyzePair(nick1, nick2, `manual-${nick1}-${nick2}`, null);
          if (result) {
            await sendTelegram(formatMessage(result, null));
          } else {
            await sendTelegram(
              `❌ <b>${nick1} vs ${nick2}</b>\n` +
              `No cumple ninguna estrategia.\n` +
              `Ganador: diff≥${STRATEGY_GANADOR.diffMin}%, wr≥${STRATEGY_GANADOR.wrMin}%, forma≥${STRATEGY_GANADOR.formMin}%\n` +
              `Goles: Over${STRATEGY_GOLES.line} con geo≥${STRATEGY_GOLES.overMin}%`
            );
          }
        } else {
          await sendTelegram('⚠️ Formato: <code>/analizar Nick1 vs Nick2</code>');
        }
      }

      // /status
      if (text === '/status') {
        let bankroll = null;
        try {
          const br = await fetch('http://localhost:3000/api/bankroll').then(r=>r.json());
          bankroll = br.bankroll;
        } catch(e) {}

        await sendTelegram([
          `📊 <b>ESBScout Bot v2.0 — Estado</b>`,
          ``,
          `✅ Bot activo · escaneo cada 7 min`,
          `📋 Partidos notificados: ${notifiedMatchIds.size}`,
          bankroll ? `💰 Bankroll actual: <b>$${bankroll.toLocaleString('es-AR')}</b>` : `💰 Bankroll: no disponible`,
          ``,
          `🎯 <b>Ganador:</b> diff≥${STRATEGY_GANADOR.diffMin}% · wr≥${STRATEGY_GANADOR.wrMin}% · forma≥${STRATEGY_GANADOR.formMin}% · edge≥${STRATEGY_GANADOR.edgeMin}%`,
          `⚽ <b>Goles:</b> Over ${STRATEGY_GOLES.line} · geo≥${STRATEGY_GOLES.overMin}% · edge≥${STRATEGY_GOLES.edgeMin}% · stdDev≤${STRATEGY_GOLES.stdDevMax}`,
        ].join('\n'));
      }

      // /limpiar
      if (text === '/limpiar') {
        const count = notifiedMatchIds.size;
        notifiedMatchIds.clear();
        await sendTelegram(`🧹 Cache limpiada. ${count} IDs borrados.`);
      }
    }
  } catch(e) {
    // silenciar
  }
}

// ── INICIO ────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('🤖 ESBScout Bot v2.0 iniciado');
  console.log(`🎯 Ganador: diff≥${STRATEGY_GANADOR.diffMin}% wr≥${STRATEGY_GANADOR.wrMin}% forma≥${STRATEGY_GANADOR.formMin}%`);
  console.log(`⚽ Goles:   Over${STRATEGY_GOLES.line} geo≥${STRATEGY_GOLES.overMin}% stdDev≤${STRATEGY_GOLES.stdDevMax}`);
  console.log('════════════════════════════════════════════════');

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el .env');
    process.exit(1);
  }

  await sendTelegram([
    `🤖 <b>ESBScout Bot v2.0 iniciado</b>`,
    ``,
    `Dos estrategias activas:`,
    `🎯 <b>Ganador</b> — confianza ALTA o MUY ALTA`,
    `⚽ <b>Goles</b>  — Over ${STRATEGY_GOLES.line} con geo≥${STRATEGY_GOLES.overMin}%`,
    ``,
    `Comandos:`,
    `  /analizar Nick1 vs Nick2`,
    `  /status`,
    `  /limpiar`,
  ].join('\n'));

  await scan();
  cron.schedule(SCAN_CRON, scan);
  setInterval(pollCommands, 3000);
}

main();