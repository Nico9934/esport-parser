# 🐛 Guía de Debugging con Logs

Se han agregado logs estratégicos en el frontend (browser console) y backend (terminal) para debuguear el flujo completo del backtesting.

---

## 📱 FRONTEND - Browser Console (F12)

Abre **DevTools (F12)** → **Console** para ver los logs en tiempo real.

### 1️⃣ **Inicio del Análisis**
```
🎯 ANÁLISIS INICIADO { cantidadPartidos: 2, partidos: [...] }
```
Muestra cuántos partidos se van a analizar y sus datos parseados.

---

### 2️⃣ **Análisis por Fila**
Cuando se inicia el análisis de cada partido:
```
📊 ANALIZANDO FILA 0: { p1: "jugador1", p2: "jugador2", odd: 2.35 }
  → Fetch compare: jugador1 vs jugador2
  ✓ compareData: [ {...}, {...} ]
  ✓ form1 (jugador1): { recentWinPct: 52.3, recentMatches: 20, ... }
  ✓ form2 (jugador2): { recentWinPct: 48.1, recentMatches: 18, ... }
  ✓ h2h: { total: 3, w1: 2, w2: 1, draws: 0, pct1: 66.7, pct2: 33.3 }
  ✅ FILA 0 RENDERIZADA
```
Puedes ver exactamente qué datos llegan de las APIs.

---

### 3️⃣ **Peticiones HTTP (pFetch)**
Cada fetch a las APIs de ESB:
```
🌐 pFetch → https://football.esportsbattle.com/api/participants/...
  ✓ pFetch OK ({"tournaments":[...
```
Useful para ver si las URLs son correctas.

---

### 4️⃣ **Forma Reciente (getRecentForm)**
```
📈 getRecentForm("jugador1") - buscando últimas 2 páginas
  ✓ Tournaments encontrados: [3, 2]
  ✓ Tournaments activos (status_id=4): 5
  → Cargando matches de 3 torneos
  ✓ Matches donde participa "jugador1": 15
  ✅ getRecentForm("jugador1") => 52.3% WR (10W/1D/4L)
```
Verifica qué forma reciente se está usando para los cálculos.

---

### 5️⃣ **Head to Head (H2H)**
```
⚔️ getH2H("jugador1" vs "jugador2")
  ✓ Tournaments activos: 5
  ✓ H2H matches encontrados: 3
  ✅ getH2H => 2W(jugador1) / 1W(jugador2) / 0D
```
Muestra el historial directo entre los dos jugadores.

---

### 6️⃣ **Renderizado de la Fila**
```
🎨 renderRow iniciando: { 
  p1Name: "jugador1", 
  p2Name: "jugador2", 
  inputOdd: 2.35, 
  form1: {...}, 
  form2: {...}, 
  h2h: {...}
}
✅ renderRow completada: { 
  fav: "jugador1", 
  rec: "jugador1", 
  confCls: "c-high", 
  confLbl: "🟢 ALTA", 
  apuesta: "$2000" 
}
```
Ver exactamente qué se está renderizando en pantalla.

---

### 7️⃣ **Guardar Apuesta (saveBet)**
```
💾 saveBet → enviando apuesta: {
  player1: "jugador1",
  player2: "jugador2",
  bet_on: "jugador1",
  confidence: "🟢 ALTA",
  odd: 2.35,
  amount: 2000,
  ...
}
📤 POST /bets con payload: {...}
✅ POST /bets OK: { id: 42, player1: "jugador1", ... }
```
Verifica qué datos se están enviando al servidor.

---

### 8️⃣ **Historial (loadHistory)**
```
[GET /bets] → Obteniendo historial de apuestas
[GET /bets] ✅ 5 apuestas encontradas
```
Muestra cuántas apuestas se cargan del historial.

---

### ❌ **Errores en Frontend**
```
❌ pFetch ERROR: HTTP 404
  ❌ getRecentForm ERROR: TypeError: Cannot read property 'tournaments'
  ❌ FILA 0 RENDERIZADA
  ❌ saveBet ERROR: Network error
```
Cualquier error que ocurra se loguea con detalles.

---

## 🖥️ BACKEND - Terminal/Console

Cuando ejecutes `npm start` o `npm run dev`, verás los logs en la terminal.

### 🚀 **Startup**
```
════════════════════════════════════════════════
🚀 ESB Scout corriendo en http://localhost:3000
📊 Database: esbscout (user: scout)
📡 Proxy disponible en /proxy
💾 Apuestas disponible en /bets
════════════════════════════════════════════════
```

---

