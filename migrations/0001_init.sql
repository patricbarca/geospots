-- GeoSpots: usuarios, equipos y registros sincronizados (planos, puntos, recorridos).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- role: admin (invita y borra planos) o miembro
CREATE TABLE members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 20
);

-- kind: map, pin o track. data es el JSON del registro sin archivos (los archivos van a R2).
-- seq crece con cada cambio dentro del equipo: los teléfonos piden "lo que cambió después de seq".
CREATE TABLE records (
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (team_id, kind, id)
);
CREATE INDEX records_seq ON records(team_id, seq);

-- Archivos en R2 (imagen y miniatura de planos, fotos de puntos)
CREATE TABLE files (
  team_id TEXT NOT NULL,
  id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, id)
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
