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

// ── CONFIG ────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const ESB        = 'https://football.esportsbattle.com/api';
const SCAN_CRON  = '*/7 * * * *';
const TIMEOUT_MS = 15000;

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
      .filter(t => t.status_id === 4)
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

// ── SCAN PRINCIPAL ────────────────────────────────────────────
async function scan() {
  console.log(`\n[SCAN] 🔍 ${new Date().toLocaleTimeString('es-AR')}`);

  try {
    // Invalidar cache de Betsson al inicio de cada scan
    betsson.invalidateCache();

    const pendingMatches = await getTodayMatches();
    if (!pendingMatches.length) {
      console.log('[SCAN] Sin partidos pendientes.');
      return;
    }

    // Deduplicar por par (orden insensible)
    const seen = new Set();
    const uniqueMatches = [];
    pendingMatches.forEach(m => {
      const n1 = m.participant1?.nickname;
      const n2 = m.participant2?.nickname;
      if (!n1 || !n2) return;
      const key = [n1,n2].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      const matchId = m.id || key;
      if (notifiedMatchIds.has(matchId)) return;
      uniqueMatches.push({
        matchId, nick1: n1, nick2: n2,
        scheduledAt: m.date || m.scheduled_at || null,
      });
    });

    console.log(`[SCAN] 🎮 Pares únicos a analizar: ${uniqueMatches.length}`);
    if (!uniqueMatches.length) return;

    // Bankroll actual
    let bankroll = null;
    try {
      const br = await fetch('http://localhost:3000/api/bankroll').then(r=>r.json());
      bankroll = br.bankroll;
    } catch(e) {}

    // Analizar de a 2 en paralelo
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
        try { const br = await fetch('http://localhost:3000/api/bankroll').then(r=>r.json()); bankroll = br.bankroll; } catch(e) {}
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
    `Comandos: /analizar /odds /status /limpiar`,
  ].join('\n'));

  await scan();
  cron.schedule(SCAN_CRON, scan);
  setInterval(pollCommands, 3000);
}

main();