### 📡 **Proxy (cada request a ESB)**
```
[PROXY] GET https://football.esportsbattle.com/api/participants/...
[PROXY] → Fetching: https://football.esportsbattle.com/api/participants/...
[PROXY] ✅ Response OK (4521 bytes, status 200)
```
Verifica que el proxy funciona correctamente.

---

### 💾 **POST /bets (guardar apuesta)**
```
[POST /bets] → Intentando guardar apuesta: {
  player1: "jugador1",
  player2: "jugador2",
  bet_on: "jugador1",
  odd: 2.35,
  amount: 2000,
  confidence: "🟢 ALTA",
  win_rate_fav: 62.5,
  win_rate_riv: 40.3,
  diff: 22.2
}
[POST /bets] 🔄 Insertando en DB...
[POST /bets] ✅ Apuesta guardada con ID: 42
```

---

### 📋 **GET /bets (cargar historial)**
```
[GET /bets] → Obteniendo historial de apuestas
[GET /bets] ✅ 5 apuestas encontradas
```

---

### ✏️ **PATCH /bets/:id (actualizar resultado)**
```
[PATCH /bets/:42] → Actualizando resultado: { result: "win", odd: 2.35, amount: 2000 }
[PATCH /bets/:42] 🔄 Resultado: win, Ganancia calculada: $2700
[PATCH /bets/:42] ✅ Actualizada, ganancia: $2700
```

---

### ❌ **Errores en Backend**
```
[POST /bets] ❌ Campos requeridos faltantes: { player1: undefined, player2: "...", bet_on: "..." }
[POST /bets] ❌ ERROR DB: duplicate key value violates unique constraint
[PATCH /bets/:999] ❌ Apuesta no encontrada
[PROXY] ❌ ERROR: ECONNREFUSED (no internet o servidor caído)
```

---

## 🔍 Cómo Debuguear el Flujo

### Escenario 1: No aparecen resultados en la pantalla
1. Abre **DevTools (F12)** → **Console**
2. Busca `❌ FILA X RENDERIZADA`
3. Verifica qué error dice
4. Si dice `sin datos`, revisa los logs de `✓ compareData`

### Escenario 2: No se guarda la apuesta
1. Abre **Console** del navegador
2. Busca `💾 saveBet →`
3. Verifica que los datos sean correctos
4. Busca `✅ POST /bets OK` o `❌ POST /bets ERROR`
5. Si hay error, abre **Terminal** y busca `[POST /bets] ❌`

### Escenario 3: No se cargan los datos de los jugadores
1. Verifica que la DB está corriendo (`psql esbscout`)
2. Abre **Terminal** de Node
3. Busca `[PROXY] ✅ Response OK` para ver si llega data
4. Busca `❌ getRecentForm ERROR` para ver qué falla

---

## 📊 Ejemplo de Flujo Completo

```
🎯 ANÁLISIS INICIADO { cantidadPartidos: 1, partidos: [...] }
📊 ANALIZANDO FILA 0: { p1: "Badema", p2: "Hristian05", odd: 2.35 }
  → Fetch compare: Badema vs Hristian05
  🌐 pFetch → https://football.esportsbattle.com/api/participants/Badema/compare/...
  ✓ pFetch OK ({"0":{"nickname":"Badema","totalMatches":1523,...
  🌐 pFetch → https://football.esportsbattle.com/api/participants/Badema/tournaments?page=1
  ✓ pFetch OK ({"tournaments":[...
  📈 getRecentForm("Badema") - buscando últimas 2 páginas
    ✓ Tournaments encontrados: [20, 18]
    ✓ Tournaments activos (status_id=4): 35
    → Cargando matches de 3 torneos
    🌐 pFetch → https://football.esportsbattle.com/api/tournaments/12345/matches
    ✓ pFetch OK ({"matches":[...
    ✓ Matches donde participa "Badema": 12
    ✅ getRecentForm("Badema") => 58.3% WR (7W/0D/5L)
  📈 getRecentForm("Hristian05") - buscando últimas 2 páginas
    ...similar...
  ⚔️ getH2H("Badema" vs "Hristian05")
    ✓ Tournaments activos: 35
    ✓ H2H matches encontrados: 5
    ✅ getH2H => 3W(Badema) / 2W(Hristian05) / 0D
  ✓ compareData: [...]
  ✓ form1 (Badema): { recentWinPct: 58.3, ... }
  ✓ form2 (Hristian05): { recentWinPct: 52.1, ... }
  ✓ h2h: { total: 5, w1: 3, w2: 2, ... }
  🎨 renderRow iniciando: { ... }
  ✅ renderRow completada: { fav: "Badema", rec: "Badema", confCls: "c-high", ... }
  ✅ FILA 0 RENDERIZADA
✅ ANÁLISIS COMPLETADO
```

---

¡Ahora tienes visibilidad total del flujo! 🎯
