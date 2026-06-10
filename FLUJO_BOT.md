# 🤖 ESBScout Bot v3.0 — Flujo Completo

---

## 📋 ÍNDICE
1. [Inicialización](#inicialización)
2. [SCAN - Buscar y notificar apuestas](#scan---buscar-y-notificar-apuestas)
3. [RESOLVE - Resolver resultados](#resolve---resolver-resultados)
4. [POLL COMMANDS - Comandos Telegram](#poll-commands---comandos-telegram)
5. [Comparación de datos](#comparación-de-datos)
6. [Estructura de datos](#estructura-de-datos)

---

## 🚀 INICIALIZACIÓN

```
main()
  ├─ Validar .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
  ├─ Enviar mensaje "Bot iniciado" a Telegram
  ├─ loadNotifiedMatchIds()
  │  └─ GET /api/signals
  │     └─ Carga todos los match_id de la DB en memoria
  │        └─ Evita notificar duplicados
  ├─ loadNotifiedFromDB()
  │  └─ GET /api/signals
  │     └─ Carga historial completo
  ├─ resolvePendingOnStartup()
  │  └─ GET /api/signals/pending
  │     └─ Intenta resolver señales vencidas
  ├─ scan() [EJECUTAR INMEDIATAMENTE]
  │
  └─ INICIAR JOBS CRON:
     ├─ SCAN_CRON (*/7 min) → scan()
     ├─ RESOLVE_CRON (*/3 min) → resolveSignals()
     └─ pollCommands() [cada 3 seg en setInterval]
```

---

## 🔍 SCAN - Buscar y notificar apuestas

**Ejecuta:** Cada 7 minutos

```
SCAN()
│
├─ 1️⃣ TRAER EVENTOS DE BETSSON
│  │
│  ├─ betsson.invalidateCache()
│  │
│  └─ betsson.fetchEvents()
│     │
│     └─ BETSSON (Web scrape)
│        ├─ Busca eventos activos
│        ├─ Extrae: id, participants, startDate
│        └─ Retorna: Array de eventos
│           └─ [ 
│              {
│                id: "f-abc123...",
│                participants: [
│                  { label: "Team A (nick1)" },
│                  { label: "Team B (nick2)" }
│                ],
│                startDate: "2026-06-08T16:04:00.000Z"
│              },
│              ...
│            ]
│
├─ 2️⃣ FILTRAR EVENTOS YA NOTIFICADOS
│  │
│  └─ forEach evento:
│     ├─ extractNick(participant.label) → "nick1"
│     ├─ extractNick(participant.label) → "nick2"
│     ├─ Verificar: ¿matchId ya en notifiedMatchIds?
│     │  ├─ SI → SKIP evento
│     │  └─ NO → Agregar a uniqueMatches[]
│     └─ RESULTADO: 18-20 pares únicos
│
├─ 3️⃣ OBTENER BANKROLL
│  │
│  └─ GET http://localhost:3000/api/bankroll
│     └─ Retorna: { bankroll: 5000 }
│
├─ 4️⃣ ANALIZAR CADA PAR (de a 2 en paralelo)
│  │
│  └─ analyzePair(nick1, nick2, matchId, scheduledAt)
│     │
│     ├─ 4.1) OBTENER WIN RATES HISTÓRICOS
│     │  │
│     │  └─ GET ESB/participants/{nick1}/compare/{nick2}
│     │     │
│     │     └─ ESB API
│     │        └─ Retorna: [
│     │           {
│     │             totalMatches: 50,
│     │             totalWin: 18,
│     │             winRate: 36%
│     │           },
│     │           {
│     │             totalMatches: 48,
│     │             totalWin: 20,
│     │             winRate: 41.7%
│     │           }
│     │         ]
│     │        └─ CÁLCULO:
│     │           wr1 = 18 / 50 * 100 = 36%
│     │           wr2 = 20 / 48 * 100 = 41.7%
│     │           isP1Fav = 36% >= 41.7% ? FALSE
│     │           favNick = nick2 (41.7%)
│     │           favWr = 41.7%
│     │
│     ├─ 4.2) OBTENER FORMA RECIENTE (en paralelo)
│     │  │
│     │  ├─ getRecentForm(favNick)
│     │  │  │
│     │  │  └─ GET ESB/participants/{favNick}/tournaments?page=1-4
│     │  │     │
│     │  │     ├─ Filtra: status_id === 3 || 4 (completados)
│     │  │     ├─ Toma: últimos 6 torneos
│     │  │     │
│     │  │     └─ Para cada torneo:
│     │  │        └─ GET ESB/tournaments/{id}/matches
│     │  │           └─ Busca partidos del jugador
│     │  │
│     │  │  CÁLCULOS:
│     │  │  ├─ Wins: 8
│     │  │  ├─ Losses: 3
│     │  │  ├─ Draws: 1
│     │  │  ├─ Total: 12
│     │  │  ├─ Win%: 8/12 * 100 = 66.7%
│     │  │  ├─ Goles totales por match: [4,5,6,7,3,4,5,6,7,8,3,4]
│     │  │  ├─ Average: 5.25
│     │  │  ├─ StdDev: √(varianza) = 1.7
│     │  │  ├─ Over45%: matches > 4 / total = 10/12 = 83.3%
│     │  │  ├─ Over55%: matches > 5 / total = 8/12 = 66.7%
│     │  │  └─ Over65%: matches > 6 / total = 5/12 = 41.7%
│     │  │     └─ RETORNA:
│     │  │        {
│     │  │          recentWinPct: 66.7,
│     │  │          recentMatches: 12,
│     │  │          w: 8, d: 1, l: 3,
│     │  │          avgTotal: 5.25,
│     │  │          stdDev: 1.7,
│     │  │          over45: 83.3,
│     │  │          over55: 66.7,
│     │  │          over65: 41.7
│     │  │        }
│     │  │
│     │  └─ getRecentForm(rivNick) [MISMO PROCESO]
│     │
│     ├─ 4.3) OBTENER ODDS DE BETSSON (en paralelo)
│     │  │
│     │  └─ betsson.getMatchOdds(nick1, nick2)
│     │     │
│     │     └─ BETSSON (Web scrape)
│     │        └─ Busca el partido en Betsson
│     │           └─ RETORNA:
│     │              {
│     │                homeTeam: "Team A",
│     │                awayTeam: "Team B",
│     │                homeNick: "nick1",
│     │                awayNick: "nick2",
│     │                winNick1: 2.4,
│     │                winNick2: 1.65,
│     │                winDraw: 3.5,
│     │                goalsLine: 5.5,
│     │                oddOver: 1.75,
│     │                oddUnder: 1.95,
│     │                url: "https://betsson.com/..."
│     │              }
│     │
│     └─ 4.4) VALIDAR ESTRATEGIA GANADOR
│        │
│        └─ getConfidenceGanador(favWr, rivWr, favForm, favNick, rivNick, betssonOdds)
│           │
│           ├─ CÁLCULOS:
│           │  ├─ diff = favWr - rivWr = 41.7% - 36% = 5.7%
│           │  ├─ oddFav = 1.65 (Betsson)
│           │  ├─ impliedProb = 1 / 1.65 * 100 = 60.6%
│           │  ├─ edge = 41.7% - 60.6% = -18.9% (NEGATIVO!)
│           │  │
│           │  └─ VALIDACIONES:
│           │     ├─ ❌ diff=5.7% < diffMin=12% → RECHAZA
│           │     ├─ ✅ favWr=41.7% >= wrMin=50% ? NO → RECHAZA
│           │     └─ ❌ edge=-18.9% < edgeMin=3% → RECHAZA
│           │
│           └─ RETORNA: { pass: true } (NO RECOMENDAR)
│
│        └─ 4.5) VALIDAR ESTRATEGIA GOLES
│           │
│           └─ getGoalsSignal(favForm, rivForm, betssonOdds)
│              │
│              ├─ CÁLCULOS:
│              │  ├─ goalsLine = 5.5 (de Betsson)
│              │  ├─ Selecciona Over% según línea:
│              │  │  ├─ favForm.over55 = 66.7%
│              │  │  ├─ rivForm.over55 = 72.3%
│              │  │  │
│              │  │  └─ overGeo = √(66.7 * 72.3) = √4821.4 = 69.4%
│              │  │
│              │  ├─ stdDevPair = (1.7 + 1.9) / 2 = 1.8
│              │  ├─ impliedProb = 1 / 1.75 * 100 = 57.1%
│              │  ├─ edge = 69.4% - 57.1% = 12.3%
│              │  │
│              │  └─ VALIDACIONES:
│              │     ├─ ✅ overGeo=69.4% >= overMin=60%
│              │     ├─ ✅ edge=12.3% >= edgeMin=3%
│              │     └─ ✅ stdDevPair=1.8 <= stdDevMax=25
│              │
│              └─ RETORNA: { 
│                 line: 5.5,
│                 overGeo: 69.4,
│                 edge: 12.3,
│                 oddOver: 1.75,
│                 oddUnder: 1.95
│               } (¡VÁLIDO!)
│
├─ 5️⃣ FILTRAR RECOMENDACIONES
│  │
│  └─ Si confGanador.pass=true Y goalsSignal=null → SKIP
│     Si goalsSignal válido → INCLUIR
│        └─ recommendations[] = [
│           {
│             matchId, scheduledAt,
│             nick1, nick2,
│             favWr, rivWr,
│             favForm, rivForm,
│             confGanador,
│             goalsSignal,
│             betssonOdds
│           }
│         ]
│
├─ 6️⃣ NOTIFICAR EN TELEGRAM
│  │
│  └─ Para cada recomendación:
│     │
│     ├─ formatMessage(recommendation, bankroll)
│     │  └─ GENERA HTML con:
│     │     ├─ Equipo (si Betsson tiene)
│     │     ├─ Jugadores y hora
│     │     ├─ Detalles de GOLES si es válido
│     │     ├─ Odds de Betsson
│     │     ├─ Edge calculado
│     │     └─ Link a Betsson
│     │
│     ├─ POST Telegram API
│     │  └─ sendTelegram(formattedMessage)
│     │     └─ Envía a CHAT_ID configurado
│     │
│     ├─ Guardar en DB
│     │  │
│     │  └─ saveSignal(recommendation, bankroll)
│     │     │
│     │     └─ POST http://localhost:3000/api/signals
│     │        └─ Guarda en DB:
│     │           {
│     │             match_id: "f-abc123...",
│     │             nick1: "nick2",
│     │             nick2: "nick1",
│     │             home_team: "Team A",
│     │             away_team: "Team B",
│     │             bet_type: "goles",
│     │             bet_on: "over 5.5",
│     │             odd: 1.75,
│     │             amount: 137,
│     │             confidence: "signal",
│     │             fav_wr: 41.7,
│     │             riv_wr: 36.0,
│     │             diff: 5.7,
│     │             edge: 12.3,
│     │             over_pct: 69.4,
│     │             goals_line: 5.5,
│     │             scheduled_at: "2026-06-08T16:04:00.000Z"
│     │           }
│     │
│     ├─ Agregar a notificados
│     │  └─ notifiedMatchIds.add(matchId)
│     │
│     └─ Esperar 1 segundo antes de siguiente
│
└─ 7️⃣ RESUMEN
   └─ Log: "Recomendaciones: 3"
```

---

## ✅ RESOLVE - Resolver resultados

**Ejecuta:** Cada 3 minutos

```
resolveSignals()
│
├─ 1️⃣ OBTENER SEÑALES PENDIENTES
│  │
│  └─ GET http://localhost:3000/api/signals/pending
│     └─ Retorna: [
│        {
│          id: 65,
│          match_id: "f-abc123..._goles",
│          nick1: "nick2",
│          nick2: "nick1",
│          bet_type: "goles",
│          bet_on: "over 5.5",
│          odd: 1.75,
│          amount: 137,
│          goals_line: 5.5,
│          scheduled_at: "2026-06-08T16:04:00.000Z",
│          result: "pending"
│        }
│      ]
│
├─ 2️⃣ VALIDAR TIEMPO MÍNIMO
│  │
│  └─ Para cada signal:
│     │
│     ├─ now = Date.now() = 2026-06-08T16:07:00Z
│     ├─ sigTime = new Date(scheduled_at) = 2026-06-08T16:04:00Z
│     ├─ minsSince = (now - sigTime) / 60000 = 3 minutos
│     │
│     └─ ¿minsSince < 3 minutos?
│        ├─ SI → SKIP (partido aún no debería terminar)
│        └─ NO → CONTINUAR
│
├─ 3️⃣ BUSCAR PARTIDO EN ESB
│  │
│  └─ GET ESB/participants/{nick1}/tournaments?page=1-2
│     │
│     └─ Filtra: status_id === 4 (completados)
│        └─ Toma: últimos 6 torneos
│           │
│           └─ Para cada torneo:
│              │
│              └─ GET ESB/tournaments/{id}/matches
│                 │
│                 └─ Busca partido con:
│                    ├─ mismo nick1 Y nick2
│                    ├─ status_id === 3 (completado)
│                    ├─ scores disponibles
│                    │
│                    └─ CÁLCULO DISTANCIA:
│                       ├─ Calcula distancia de fecha respecto a scheduled_at
│                       ├─ Si > 3 horas → SKIP
│                       └─ Elige el más cercano en fecha
│
├─ 4️⃣ OBTENER RESULTADO
│  │
│  ├─ score1 = match.participant1.score = 3
│  ├─ score2 = match.participant2.score = 4
│  ├─ totalGoals = 3 + 4 = 7
│  │
│  └─ Determinar WIN/LOSS:
│     │
│     ├─ SI bet_type === "goles":
│     │  ├─ totalGoals > goalsLine ?
│     │  ├─ 7 > 5.5 ?
│     │  └─ YES → betResult = "win"
│     │
│     └─ SI bet_type === "ganador":
│        ├─ ¿bet_on (favNick) ganó?
│        └─ betResult = "win" o "loss"
│
├─ 5️⃣ GUARDAR RESULTADO EN DB
│  │
│  └─ PATCH http://localhost:3000/api/signals/{id}
│     └─ Body: {
│        result: "win",
│        score1: 3,
│        score2: 4,
│        total_goals: 7
│      }
│
├─ 6️⃣ CALCULAR GANANCIA/PÉRDIDA
│  │
│  ├─ SI result === "win":
│  │  ├─ profit = amount * (odd - 1)
│  │  ├─ profit = 137 * (1.75 - 1)
│  │  ├─ profit = 137 * 0.75
│  │  └─ profit = $102.75
│  │
│  └─ SI result === "loss":
│     └─ profit = -amount = -$137
│
├─ 7️⃣ NOTIFICAR RESULTADO EN TELEGRAM
│  │
│  └─ sendTelegram([
│     "✅ RESULTADO — 📊 Goles",
│     "🏟 Team A vs Team B",
│     "👤 nick1 vs nick2  🕐 16:04",
│     "⚽ Marcador: 3 - 4 (total 7)",
│     "🎯 Apostado a: over 5.5 @ 1.75",
│     "📊 GANÓ 🎉",
│     "💰 P&L: +$102.75"
│   ])
│
└─ 8️⃣ LOG
   └─ "[RESOLVE] ✅ nick1 vs nick2 | goles | win | 3-4 | P&L: $102.75"
```

---

## 💬 POLL COMMANDS - Comandos Telegram

**Ejecuta:** Cada 3 segundos

```
pollCommands()
│
├─ GET Telegram API
│  │
│  └─ GET https://api.telegram.org/bot{TOKEN}/getUpdates
│     └─ Retorna: {
│        result: [
│          {
│            update_id: 12345,
│            message: {
│              chat_id: CHAT_ID,
│              text: "/analizar nick1 vs nick2"
│            }
│          }
│        ]
│      }
│
├─ PARSE COMANDO
│  │
│  └─ text = "/analizar nick1 vs nick2"
│     ├─ parts = ["nick1", "nick2"]
│     │
│     └─ Llamar: analyzePair(nick1, nick2, "manual-nick1-nick2", null)
│        └─ [MISMO PROCESO QUE EN SCAN]
│           └─ Retorna: {
│              confGanador: {...},
│              goalsSignal: {...},
│              betssonOdds: {...}
│            }
│
├─ ENVIAR RESPUESTA
│  │
│  └─ sendTelegram(formatMessage(result, null))
│     └─ Responde con análisis
│
└─ COMANDOS DISPONIBLES:
   ├─ /analizar nick1 vs nick2 → Analizar partido específico
   ├─ /odds → Ver tabla actual de Betsson
   ├─ /status → Ver estado del bot
   ├─ /resumen → Ver performance (W/L, ROI, profit)
   └─ /limpiar → Limpiar cache
```

---

## 🔢 Comparación de datos

### FLOW: ¿POR QUÉ SE RECOMIENDA UNA APUESTA?

```
ENTRADA:
  nick1 = "A" (36% histórico)
  nick2 = "B" (41.7% histórico)

1️⃣ IDENTIFICAR FAVORITO:
   favWr = 41.7% (nick2 es favorito)
   rivWr = 36.0%
   diff = 5.7%

2️⃣ TRAER DATOS ADICIONALES:
   ├─ favForm (últimos 6 torneos de B):
   │  └─ { winPct: 66.7%, w: 8, l: 3, d: 1, over55: 66.7% }
   ├─ rivForm (últimos 6 torneos de A):
   │  └─ { winPct: 52.1%, w: 7, l: 4, d: 1, over55: 61.8% }
   └─ betssonOdds:
      └─ { oddOver: 1.75, goalsLine: 5.5 }

3️⃣ ESTRATEGIA GANADOR:
   ├─ diff = 5.7% < 12% → ❌ RECHAZA (diferencia pequeña)
   ├─ favWr = 41.7% < 50% → ❌ RECHAZA (bajo win rate)
   └─ edge = negativo → ❌ RECHAZA (apuesta desfavorable)

4️⃣ ESTRATEGIA GOLES:
   ├─ goalsLine = 5.5 (línea real de Betsson)
   ├─ over55_fav = 66.7%
   ├─ over55_riv = 61.8%
   ├─ overGeo = √(66.7 * 61.8) = 64.2%
   ├─ impliedProb = 1/1.75 = 57.1%
   ├─ edge = 64.2% - 57.1% = 7.1%
   ├─ stdDev = 1.8 <= 25
   │
   └─ VALIDACIONES:
      ├─ ✅ overGeo=64.2% >= 60%
      ├─ ✅ edge=7.1% >= 3%
      └─ ✅ stdDev=1.8 <= 25
      
   RESULTADO: ✅ RECOMENDARÍA APOSTAR

5️⃣ APUESTA RECOMENDADA:
   {
     bet_type: "goles",
     bet_on: "over 5.5",
     odd: 1.75,
     amount: 137 (3% de bankroll=4500),
     confidence: "signal",
     edge: 7.1%
   }
```

---

## 📊 Estructura de Datos

### Database (signals)

```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY,
  match_id VARCHAR(255),          -- "f-abc123..." o "f-abc123..._goles"
  nick1 VARCHAR(100),
  nick2 VARCHAR(100),
  home_team VARCHAR(100),
  away_team VARCHAR(100),
  bet_type VARCHAR(20),            -- "ganador" o "goles"
  bet_on VARCHAR(50),              -- "nick1" o "over 5.5"
  odd DECIMAL(5,2),
  amount DECIMAL(10,2),
  confidence VARCHAR(20),          -- "high", "vhigh", "signal"
  fav_wr DECIMAL(5,2),
  riv_wr DECIMAL(5,2),
  diff DECIMAL(5,2),
  edge DECIMAL(5,2),
  over_pct DECIMAL(5,2),           -- GOLES
  goals_line DECIMAL(3,1),         -- GOLES
  scheduled_at DATETIME,
  result VARCHAR(20),              -- "pending", "win", "loss"
  score1 INTEGER,
  score2 INTEGER,
  total_goals INTEGER,
  profit DECIMAL(10,2),
  notified_at DATETIME,
  resolved_at DATETIME
);
```

### En Memoria (notifiedMatchIds)

```javascript
{
  "f-abc123...",
  "f-def456...",
  "f-ghi789...",
  // ... todos los match_id ya notificados
}
// → Previene duplicados en cada SCAN
```

---

## 🎯 RESUMEN VISUAL

```
┌─────────────────────────────────────────────────────────────┐
│                    BETSSON (Web)                            │
│                                                              │
│  fetchEvents() → [evento1, evento2, evento3]               │
│  getMatchOdds() → {odds, goalsLine, oddOver}              │
└─────────────────────────────────────────────────────────────┘
                            ↓
            ┌───────────────┴───────────────┐
            ↓                               ↓
        ┌─────────────┐          ┌──────────────────┐
        │   SCAN      │          │   RESOLVE        │
        │ (*/7 min)   │          │   (*/3 min)      │
        └─────────────┘          └──────────────────┘
            ↓                               ↓
    [Analiza pares]              [Busca resultados]
    [Calcula edges]              [Resuelve apuestas]
    [Valida estrategias]         [Notifica resultados]
            ↓                               ↓
        ┌─────────────────────────────────┐
        │  TELEGRAM (Notificaciones)      │
        │                                 │
        │ "🎯 GOLES — Over 5.5            │
        │  Edge real: +7.1%               │
        │  💰 Sugerido: $137"             │
        └─────────────────────────────────┘
            ↓
        ┌─────────────────────────────────┐
        │  DATABASE (signals)             │
        │  ✅ Guardada con ID             │
        │  ⏳ Marcada como "pending"      │
        └─────────────────────────────────┘
            ↓
        [RESOLVE busca resultado en ESB]
            ↓
        [Actualiza DB con resultado]
            ↓
        ┌─────────────────────────────────┐
        │  TELEGRAM (Resultado)           │
        │  "✅ GANÓ 🎉                     │
        │  💰 P&L: +$102.75"              │
        └─────────────────────────────────┘
            ↓
        ┌─────────────────────────────────┐
        │  DATABASE                       │
        │  ✅ result = "win"              │
        │  ✅ score1 = 3, score2 = 4     │
        │  ✅ profit = $102.75            │
        └─────────────────────────────────┘
```

---

## 🔄 FLUJO TEMPORAL EN UN DÍA

```
00:00 → Bot inicia
        ├─ loadNotifiedMatchIds() desde DB
        ├─ Primer SCAN inmediato
        └─ Inicia cron jobs

00:00 → SCAN #1 (inmediato)
        └─ Betsson tiene eventos 00:07-00:20
           └─ Bot notifica 3 apuestas → DB

00:03 → RESOLVE #1
        └─ Apuestas de hace 20 min
           └─ ESB aún no tiene resultados → pending

00:07 → SCAN #2
        └─ Betsson tiene eventos 00:14-00:30
           └─ Bot notifica 4 apuestas nuevas → DB

00:10 → RESOLVE #2
        └─ Apuestas de hace 13-17 min
           └─ ESB actualiza resultados
           └─ Bot notifica: "✅ GANÓ", "❌ PERDIÓ"
           └─ Actualiza DB

00:14 → SCAN #3
        └─ ... continúa cada 7 min ...

...

23:59 → RESOLVE #N (última)
        └─ Resuelve apuestas pendientes
```

