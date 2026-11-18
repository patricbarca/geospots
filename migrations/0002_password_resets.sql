-- Links de un solo uso para poner una contraseña nueva (los genera un administrador con scripts/reset-link.mjs).
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
