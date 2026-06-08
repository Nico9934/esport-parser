const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── LOGS FILE ──
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// IMPORTANTE: Las rutas API deben estar ANTES del static middleware
// Sino, express.static intenta servir archivos antes de que las rutas se ejecuten

const pool = new Pool({
  host: 'localhost',
  database: 'esbscout',
  user: 'scout',
  password: 'scout123',
  port: 5432,
});

// ── PROXY ─────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { url } = req.query;
  console.log(`[PROXY] GET ${url?.substring(0, 100)}...`);
  if (!url) {
    console.error('[PROXY] ❌ Missing url');
    return res.status(400).json({ error: 'Missing url' });
  }
  try {
    const decodedUrl = decodeURIComponent(url);
    console.log(`[PROXY] → Fetching: ${decodedUrl.substring(0, 80)}...`);
    const r = await fetch(decodedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await r.text();
    console.log(`[PROXY] ✅ Response OK (${data.length} bytes, status ${r.status})`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(data);
  } catch(e) {
    console.error(`[PROXY] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── LOGS API ──────────────────────────────────────────────────
// Helper para obtener la ruta del log file actual
// type: 'backtest' (ganadores) o 'goles' (goles)
function getCurrentLogFile(type = 'backtest') {
  const typeNames = {
    'backtest': 'backtest-ganadores',
    'goles': 'backtest-goles'
  };
  const filename = typeNames[type] || `backtest-${type}`;
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toLocaleTimeString('es-AR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, ''); // HHMMSS
  return path.join(logsDir, `${filename}-${date}_${time}.log`);
}

app.post('/logs', (req, res) => {
  const { message, level = 'INFO', type = 'backtest' } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    const logFilePath = getCurrentLogFile(type);
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toLocaleTimeString('es-AR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); // HH:MM:SS
    const logLine = `[${date} ${time}] [${level}] ${message}\n`;

    // Asegurar que la carpeta existe
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Agregar encabezado si es la primera línea del archivo
    if (!fs.existsSync(logFilePath)) {
      const header = `${'='.repeat(80)}\nESB SCOUT BACKTEST LOG\nIniciado: ${now.toLocaleString('es-AR')}\n${'='.repeat(80)}\n`;
      fs.appendFileSync(logFilePath, header, 'utf-8');
    }

    fs.appendFileSync(logFilePath, logLine, 'utf-8');
    console.log(`[LOGS] ✓ ${logLine.trim()}`);

    const logCount = fs.readFileSync(logFilePath, 'utf-8').split('\n').filter(l=>l.trim()).length;
    res.json({ ok: true, file: logFilePath, logCount });
  } catch(e) {
    console.error(`[LOGS] ❌ Error: ${e.message}`);
    res.status(500).json({ error: e.message, hint: 'Verificá permisos en la carpeta logs/' });
  }
});

app.get('/logs', (req, res) => {
  try {
    const type = req.query.type || 'backtest';
    const logFilePath = getCurrentLogFile(type);
    if (!fs.existsSync(logFilePath)) {
      return res.json({ logs: [], file: logFilePath, message: 'No hay logs aún', type });
    }
    const content = fs.readFileSync(logFilePath, 'utf-8');
    const logs = content.split('\n').filter(l => l.trim());
    res.json({ logs, file: logFilePath, count: logs.length, type });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BETS API ──────────────────────────────────────────────────

// GET /bets — traer historial
app.get('/bets', async (req, res) => {
  console.log(`[GET /bets] → Obteniendo historial de apuestas`);
  try {
    const result = await pool.query('SELECT * FROM bets ORDER BY created_at DESC');
    console.log(`[GET /bets] ✅ ${result.rows.length} apuestas encontradas`);
    res.json(result.rows);
  } catch(e) {
    console.error(`[GET /bets] ❌ ERROR DB: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /bets — guardar apuesta
app.post('/bets', async (req, res) => {
  const { player1, player2, bet_on, odd, amount, confidence, win_rate_fav, win_rate_riv, diff } = req.body;
  console.log(`[POST /bets] → Intentando guardar apuesta:`, {
    player1, player2, bet_on, odd, amount, confidence, win_rate_fav, win_rate_riv, diff
  });

  if (!player1 || !player2 || !bet_on) {
    console.error(`[POST /bets] ❌ Campos requeridos faltantes:`, { player1, player2, bet_on });
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    console.log(`[POST /bets] 🔄 Insertando en DB...`);
    const result = await pool.query(
      `INSERT INTO bets (player1, player2, bet_on, odd, amount, confidence, win_rate_fav, win_rate_riv, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [player1, player2, bet_on, odd, amount, confidence, win_rate_fav, win_rate_riv, diff]
    );
    console.log(`[POST /bets] ✅ Apuesta guardada con ID: ${result.rows[0].id}`);
    res.json(result.rows[0]);
  } catch(e) {
    console.error(`[POST /bets] ❌ ERROR DB: ${e.message}`, e.detail || '');
    res.status(500).json({ error: e.message });
  }
});

// PATCH /bets/:id — actualizar resultado
app.patch('/bets/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  console.log(`[PATCH /bets/:${id}] → Actualizando resultado:`, req.body);

  if (!Number.isInteger(id)) {
    console.error(`[PATCH /bets/:${id}] ❌ ID inválido`);
    return res.status(400).json({ error: 'ID inválido' });
  }

  const { result, odd, amount } = req.body;
  if (!['win', 'loss'].includes(result)) {
    console.error(`[PATCH /bets/:${id}] ❌ Resultado inválido: ${result}`);
    return res.status(400).json({ error: 'Resultado inválido' });
  }

  const profit = result === 'win'
    ? parseFloat(amount) * parseFloat(odd) - parseFloat(amount)
    : -parseFloat(amount);
  console.log(`[PATCH /bets/:${id}] 🔄 Resultado: ${result}, Ganancia calculada: $${profit}`);

  try {
    const r = await pool.query(
      'UPDATE bets SET result=$1, profit=$2 WHERE id=$3 RETURNING *',
      [result, profit, id]
    );
    if (!r.rowCount) {
      console.error(`[PATCH /bets/:${id}] ❌ Apuesta no encontrada`);
      return res.status(404).json({ error: 'Apuesta no encontrada' });
    }
    console.log(`[PATCH /bets/:${id}] ✅ Actualizada, ganancia: $${profit}`);
    res.json(r.rows[0]);
  } catch(e) {
    console.error(`[PATCH /bets/:${id}] ❌ ERROR DB: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── STRATEGY CONFIG API ───────────────────────────────────
// GET /api/strategy — obtener configuración actual
app.get('/api/strategy', async (req, res) => {
  console.log(`[GET /api/strategy] → Obteniendo configuración de estrategia`);
  try {
    const result = await pool.query('SELECT * FROM strategy_config ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      console.log(`[GET /api/strategy] ⚠️ No hay configuración guardada, devolviendo valores óptimos`);
      return res.json({
        diff_min: 12,
        wr_min: 50,
        form_min: 52,
        edge_min: 3,
        bankroll: 1000,
        bet_size: 100,
        odd: 1.85
      });
    }
    // Asegurar que todos los campos tienen valores válidos (no null/undefined)
    const config = result.rows[0];
    config.diff_min = config.diff_min ?? 12;
    config.wr_min = config.wr_min ?? 50;
    config.form_min = config.form_min ?? 52;
    config.edge_min = config.edge_min ?? 3;
    config.bankroll = config.bankroll ?? 1000;
    config.bet_size = config.bet_size ?? 100;
    config.odd = config.odd ?? 1.85;
    console.log(`[GET /api/strategy] ✅ Configuración cargada:`, config);
    res.json(config);
  } catch(e) {
    console.error(`[GET /api/strategy] ❌ ERROR DB: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/strategy — guardar/actualizar configuración
app.post('/api/strategy', async (req, res) => {
  const { diff_min, wr_min, form_min, edge_min, bankroll, bet_size, odd } = req.body;
  console.log(`[POST /api/strategy] → Intentando guardar configuración:`, {
    diff_min, wr_min, form_min, edge_min, bankroll, bet_size, odd
  });

  if (!diff_min || !wr_min || !form_min || !edge_min || !bankroll || !bet_size || !odd) {
    console.error(`[POST /api/strategy] ❌ Campos requeridos faltantes`);
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    console.log(`[POST /api/strategy] 🔄 Insertando en DB...`);
    const result = await pool.query(
      `INSERT INTO strategy_config (diff_min, wr_min, form_min, edge_min, bankroll, bet_size, odd, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [diff_min, wr_min, form_min, edge_min, bankroll, bet_size, odd]
    );
    console.log(`[POST /api/strategy] ✅ Configuración guardada:`, result.rows[0]);
    res.json(result.rows[0]);
  } catch(e) {
    console.error(`[POST /api/strategy] ❌ ERROR DB: ${e.message}`, e.detail || '');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bankroll — calcula el bankroll real desde las apuestas registradas
// Bankroll inicial hardcodeado: ajustá este valor a tu bankroll de arranque
const BANKROLL_INICIAL = 24000;
 
app.get('/api/bankroll', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COALESCE(SUM(profit), 0) as total_profit
      FROM bets
      WHERE result IN ('win', 'loss')
    `);
    const profit = parseFloat(result.rows[0].total_profit);
    const bankroll = BANKROLL_INICIAL + profit;
    console.log(`[GET /api/bankroll] ✅ Bankroll: $${bankroll.toFixed(2)} (inicial: $${BANKROLL_INICIAL} + profit: $${profit.toFixed(2)})`);
    res.json({ bankroll: parseFloat(bankroll.toFixed(2)), profit, bankroll_inicial: BANKROLL_INICIAL });
  } catch(e) {
    console.error(`[GET /api/bankroll] ❌ ERROR DB: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});


// ── BOT SIGNALS API ───────────────────────────────────────────

// POST /api/signals — guardar señal cuando el bot notifica
app.post('/api/signals', async (req, res) => {
  const {
    match_id, esb_tournament_id, nick1, nick2, home_team, away_team,
    bet_type, bet_on, odd, amount, confidence,
    fav_wr, riv_wr, diff, edge,
    over_pct, goals_line, scheduled_at
  } = req.body;

  if (!match_id || !nick1 || !nick2 || !bet_type || !bet_on) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bot_signals
        (match_id, esb_tournament_id, nick1, nick2, home_team, away_team,
         bet_type, bet_on, odd, amount, confidence,
         fav_wr, riv_wr, diff, edge, over_pct, goals_line, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [match_id, esb_tournament_id, nick1, nick2, home_team, away_team,
       bet_type, bet_on, odd, amount, confidence,
       fav_wr, riv_wr, diff, edge, over_pct, goals_line, scheduled_at]
    );
    console.log(`[POST /api/signals] ✅ Señal guardada ID=${result.rows[0].id} | ${nick1} vs ${nick2} | ${bet_type}`);
    res.json(result.rows[0]);
  } catch(e) {
    console.error(`[POST /api/signals] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/signals — historial de señales
app.get('/api/signals', async (req, res) => {
  try {
    const { result: filterResult, bet_type, limit = 100 } = req.query;
    let query = 'SELECT * FROM bot_signals';
    const params = [];
    const conditions = [];

    if (filterResult) { params.push(filterResult); conditions.push(`result = $${params.length}`); }
    if (bet_type)     { params.push(bet_type);      conditions.push(`bet_type = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');

    query += ` ORDER BY notified_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch(e) {
    console.error(`[GET /api/signals] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/signals/summary — resumen de performance del bot
app.get('/api/signals/summary', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM bot_signals_summary');
    // También traer totales generales
    const totals = await pool.query(`
      SELECT
        COUNT(*)                                           AS total,
        COUNT(*) FILTER (WHERE result = 'pending')        AS pending,
        COUNT(*) FILTER (WHERE result = 'win')            AS wins,
        COUNT(*) FILTER (WHERE result = 'loss')           AS losses,
        ROUND(
          COUNT(*) FILTER (WHERE result = 'win')::NUMERIC
          / NULLIF(COUNT(*) FILTER (WHERE result IN ('win','loss')), 0) * 100, 1
        )                                                  AS win_rate,
        ROUND(COALESCE(SUM(profit) FILTER (WHERE result IN ('win','loss')), 0), 2) AS total_profit,
        ROUND(
          COALESCE(SUM(profit) FILTER (WHERE result IN ('win','loss')), 0)
          / NULLIF(SUM(amount) FILTER (WHERE result IN ('win','loss')), 0) * 100, 1
        )                                                  AS roi
      FROM bot_signals
    `);
    res.json({ by_type: r.rows, totals: totals.rows[0] });
  } catch(e) {
    console.error(`[GET /api/signals/summary] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/signals/:id — resolver señal con resultado real
app.patch('/api/signals/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

  const { result, score1, score2, total_goals } = req.body;
  if (!['win', 'loss', 'void'].includes(result)) {
    return res.status(400).json({ error: 'Resultado inválido (win/loss/void)' });
  }

  try {
    // Calcular profit según el tipo de apuesta
    const sig = await pool.query('SELECT * FROM bot_signals WHERE id=$1', [id]);
    if (!sig.rows.length) return res.status(404).json({ error: 'Señal no encontrada' });

    const signal = sig.rows[0];
    const profit = result === 'win'
      ? parseFloat(signal.amount) * (parseFloat(signal.odd) - 1)
      : result === 'loss' ? -parseFloat(signal.amount) : 0;

    const r = await pool.query(
      `UPDATE bot_signals
       SET result=$1, score1=$2, score2=$3, total_goals=$4,
           profit=$5, resolved_at=NOW()
       WHERE id=$6 RETURNING *`,
      [result, score1, score2, total_goals, profit, id]
    );
    console.log(`[PATCH /api/signals/${id}] ✅ Resuelto: ${result} | profit: $${profit}`);
    res.json(r.rows[0]);
  } catch(e) {
    console.error(`[PATCH /api/signals/${id}] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/signals/pending — señales pendientes de resolver (para el bot)
app.get('/api/signals/pending', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM bot_signals
      WHERE result = 'pending'
        AND notified_at > NOW() - INTERVAL '12 hours'
      ORDER BY notified_at ASC
    `);
    res.json(r.rows);
  } catch(e) {
    console.error(`[GET /api/signals/pending] ❌ ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── STATIC FILES (ÚLTIMO) ──
// Esto debe estar al final para que las rutas API tengan prioridad
app.use(express.static('.'));

app.listen(3000, () => {
  console.log('════════════════════════════════════════════════');
  console.log('🚀 ESB Scout corriendo en http://localhost:3000');
  console.log('📊 Database: esbscout (user: scout)');
  console.log('📡 Proxy disponible en /proxy');
  console.log('💾 Apuestas disponibles en /bets');
  console.log('📋 Logs disponibles en /logs (POST para guardar, GET para leer)');
  console.log('📁 Archivos de logs: logs/backtest-YYYY-MM-DD.log');
  console.log('════════════════════════════════════════════════');
});
