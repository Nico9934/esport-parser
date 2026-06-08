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
const SCAN_CRON     = '*/7 * * * *';
const RESOLVE_CRON  = '*/5 * * * *';  // revisar resultados cada 5 min
const SERVER        = 'http://localhost:3000';
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
// Realiza un fetch con timeout y manejo de errores HTTP
async function apiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-store' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Envía un mensaje de texto a Telegram con formato HTML
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await response.json();
    if (!data.ok) console.error('[TG] ❌', data.description);
    else          console.log('[TG] ✅ Enviado');
  } catch(e) {
    console.error('[TG] ❌', e.message);
  }
}

// ── TORNEOS DEL DÍA ───────────────────────────────────────────
// Calcula el rango de fecha-hora: desde ahora hasta 4 horas en el futuro
// Retorna strings formateados para la API de ESB
function getTodayRange() {
  const currentTime = new Date();
  const endTime = new Date(currentTime);
  endTime.setHours(endTime.getHours() + 4);

  // Formatea una fecha en el formato YYYY/MM/DD HH:MM esperado por la API
  const formatDateTime = date => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}`;
  };

  return { dateFrom: formatDateTime(currentTime), dateTo: formatDateTime(endTime) };
}

// Obtiene todos los partidos pendientes en los próximos ~4 horas
// Filtra para que solo retorne partidos sin resultado final y con ambos participantes
async function getTodayMatches() {
  const { dateFrom, dateTo } = getTodayRange();
  console.log(`[SCAN] 📅 ${dateFrom} → ${dateTo}`);
  try {
    // Paso 1: Obtener lista de torneos en el rango de tiempo
    const params = new URLSearchParams({ page: 1, dateFrom, dateTo });
    const tournamentsData = await apiFetch(`${ESB}/tournaments?${params}`);
    const tournaments = tournamentsData.tournaments || [];
    console.log(`[SCAN] 📋 Torneos: ${tournaments.length}`);

    // Paso 2: Para cada torneo, obtener sus partidos (en paralelo, sin fallar si uno falla)
    const allMatches = [];
    await Promise.allSettled(
      tournaments.slice(0, 30).map(async tournament => {
        try {
          const matches = await apiFetch(`${ESB}/tournaments/${tournament.id}/matches`);
          if (Array.isArray(matches)) allMatches.push(...matches);
        } catch(e) {}
      })
    );

    // Paso 3: Análisis de estados para debugging
    const statusCounts = {};
    allMatches.forEach(match => {
      const statusId = match.status_id ?? 'null';
      statusCounts[statusId] = (statusCounts[statusId] || 0) + 1;
    });
    console.log(`[SCAN] 📊 status_id:`, JSON.stringify(statusCounts));

    // Paso 4: Filtrar partidos "pendientes" (sin resultado = sin score o fecha futura)
    // status_id: 1=pendiente, 2=en vivo, 3=completado, 4=cancelado
    const pendingMatches = allMatches.filter(match => {
      // Ambos participantes deben existir
      if (!match.participant1?.nickname || !match.participant2?.nickname) return false;
      // No incluir si ya está completado (status 3) o cancelado (status 4)
      if (match.status_id === 3 || match.status_id === 4) return false;
      // Incluir si no tiene resultado aún
      const score1 = match.participant1?.score;
      const score2 = match.participant2?.score;
      if (score1 === null && score2 === null) return true;
      // O incluir si la fecha es futura
      if (match.date && new Date(match.date).getTime() > Date.now()) return true;
      return false;
    });

    console.log(`[SCAN] 🎮 Pendientes: ${pendingMatches.length}/${allMatches.length}`);
    return pendingMatches;
  } catch(e) {
    console.error('[SCAN] ❌', e.message);
    return [];
  }
}

// ── FORMA RECIENTE ────────────────────────────────────────────
// Calcula estadísticas de los últimos 6 torneos completados de un jugador:
// - Win rate, W/D/L, goles a favor/en contra
// - Desviación estándar de goles totales
// - Porcentaje de partidos Over de diferentes líneas (4.5, 5.5, 6.5)
async function getRecentForm(nickname) {
  try {
    // Paso 1: Obtener torneos del jugador desde 4 páginas (en paralelo)
    const tournamentsPages = await Promise.all([1, 2, 3, 4].map(page =>
      apiFetch(`${ESB}/participants/${nickname}/tournaments?page=${page}`)
    ));

    // Paso 2: Filtrar solo torneos completados (status_id === 4), tomar últimos 6
    const completedTournaments = tournamentsPages
      .flatMap(pageData => pageData.tournaments || [])
      .filter(tournament => tournament.status_id === 4)
      .slice(0, 6);

    if (!completedTournaments.length) return null;

    // Paso 3: Para cada torneo, obtener los partidos
    const matchDataPerTournament = await Promise.all(
      completedTournaments.map(tournament => apiFetch(`${ESB}/tournaments/${tournament.id}/matches`))
    );

    // Paso 4: Filtrar solo los partidos que incluyen al jugador
    const playerMatches = matchDataPerTournament.flat().filter(match =>
      match.participant1?.nickname === nickname || match.participant2?.nickname === nickname
    );

    // Paso 5: Calcular estadísticas (W/L/D, goles, totales)
    let wins = 0, losses = 0, draws = 0;
    let goalsFor = 0, goalsAgainst = 0;
    const totalGoalsPerMatch = [];

    playerMatches.forEach(match => {
      const playerIsParticipant1 = match.participant1?.nickname === nickname;
      const playerGoals = playerIsParticipant1 ? match.participant1.score : match.participant2.score;
      const opponentGoals = playerIsParticipant1 ? match.participant2.score : match.participant1.score;

      // Resultado del partido
      if (playerGoals > opponentGoals) wins++;
      else if (playerGoals < opponentGoals) losses++;
      else draws++;

      // Goles en el partido
      goalsFor += playerGoals;
      goalsAgainst += opponentGoals;
      totalGoalsPerMatch.push(playerGoals + opponentGoals);
    });

    // Paso 6: Calcular métricas estadísticas
    const totalMatches = wins + losses + draws;
    const averageGoalsPerMatch = totalMatches > 0
      ? totalGoalsPerMatch.reduce((sum, goals) => sum + goals, 0) / totalMatches
      : 0;

    // Varianza y desviación estándar
    const variance = totalMatches > 1
      ? totalGoalsPerMatch.reduce((sum, goals) => sum + (goals - averageGoalsPerMatch) ** 2, 0) / (totalMatches - 1)
      : 0;
    const standardDeviation = Math.sqrt(variance);

    // Función para calcular porcentaje Over de una línea (ej: Over 4.5 = goles totales > 4)
    const calculateOverPercentage = line =>
      totalMatches > 0 ? totalGoalsPerMatch.filter(goals => goals > line).length / totalMatches * 100 : 0;

    return {
      recentWinPct: totalMatches > 0 ? (wins / totalMatches) * 100 : 0,
      recentMatches: totalMatches,
      w: wins, d: draws, l: losses,
      avgTotal: parseFloat(averageGoalsPerMatch.toFixed(1)),
      stdDev: parseFloat(standardDeviation.toFixed(2)),
      over45: parseFloat(calculateOverPercentage(4).toFixed(1)),
      over55: parseFloat(calculateOverPercentage(5).toFixed(1)),
      over65: parseFloat(calculateOverPercentage(6).toFixed(1)),
    };
  } catch(e) {
    return null;
  }
}

// ── ESTRATEGIA GANADOR ────────────────────────────────────────
// Valida si una apuesta ganador cumple los criterios y calcula confianza y tamaño de apuesta
// Criterios:
//   - diff (favWr - rivWr) >= diffMin
//   - favWr >= wrMin
//   - edge (real win% - odd implícita) >= edgeMin
//   - forma reciente >= formMin (si está disponible)
function getConfidenceGanador(favoriteWinRate, rivalWinRate, favoriteForm, favoriteNick, rivalNick, betssonOdds) {
  const { diffMin, wrMin, formMin, edgeMin, simOdd } = STRATEGY_GANADOR;
  const winRateDifference = favoriteWinRate - rivalWinRate;

  // Usa odd real de Betsson si existe, sino fallback a odd simulada
  const oddsForFavorite = betssonOdds?.winFav || simOdd;
  const impliedProbability = (1 / oddsForFavorite) * 100;
  const edgePercentage = favoriteWinRate - impliedProbability;

  // ── Validaciones: rechaza si no cumple criterios mínimos
  if (winRateDifference < diffMin) {
    console.log(`[CONF] ❌ ${favoriteNick} vs ${rivalNick}: diff=${winRateDifference.toFixed(1)}% < ${diffMin}%`);
    return { pass: true };
  }
  if (favoriteWinRate < wrMin) {
    console.log(`[CONF] ❌ ${favoriteNick} vs ${rivalNick}: favWr=${favoriteWinRate.toFixed(1)}% < ${wrMin}%`);
    return { pass: true };
  }
  if (edgePercentage < edgeMin) {
    console.log(`[CONF] ❌ ${favoriteNick} vs ${rivalNick}: edge=${edgePercentage.toFixed(1)}% < ${edgeMin}% (odd=${oddsForFavorite})`);
    return { pass: true };
  }

  // ── Asignar confianza inicial basada en el diferencial
  let confidenceLevel, betPercentage;
  if (winRateDifference < diffMin * 2) {
    confidenceLevel = 'mhigh';
    betPercentage = 0.03; // 3% del bankroll
  } else if (winRateDifference < diffMin * 3.33) {
    confidenceLevel = 'high';
    betPercentage = 0.05; // 5% del bankroll
  } else {
    confidenceLevel = 'vhigh';
    betPercentage = 0.06; // 6% del bankroll
  }

  // ── Ajustar por forma reciente si existe
  if (favoriteForm) {
    // Si la forma diverge mucho de la win rate histórica, bajamos confianza
    const formDivergence = Math.abs(favoriteForm.recentWinPct - favoriteWinRate);
    if (formDivergence > 15) {
      console.log(`[CONF] ⚠️ ${favoriteNick}: forma diverge (hist=${favoriteWinRate.toFixed(0)}% vs rec=${favoriteForm.recentWinPct.toFixed(0)}%)`);
      if (confidenceLevel === 'vhigh') {
        confidenceLevel = 'high';
        betPercentage = 0.05;
      } else if (confidenceLevel === 'high') {
        confidenceLevel = 'mhigh';
        betPercentage = 0.04;
      } else {
        return { pass: true };
      }
    }
    // Si la forma reciente es baja, rechazamos la apuesta
    if (favoriteForm.recentWinPct < formMin) {
      console.log(`[CONF] ❌ ${favoriteNick}: forma=${favoriteForm.recentWinPct.toFixed(1)}% < ${formMin}%`);
      return { pass: true };
    }
  } else {
    // Sin datos de forma reciente, bajamos confianza
    console.log(`[CONF] ⚠️ ${favoriteNick}: sin forma, bajando confianza`);
    if (confidenceLevel === 'vhigh') {
      confidenceLevel = 'high';
      betPercentage = 0.05;
    } else if (confidenceLevel === 'high') {
      confidenceLevel = 'mhigh';
      betPercentage = 0.03;
    } else {
      return { pass: true };
    }
  }

  // ── Media-alta confianza: skipeamos (muy baja probabilidad de ganancia)
  if (confidenceLevel === 'mhigh') {
    console.log(`[CONF] ⏭️ ${favoriteNick} vs ${rivalNick}: MEDIA-ALTA, skip`);
    return { pass: true };
  }

  // ── Apuesta válida: confianza ALTA o MUY ALTA
  console.log(`[CONF] ✅ ${favoriteNick} vs ${rivalNick}: ${confidenceLevel} diff=${winRateDifference.toFixed(1)}% edge=${edgePercentage.toFixed(1)}%`);
  const confidenceLabels = { vhigh: '🟢🟢 MUY ALTA', high: '🟢 ALTA' };
  return {
    pass: false,
    confCls: confidenceLevel,
    pct: betPercentage,
    label: confidenceLabels[confidenceLevel],
    diff: winRateDifference,
    edge: edgePercentage,
    oddUsed: oddsForFavorite
  };
}

// ── ESTRATEGIA GOLES ──────────────────────────────────────────
// Valida si una apuesta de goles (Over) cumple criterios y calcula edge
// Usa la línea REAL de Betsson (no asume 5.5)
// Criterios:
//   - Ambos jugadores con >=10 partidos recientes
//   - Over% geométrico (media de ambos) >= overMin
//   - edge >= edgeMin
//   - desviación estándar promedio <= stdDevMax
function getGoalsSignal(player1Form, player2Form, betssonOdds) {
  const { overMin, edgeMin, stdDevMax, sampleMin } = STRATEGY_GOLES;

  // Validaciones de datos disponibles
  if (!player1Form || !player2Form) return null;
  if (player1Form.recentMatches < sampleMin || player2Form.recentMatches < sampleMin) return null;

  // CRÍTICO: sin odds de Betsson no podemos calcular edge real
  if (!betssonOdds?.goalsLine || !betssonOdds?.oddOver) return null;

  const goalsLine = betssonOdds.goalsLine;
  const oddOverBetsson = betssonOdds.oddOver;

  // ── Seleccionar el Over% correcto según la línea de Betsson
  // Ej: si línea es 5.5, usamos over55 de cada jugador
  let player1OverPercentage, player2OverPercentage;
  if (goalsLine <= 4.5) {
    player1OverPercentage = player1Form.over45;
    player2OverPercentage = player2Form.over45;
  } else if (goalsLine <= 5.5) {
    player1OverPercentage = player1Form.over55;
    player2OverPercentage = player2Form.over55;
  } else {
    player1OverPercentage = player1Form.over65;
    player2OverPercentage = player2Form.over65;
  }

  // ── Calcular métricas
  // Media geométrica: raíz cuadrada del producto (mejor para probabilidades)
  const overPercentageGeometric = Math.sqrt(player1OverPercentage * player2OverPercentage);
  const averageStdDev = (player1Form.stdDev + player2Form.stdDev) / 2;
  const impliedProbabilityBetsson = (1 / oddOverBetsson) * 100;
  const edgeCalculated = overPercentageGeometric - impliedProbabilityBetsson;

  // ── Validaciones: rechaza si no cumple criterios
  if (overPercentageGeometric < overMin) return null;
  if (edgeCalculated < edgeMin) return null;
  if (averageStdDev > stdDevMax) return null;

  // ── Apuesta válida
  return {
    line: goalsLine,
    overGeo: parseFloat(overPercentageGeometric.toFixed(1)),
    o1: player1OverPercentage,
    o2: player2OverPercentage,
    stdDevPair: parseFloat(averageStdDev.toFixed(1)),
    edge: parseFloat(edgeCalculated.toFixed(1)),
    oddOver: oddOverBetsson,
    oddUnder: betssonOdds.oddUnder,
  };
}

// ── ANALIZAR UN PAR ───────────────────────────────────────────
// Análisis completo de un partido: compara historiales, obtiene forma reciente
// y odds de Betsson, luego valida ambas estrategias (ganador y goles)
async function analyzePair(nick1, nick2, matchId, scheduledAt) {
  try {
    // Paso 1: Comparar historiales (win rates generales)
    const compareData = await apiFetch(`${ESB}/participants/${nick1}/compare/${nick2}`);
    if (!Array.isArray(compareData) || compareData.length < 2 || !compareData[0] || !compareData[1]) return null;

    const player1Data = compareData[0];
    const player2Data = compareData[1];
    const player1WinRate = player1Data.totalMatches > 0 ? (player1Data.totalWin / player1Data.totalMatches) * 100 : 0;
    const player2WinRate = player2Data.totalMatches > 0 ? (player2Data.totalWin / player2Data.totalMatches) * 100 : 0;

    // Identificar favorito (el con mayor win rate)
    const isNick1Favorite = player1WinRate >= player2WinRate;
    const favoriteNick = isNick1Favorite ? nick1 : nick2;
    const rivalNick = isNick1Favorite ? nick2 : nick1;
    const favoriteWinRate = isNick1Favorite ? player1WinRate : player2WinRate;
    const rivalWinRate = isNick1Favorite ? player2WinRate : player1WinRate;

    console.log(`[ANALYZE] ${nick1}(${player1WinRate.toFixed(1)}%) vs ${nick2}(${player2WinRate.toFixed(1)}%)`);

    // Paso 2: Obtener forma reciente y odds de Betsson en paralelo
    const [favoriteRecentForm, rivalRecentForm, betssonOddsRaw] = await Promise.all([
      getRecentForm(favoriteNick),
      getRecentForm(rivalNick),
      betsson.getMatchOdds(nick1, nick2),
    ]);

    // Paso 3: Normalizar odds de Betsson desde perspectiva del favorito
    let normalizedBetssonOdds = null;
    if (betssonOddsRaw) {
      // Si el favorito es nick1, las odds están en perspectiva correcta
      // Si favorito es nick2, necesitamos invertir
      const favoriteIsNick1 = favoriteNick.toLowerCase() === nick1.toLowerCase();
      normalizedBetssonOdds = {
        homeTeam: betssonOddsRaw.homeTeam,
        awayTeam: betssonOddsRaw.awayTeam,
        homeNick: betssonOddsRaw.homeNick,
        awayNick: betssonOddsRaw.awayNick,
        winFav: favoriteIsNick1 ? betssonOddsRaw.winNick1 : betssonOddsRaw.winNick2,
        winRiv: favoriteIsNick1 ? betssonOddsRaw.winNick2 : betssonOddsRaw.winNick1,
        winDraw: betssonOddsRaw.winDraw,
        goalsLine: betssonOddsRaw.goalsLine,
        oddOver: betssonOddsRaw.oddOver,
        oddUnder: betssonOddsRaw.oddUnder,
        url: betssonOddsRaw.url,
      };
    }

    // Paso 4: Evaluar ambas estrategias
    const ganadorConfidence = getConfidenceGanador(
      favoriteWinRate, rivalWinRate, favoriteRecentForm, favoriteNick, rivalNick, normalizedBetssonOdds
    );
    const goalsSignal = getGoalsSignal(favoriteRecentForm, rivalRecentForm, normalizedBetssonOdds);

    // Si ambas estrategias fallan, no hay apuesta recomendada
    if (ganadorConfidence.pass && !goalsSignal) return null;

    return {
      matchId, scheduledAt,
      nick1, nick2, favNick: favoriteNick, rivNick: rivalNick,
      favWr: favoriteWinRate, rivWr: rivalWinRate,
      favForm: favoriteRecentForm, rivForm: rivalRecentForm,
      confGanador: ganadorConfidence,
      goalsSignal,
      betssonOdds: normalizedBetssonOdds,
    };
  } catch(e) {
    console.error(`[ANALYZE] ❌ ${nick1} vs ${nick2}: ${e.message}`);
    return null;
  }
}

// ── FORMATEAR MENSAJE ─────────────────────────────────────────
// Formatea un análisis en mensaje HTML para Telegram
// Incluye ambas estrategias (ganador y goles) si pasan validación
function formatMessage(analysisResult, bankroll) {
  const { nick1, nick2, favNick, rivNick, favWr, rivWr,
    favForm, rivForm, confGanador, goalsSignal,
    betssonOdds, scheduledAt } = analysisResult;

  // Hora del partido (formato HH:MM)
  const matchTime = scheduledAt
    ? new Date(scheduledAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';

  const messageLines = [];

  // ── Cabecera: nombres de equipos (si existen en Betsson) y jugadores
  if (betssonOdds?.homeTeam && betssonOdds?.awayTeam) {
    messageLines.push(`🏟 <b>${betssonOdds.homeTeam} vs ${betssonOdds.awayTeam}</b>`);
  }
  messageLines.push(`👤 <b>${nick1} vs ${nick2}</b>  🕐 ${matchTime}`);
  messageLines.push('');

  // ── Sección GANADOR (si pasa validación)
  if (!confGanador.pass) {
    // Calcular monto de la apuesta
    const suggestedBetAmount = bankroll && confGanador.pct > 0
      ? `$${Math.floor(bankroll * confGanador.pct).toLocaleString('es-AR')}`
      : `${(confGanador.pct * 100).toFixed(0)}% bankroll`;

    // Forma reciente del favorito
    const recentFormString = favForm
      ? `${favForm.recentWinPct.toFixed(0)}% (${favForm.w}W/${favForm.d}D/${favForm.l}L · ${favForm.recentMatches}p)`
      : 'sin datos';

    // Odds: si Betsson tiene, mostrar; sino aviso
    const oddsForFavorite = betssonOdds?.winFav ? betssonOdds.winFav.toFixed(2) : '—';
    const oddsForRival = betssonOdds?.winRiv ? betssonOdds.winRiv.toFixed(2) : '—';
    const oddsForDraw = betssonOdds?.winDraw ? betssonOdds.winDraw.toFixed(2) : '—';
    const oddsDisplayLine = betssonOdds
      ? `Fav: <b>${oddsForFavorite}</b>  ·  Riv: ${oddsForRival}  ·  Empate: ${oddsForDraw}`
      : `Odds Betsson: no disponible (usando estimada)`;

    messageLines.push(`🎯 <b>GANADOR — ${confGanador.label}</b>`);
    messageLines.push(`   Apostar a: <b>${favNick}</b>`);
    messageLines.push(`   Win%: fav ${favWr.toFixed(1)}%  ·  riv ${rivWr.toFixed(1)}%  ·  diff +${confGanador.diff.toFixed(1)}%`);
    messageLines.push(`   ${oddsDisplayLine}`);
    messageLines.push(`   Edge real: <b>+${confGanador.edge.toFixed(1)}%</b>`);
    messageLines.push(`   Forma reciente: ${recentFormString}`);
    messageLines.push(`   💰 Sugerido: <b>${suggestedBetAmount}</b>`);
    messageLines.push('');
  }

  // ── Sección GOLES (si pasa validación)
  if (goalsSignal) {
    const { line, overGeo, o1, o2, edge, stdDevPair, oddOver, oddUnder } = goalsSignal;

    // Monto sugerido para goles (fijo 3% bankroll)
    const suggestedGoalsBet = bankroll
      ? `$${Math.floor(bankroll * 0.03).toLocaleString('es-AR')}`
      : '3% bankroll';

    // Promedio de goles de la pareja
    const averageGoalsPerMatch = (favForm && rivForm)
      ? ((favForm.avgTotal + rivForm.avgTotal) / 2).toFixed(1)
      : '—';

    // Odds para Over/Under
    const oddOverString = oddOver ? oddOver.toFixed(2) : '—';
    const oddUnderString = oddUnder ? oddUnder.toFixed(2) : '—';

    messageLines.push(`📊 <b>GOLES — Over ${line}</b>`);
    messageLines.push(`   Over% geo: <b>${overGeo.toFixed(1)}%</b>  (${favNick}: ${o1.toFixed(0)}% · ${rivNick}: ${o2.toFixed(0)}%)`);
    messageLines.push(`   Promedio goles del par: ${averageGoalsPerMatch}`);
    messageLines.push(`   Betsson: Over <b>${oddOverString}</b>  ·  Under ${oddUnderString}`);
    messageLines.push(`   Edge real: <b>+${edge.toFixed(1)}%</b>  ·  StdDev: ${stdDevPair.toFixed(1)}`);
    messageLines.push(`   💰 Sugerido: <b>${suggestedGoalsBet}</b>`);
    messageLines.push('');
  }

  // ── Pie: link a Betsson para completar la apuesta
  if (betssonOdds?.url) {
    messageLines.push(`🔗 <a href="${betssonOdds.url}">Ver en Betsson</a>`);
  } else {
    messageLines.push(`⚠️ <i>Partido no encontrado en Betsson — buscá: ${nick1} vs ${nick2}</i>`);
  }

  return messageLines.join('\n');
}

// ── GUARDAR SEÑAL EN DB ───────────────────────────────────────
// Guarda las apuestas recomendadas en la base de datos para seguimiento posterior
// Una apuesta por tipo (ganador, goles) si pasan validación
async function saveSignal(analysisResult, bankroll) {
  const { nick1, nick2, favNick, rivNick, favWr, rivWr,
    confGanador, goalsSignal, betssonOdds, scheduledAt } = analysisResult;
  try {
    const signals = [];

    // Guardar apuesta GANADOR si pasó validación
    if (!confGanador.pass) {
      signals.push({
        match_id: analysisResult.matchId,
        nick1, nick2,
        home_team: betssonOdds?.homeTeam || null,
        away_team: betssonOdds?.awayTeam || null,
        bet_type: 'ganador',
        bet_on: favNick,
        odd: betssonOdds?.winFav || STRATEGY_GANADOR.simOdd,
        amount: bankroll ? Math.floor(bankroll * confGanador.pct) : null,
        confidence: confGanador.confCls,
        fav_wr: favWr,
        riv_wr: rivWr,
        diff: confGanador.diff,
        edge: confGanador.edge,
        scheduled_at: scheduledAt,
      });
    }

    // Guardar apuesta GOLES si pasó validación
    if (goalsSignal) {
      signals.push({
        match_id: analysisResult.matchId + '_goles',
        esb_tournament_id: analysisResult.matchId,
        nick1, nick2,
        home_team: betssonOdds?.homeTeam || null,
        away_team: betssonOdds?.awayTeam || null,
        bet_type: 'goles',
        bet_on: `over ${goalsSignal.line}`,
        odd: goalsSignal.oddOver,
        amount: bankroll ? Math.floor(bankroll * 0.03) : null,
        confidence: 'signal',
        fav_wr: favWr,
        riv_wr: rivWr,
        diff: favWr - rivWr,
        edge: goalsSignal.edge,
        over_pct: goalsSignal.overGeo,
        goals_line: goalsSignal.line,
        scheduled_at: scheduledAt,
      });
    }

    // Enviar cada señal al servidor
    for (const signal of signals) {
      await fetch(`${SERVER}/api/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal),
      });
    }
    console.log(`[SIGNALS] ✅ ${signals.length} señal(es) guardada(s): ${nick1} vs ${nick2}`);
  } catch(e) {
    console.error(`[SIGNALS] ❌ ${e.message}`);
  }
}

