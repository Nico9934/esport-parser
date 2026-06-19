-- Agregar columna bet_placed a bot_signals si no existe (para DBs existentes)
ALTER TABLE bot_signals ADD COLUMN IF NOT EXISTS bet_placed BOOLEAN DEFAULT NULL;

CREATE TABLE IF NOT EXISTS bets (
  id           SERIAL PRIMARY KEY,
  created_at   TIMESTAMP DEFAULT NOW(),
  match_date   DATE DEFAULT CURRENT_DATE,
  player1      VARCHAR(100) NOT NULL,
  player2      VARCHAR(100) NOT NULL,
  bet_on       VARCHAR(100) NOT NULL,
  odd          DECIMAL(5,2),
  amount       DECIMAL(10,2),
  confidence   VARCHAR(20),
  win_rate_fav DECIMAL(5,2),
  win_rate_riv DECIMAL(5,2),
  diff         DECIMAL(5,2),
  result       VARCHAR(10) DEFAULT 'pending',  -- 'win', 'loss', 'pending'
  profit       DECIMAL(10,2) DEFAULT 0
);