// ── RESOLVER SEÑALES PENDIENTES ───────────────────────────────
// Busca los resultados de apuestas que aún no están resueltas
// Cuando encuentra el partido completado, calcula W/L y notifica por Telegram
async function resolveSignals() {
  try {
    // Paso 1: Obtener todas las señales pendientes de la DB
    const response = await fetch(`${SERVER}/api/signals/pending`);
    if (!response.ok) return;
    const pendingSignals = await response.json();
    if (!pendingSignals.length) return;
    console.log(`[RESOLVE] 🔍 ${pendingSignals.length} señal(es) pendiente(s)`);

    // Paso 2: Para cada señal pendiente, intentar encontrar y resolver
    for (const signal of pendingSignals) {
      try {
        // Obtener torneos recientes del primer jugador
        const tournamentsPages = await Promise.all([1, 2].map(page =>
          apiFetch(`${ESB}/participants/${signal.nick1}/tournaments?page=${page}`)
        ));
        const completedTournaments = tournamentsPages
          .flatMap(pageData => pageData.tournaments || [])
          .filter(tournament => tournament.status_id === 4)
          .slice(0, 4);

        // Referencia temporal: la hora que se registró la apuesta
        const signalScheduledTime = new Date(signal.scheduled_at).getTime();

        let signalResolved = false;
        for (const tournament of completedTournaments) {
          // Obtener partidos del torneo
          const tournamentMatches = await apiFetch(`${ESB}/tournaments/${tournament.id}/matches`);

          // Buscar el partido con los mismos jugadores Y fecha cercana (±20 min)
          const completedMatch = tournamentMatches.find(match => {
            const participant1Nickname = match.participant1?.nickname;
            const participant2Nickname = match.participant2?.nickname;
            // Verificar que sea el mismo partido (dos nicknames, sin importar orden)
            const sameParticipants = (participant1Nickname === signal.nick1 && participant2Nickname === signal.nick2) ||
              (participant1Nickname === signal.nick2 && participant2Nickname === signal.nick1);
            if (!sameParticipants) return false;

            // Verificar que la fecha sea cercana a la programada (tolerance: ±20 min)
            if (match.date && signal.scheduled_at) {
              const matchScheduledTime = new Date(match.date).getTime();
              const timeDifferenceMinutes = Math.abs(matchScheduledTime - signalScheduledTime) / 60000;
              if (timeDifferenceMinutes > 20) {
                console.log(`[RESOLVE] ⏭️ ${participant1Nickname} vs ${participant2Nickname} descartado — diff tiempo: ${timeDifferenceMinutes.toFixed(0)} min`);
                return false;
              }
            }
            return true;
          });

          // No encontró, o el partido no está completado
          if (!completedMatch || completedMatch.status_id !== 3) continue;

          // Extraer scores
          const score1 = completedMatch.participant1?.score;
          const score2 = completedMatch.participant2?.score;
          if (score1 === null || score2 === null) continue;

          // Paso 3: Determinar W/L según tipo de apuesta
          const totalGoals = score1 + score2;
          let betOutcome;

          if (signal.bet_type === 'ganador') {
            // ¿Ganó el jugador apostado?
            const bettedPlayerNick = signal.bet_on;
            const bettedPlayerWon = (completedMatch.participant1?.nickname === bettedPlayerNick && score1 > score2) ||
              (completedMatch.participant2?.nickname === bettedPlayerNick && score2 > score1);
            betOutcome = bettedPlayerWon ? 'win' : 'loss';
          } else {
            // goles: ¿superó la línea?
            betOutcome = totalGoals > parseFloat(signal.goals_line) ? 'win' : 'loss';
          }

          // Paso 4: Actualizar señal en DB
          await fetch(`${SERVER}/api/signals/${signal.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              result: betOutcome,
              score1,
              score2,
              total_goals: totalGoals
            }),
          });

          // Paso 5: Calcular ganancia/pérdida y notificar
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

          console.log(`[RESOLVE] ${resultEmoji} ${signal.nick1} vs ${signal.nick2} | ${signal.bet_type} | ${betOutcome} | ${score1}-${score2} | P&L: $${profitOrLoss.toFixed(0)}`);
          signalResolved = true;
          break;
        }
        if (!signalResolved) {
          console.log(`[RESOLVE] ⏳ ${signal.nick1} vs ${signal.nick2} — sin resultado aún`);
        }
      } catch(e) {
        console.error(`[RESOLVE] ❌ señal ${signal.id}: ${e.message}`);
      }
    }
  } catch(e) {
    console.error(`[RESOLVE] ❌ Error general: ${e.message}`);
  }
}

// ── HELPERS BETSSON ───────────────────────────────────────────
// Extrae el nickname del label "Team Name (nick)" → "nick"
const extractNick = label => {
  const match = label?.match(/\(([^)]+)\)/);
  return match ? match[1].trim() : null;
};
// Extrae el nombre del equipo del label "Team Name (nick)" → "Team Name"
const extractTeam = label => label?.replace(/\s*\([^)]+\)\s*$/, '').trim() || '';

// ── SCAN PRINCIPAL ────────────────────────────────────────────
// Función principal del bot: busca eventos en Betsson, analiza, recomienda y guarda apuestas
// Se ejecuta cada 7 minutos (configurado en SCAN_CRON)
async function scan() {
  console.log(`\n[SCAN] 🔍 ${new Date().toLocaleTimeString('es-AR')}`);

  try {
    // Paso 1: Obtener eventos de Betsson (limpiar cache primero)
    betsson.invalidateCache();
    const betssonEvents = await betsson.fetchEvents();

    if (!betssonEvents.length) {
      console.log('[SCAN] Sin eventos en Betsson por ahora.');
      return;
    }
    console.log(`[SCAN] 🎰 Betsson: ${betssonEvents.length} eventos disponibles`);

    // Paso 2: Extraer pares de nicknames de los eventos de Betsson
    // Filtrar los que ya fueron notificados
    const matchesToAnalyze = [];
    betssonEvents.forEach(event => {
      const participant0 = event.participants?.[0];
      const participant1 = event.participants?.[1];
      if (!participant0 || !participant1) return;
      const nick1 = extractNick(participant0.label);
      const nick2 = extractNick(participant1.label);
      if (!nick1 || !nick2) return;
      const eventId = event.id;
      // No re-analizar si ya lo notificamos
      if (notifiedMatchIds.has(eventId)) return;
      matchesToAnalyze.push({
        matchId: eventId,
        nick1,
        nick2,
        scheduledAt: event.startDate,
      });
    });

    console.log(`[SCAN] 🎮 Pares a analizar: ${matchesToAnalyze.length}`);
    if (!matchesToAnalyze.length) return;

    // Paso 3: Obtener bankroll actual para calcular tamaños de apuesta
    let bankroll = null;
    try {
      const bankrollResponse = await fetch('http://localhost:3000/api/bankroll').then(r => r.json());
      bankroll = bankrollResponse.bankroll;
    } catch(e) {}

    // Paso 4: Analizar los partidos de a 2 en paralelo (para no saturar API)
    const recommendedBets = [];
    for (let i = 0; i < matchesToAnalyze.length; i += 2) {
      const batch = matchesToAnalyze.slice(i, i + 2);
      const analysisResults = await Promise.allSettled(
        batch.map(match => analyzePair(match.nick1, match.nick2, match.matchId, match.scheduledAt))
      );
      analysisResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          recommendedBets.push(result.value);
        }
      });
    }

    console.log(`[SCAN] ✅ Recomendaciones: ${recommendedBets.length}`);

    // Paso 5: Para cada apuesta recomendada: notificar Telegram, guardar en DB, marcar como notificada
    for (const betRecommendation of recommendedBets) {
      const formattedMessage = formatMessage(betRecommendation, bankroll);
      await sendTelegram(formattedMessage);
      await saveSignal(betRecommendation, bankroll);
      notifiedMatchIds.add(betRecommendation.matchId);
      console.log(`[SCAN] 📩 ${betRecommendation.nick1} vs ${betRecommendation.nick2}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!recommendedBets.length) console.log('[SCAN] Sin apuestas recomendadas.');

  } catch(e) {
    console.error('[SCAN] ❌', e.message);
  }
}

// ── POLLING DE COMANDOS ───────────────────────────────────────
// Escucha comandos que envía el usuario por Telegram y los ejecuta
// Se ejecuta cada 3 segundos de forma continua
let lastUpdateId = 0;

async function pollCommands() {
  try {
    // Obtener nuevos mensajes (offset = último ID + 1 para no repetir)
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const responseData = await fetch(url).then(r => r.json());
    if (!responseData.ok || !responseData.result.length) return;

    for (const update of responseData.result) {
      lastUpdateId = update.update_id;
      const messageText = update.message?.text || '';
      const messageChatId = update.message?.chat?.id?.toString();
      // Solo procesar mensajes del chat configurado
      if (messageChatId !== CHAT_ID) continue;

      // ── COMANDO: /analizar Nick1 vs Nick2
      // Analiza un partido específico a demanda
      if (messageText.startsWith('/analizar')) {
        const playerNames = messageText.replace('/analizar', '').trim().split(/\s+vs\s+/i);
        if (playerNames.length === 2) {
          const player1Nick = playerNames[0].trim();
          const player2Nick = playerNames[1].trim();
          await sendTelegram(`🔍 Analizando <b>${player1Nick} vs ${player2Nick}</b>...`);
          const analysisResult = await analyzePair(player1Nick, player2Nick, `manual-${player1Nick}-${player2Nick}`, null);
          if (analysisResult) {
            await sendTelegram(formatMessage(analysisResult, null));
          } else {
            await sendTelegram(
              `❌ <b>${player1Nick} vs ${player2Nick}</b> no cumple ninguna estrategia.\n` +
              `Ganador: diff≥${STRATEGY_GANADOR.diffMin}%, wr≥${STRATEGY_GANADOR.wrMin}%, forma≥${STRATEGY_GANADOR.formMin}%\n` +
              `Goles: over%≥${STRATEGY_GOLES.overMin}%, edge≥${STRATEGY_GOLES.edgeMin}%`
            );
          }
        } else {
          await sendTelegram('⚠️ Formato: <code>/analizar Nick1 vs Nick2</code>');
        }
      }

      // ── COMANDO: /odds
      // Imprime la tabla de odds actual de Betsson en la consola
      if (messageText === '/odds') {
        await sendTelegram('🔍 Consultando Betsson...');
        await betsson.debugPrintAll();
        await sendTelegram('✅ Tabla de odds impresa en consola del servidor.');
      }

      // ── COMANDO: /status
      // Muestra estado actual del bot: eventos activos, estrategias, bankroll
      if (messageText === '/status') {
        let currentBankroll = null;
        try {
          const bankrollResponse = await fetch('http://localhost:3000/api/bankroll').then(r => r.json());
          currentBankroll = bankrollResponse.bankroll;
        } catch(e) {}
        await sendTelegram([
          `📊 <b>ESBScout Bot v3.0</b>`,
          ``,
          `✅ Activo · escaneo cada 7 min`,
          `📋 Partidos notificados: ${notifiedMatchIds.size}`,
          currentBankroll ? `💰 Bankroll: <b>$${currentBankroll.toLocaleString('es-AR')}</b>` : `💰 Bankroll: no disponible`,
          ``,
          `🎯 Ganador: diff≥${STRATEGY_GANADOR.diffMin}% · wr≥${STRATEGY_GANADOR.wrMin}% · forma≥${STRATEGY_GANADOR.formMin}%`,
          `📊 Goles: over%≥${STRATEGY_GOLES.overMin}% · edge≥${STRATEGY_GOLES.edgeMin}% · stdDev≤${STRATEGY_GOLES.stdDevMax}`,
          ``,
          `Comandos: /analizar /odds /limpiar /status`,
        ].join('\n'));
      }

      // ── COMANDO: /resumen
      // Muestra performance de todas las apuestas: W/L, ROI, profit
      if (messageText === '/resumen') {
        try {
          const summaryResponse = await fetch(`${SERVER}/api/signals/summary`);
          const summaryData = await summaryResponse.json();
          const summaryTotals = summaryData.totals;
          const summaryLines = [
            `📊 <b>ESBScout Bot — Performance</b>`,
            ``,
            `📈 Total señales: ${summaryTotals.total}  ·  Pendientes: ${summaryTotals.pending}`,
            `✅ Wins: ${summaryTotals.wins}  ·  ❌ Losses: ${summaryTotals.losses}`,
            `🎯 Win rate: <b>${summaryTotals.win_rate ?? '—'}%</b>`,
            `💰 Profit total: <b>${summaryTotals.total_profit >= 0 ? '+' : ''}$${summaryTotals.total_profit}</b>`,
            `📊 ROI: <b>${summaryTotals.roi >= 0 ? '+' : ''}${summaryTotals.roi ?? '—'}%</b>`,
            ``,
          ];
          summaryData.by_type.forEach(betTypeStats => {
            summaryLines.push(
              `<b>${betTypeStats.bet_type.toUpperCase()}</b>: ${betTypeStats.wins}W/${betTypeStats.losses}L · WR ${betTypeStats.win_rate}% · ROI ${betTypeStats.roi >= 0 ? '+' : ''}${betTypeStats.roi}%`
            );
          });
          await sendTelegram(summaryLines.join('\n'));
        } catch(e) {
          await sendTelegram('❌ Error obteniendo resumen: ' + e.message);
        }
      }

      // ── COMANDO: /limpiar
      // Borra el cache de Betsson y el historial de matches notificados (reinicia búsqueda)
      if (messageText === '/limpiar') {
        const countCleared = notifiedMatchIds.size;
        notifiedMatchIds.clear();
        betsson.invalidateCache();
        await sendTelegram(`🧹 Cache limpiada. ${countCleared} IDs borrados.`);
      }
    }
  } catch(e) {
    // Silenciar errores en polling para no spamear consola
  }
}

// ── INICIO ────────────────────────────────────────────────────
// Punto de entrada: valida configuración, inicia jobs cron y polling de comandos
async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('🤖 ESBScout Bot v3.0');
  console.log(`🎯 Ganador: diff≥${STRATEGY_GANADOR.diffMin}% wr≥${STRATEGY_GANADOR.wrMin}% forma≥${STRATEGY_GANADOR.formMin}%`);
  console.log(`📊 Goles:   over%≥${STRATEGY_GOLES.overMin}% edge≥${STRATEGY_GOLES.edgeMin}% stdDev≤${STRATEGY_GOLES.stdDevMax}`);
  console.log('════════════════════════════════════════════════');

  // Validar que existan las credenciales de Telegram
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env');
    process.exit(1);
  }

  // Notificar que el bot ha iniciado
  await sendTelegram([
    `🤖 <b>ESBScout Bot v3.0 iniciado</b>`,
    ``,
    `✅ Odds reales de Betsson integradas`,
    `🎯 Ganador: ALTA o MUY ALTA confianza`,
    `📊 Goles: línea real de Betsson + edge calculado`,
    ``,
    `Comandos: /analizar /odds /resumen /status /limpiar`,
  ].join('\n'));

  // Ejecutar primer scan inmediatamente
  await scan();

  // Job 1: Scan de eventos cada 7 minutos (buscar nuevas apuestas)
  cron.schedule(SCAN_CRON, scan);

  // Job 2: Resolver signals cada 5 minutos (verificar resultados de apuestas pasadas)
  cron.schedule(RESOLVE_CRON, resolveSignals);

  // Job 3: Polling de comandos cada 3 segundos (escuchar input de usuario)
  setInterval(pollCommands, 3000);
}

main();