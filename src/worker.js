/* GeoSpots: API en un Worker de Cloudflare.
   - D1 (env.DB): usuarios, equipos, sesiones, invitaciones y los registros sincronizados (planos, puntos, recorridos).
   - R2 (env.FILES): imágenes de planos, miniaturas y fotos.
   - La app (public/) se sirve como asset estático; solo /api/* pasa por este código. */

const DAY = 86400000;
const SESSION_MS = 90 * DAY;
const INVITE_MS = 7 * DAY;
const PBKDF2_ITER = 20000; // ~5 ms de CPU: cabe en los 10 ms del plan gratis (medido en Comandia)
const MAX_FILE = 60 * 1024 * 1024;
const MAX_RECORD = 256 * 1024;
const KINDS = new Set(['map', 'pin', 'track']);
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const COOKIE = '__Host-gs_s';

class HttpError extends Error {
  constructor(status, message, code = 'error', headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });
}

// ---------- cripto ----------
const enc = new TextEncoder();
function b64url(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u;
}
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const randomToken = (n = 32) => b64url(randomBytes(n));
const newId = (p) => `${p}_${b64url(randomBytes(12))}`;
async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
async function pbkdf2(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

// ---------- cookies y sesión ----------
function readCookie(req) {
  const c = req.headers.get('Cookie'); if (!c) return null;
  for (const part of c.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim(); }
  return null;
}
const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

async function createSession(env, userId) {
  const token = randomToken(), now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now + SESSION_MS).run();
  return token;
}

async function getUser(req, env) {
  const token = readCookie(req);
  if (!token || token.length < 20 || token.length > 100) return null;
  const th = await sha256(token), now = Date.now();
  const row = await env.DB.prepare(`SELECT s.expires_at, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(th, now).first();
  if (!row) return null;
  // Sesión deslizante: se renueva si le quedan menos de 30 días.
  if (row.expires_at - now < 30 * DAY) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_MS, th).run();
  }
  return { id: row.id, email: row.email, name: row.name, tokenHash: th };
}
async function requireUser(req, env) {
  const u = await getUser(req, env);
  if (!u) throw new HttpError(401, 'Inicia sesión para continuar.', 'sin-sesion');
  return u;
}
async function requireMember(env, user, teamId) {
  const m = await env.DB.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').bind(teamId, user.id).first();
  if (!m) throw new HttpError(403, 'No perteneces a este equipo.', 'sin-acceso');
  return m.role;
}

// ---------- límite de intentos ----------
async function enforceRate(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ?2 - ?3 THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ?2 - ?3 THEN ?2 ELSE rate_limits.window_start END
    RETURNING count, window_start`).bind(key, now, windowMs).first();
  if (row && row.count > limit) {
    const retry = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
    throw new HttpError(429, `Demasiados intentos. Espera ${Math.ceil(retry / 60)} min y vuelve a intentar.`, 'limite', { 'Retry-After': String(retry) });
  }
}
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || 'local';

// ---------- validación ----------
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[<>"`]/g, '').trim().slice(0, max) : '');
const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = (e) => e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function checkPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (pw.length > 200) return 'La contraseña es demasiado larga.';
  if (new Set(pw.toLowerCase()).size < 4) return 'La contraseña repite demasiado los mismos caracteres.';
  const local = email.split('@')[0];
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'La contraseña no puede contener tu email.';
  if (['12345678', '123456789', 'password', 'contraseña', 'geospots', 'qwertyui'].includes(pw.toLowerCase())) return 'Esa contraseña es muy común.';
  return null;
}
async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Solicitud inválida.', 'json'); }
}

// Crear una empresa nueva (sin invitación) exige el código de alta (secreto SIGNUP_CODE), que va en el link de alta.
// OPEN_SIGNUP = "true" deja el registro abierto a cualquiera.
function canOpenSignup(env, code) {
  if (env.OPEN_SIGNUP === 'true') return true;
  const want = String(env.SIGNUP_CODE || '');
  return want.length >= 16 && typeof code === 'string' && safeEqual(code, want);
}

async function teamsOf(env, userId) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.name, m.role FROM members m JOIN teams t ON t.id = m.team_id
    WHERE m.user_id = ? ORDER BY m.created_at`).bind(userId).all();
  return results;
}

// ---------- invitaciones ----------
async function findInvite(env, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const inv = await env.DB.prepare(`SELECT i.*, t.name AS team_name FROM invites i JOIN teams t ON t.id = i.team_id
    WHERE i.token_hash = ?`).bind(await sha256(token)).first();
  if (!inv || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) return null;
  return inv;
}
async function joinTeam(env, inv, userId) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(inv.team_id, userId, inv.role, now),
    env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE token_hash = ?').bind(inv.token_hash),
  ]);
}

// ---------- archivos ----------
const fileKey = (teamId, id) => `t/${teamId}/f/${id}`;
async function deleteFiles(env, teamId, ids) {
  ids = [...new Set(ids)].filter((x) => typeof x === 'string' && x);
  if (!ids.length) return;
  await env.FILES.delete(ids.map((id) => fileKey(teamId, id)));
  const q = ids.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM files WHERE team_id = ? AND id IN (${q})`).bind(teamId, ...ids).run();
}
// Archivos que referencia un registro (para borrarlos de R2 cuando se borra o cambia el registro)
function filesOf(kind, data) {
  if (!data) return [];
  if (kind === 'pin') return Array.isArray(data.photoIds) ? data.photoIds : [];
  if (kind === 'map') return [data.imageId, data.thumbId].filter(Boolean);
  return [];
}

// ---------- rutas ----------
async function api(req, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const parts = path.split('/').slice(2); // ['auth','login'] ...

  // Las escrituras exigen una cabecera propia: otro sitio no puede mandarla sin permiso CORS (defensa extra a SameSite).
  if (method !== 'GET' && method !== 'HEAD' && req.headers.get('X-GeoSpots') !== '1') {
    throw new HttpError(403, 'Solicitud no permitida.', 'csrf');
  }

  if (path === '/api/health') return json({ ok: true, version: env.APP_VERSION });
  if (path === '/api/config' && method === 'GET') return json({ openSignup: env.OPEN_SIGNUP === 'true' });

  // --- cuenta ---
  if (path === '/api/auth/signup' && method === 'POST') {
    await enforceRate(env, 'signup:' + clientIp(req), 30, 60 * 60000); // solo con invitación o link de alta: se permite inscribir una cuadrilla desde el mismo wifi
    const b = await body(req);
    const email = normEmail(b.email), name = clean(b.name, 80), teamName = clean(b.team, 80);
    if (!validEmail(email)) throw new HttpError(400, 'Revisa el email.', 'email');
    if (!name) throw new HttpError(400, 'Escribe tu nombre.', 'nombre');
    const bad = checkPassword(b.password, email); if (bad) throw new HttpError(400, bad, 'password');
    let inv = null;
    if (b.invite) { inv = await findInvite(env, b.invite); if (!inv) throw new HttpError(400, 'La invitación venció o ya no es válida. Pide una nueva.', 'invitacion'); }
    else {
      if (!canOpenSignup(env, b.signupCode)) throw new HttpError(403, 'Para crear una cuenta necesitas una invitación. Pídele el link al administrador de tu empresa.', 'registro-cerrado');
      if (!teamName) throw new HttpError(400, 'Escribe el nombre de tu empresa o equipo.', 'equipo');
    }
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
      throw new HttpError(409, 'Ya existe una cuenta con ese email. Inicia sesión.', 'existe');
    }
    const salt = randomBytes(16), now = Date.now(), userId = newId('u');
    const hash = await pbkdf2(b.password, salt, PBKDF2_ITER);
    const stmts = [env.DB.prepare('INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, email, name, hash, b64url(salt), PBKDF2_ITER, now)];
    if (!inv) {
      const teamId = newId('t');
      stmts.push(env.DB.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(teamId, teamName, userId, now));
      stmts.push(env.DB.prepare('INSERT INTO members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(teamId, userId, 'admin', now));
    }
    await env.DB.batch(stmts);
    if (inv) await joinTeam(env, inv, userId);
    const token = await createSession(env, userId);
    return json({ user: { id: userId, email, name }, teams: await teamsOf(env, userId) }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    await enforceRate(env, 'login-ip:' + clientIp(req), 30, 15 * 60000);
    const b = await body(req);
    const email = normEmail(b.email);
    await enforceRate(env, 'login:' + email, 8, 15 * 60000);
    const u = validEmail(email) && await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    const ok = u && typeof b.password === 'string' && safeEqual(await pbkdf2(b.password, fromB64url(u.pw_salt), u.pw_iter), u.pw_hash);
    if (!ok) throw new HttpError(401, 'Email o contraseña incorrectos.', 'credenciales');
    if (b.invite) { const inv = await findInvite(env, b.invite); if (inv) await joinTeam(env, inv, u.id); }
    const token = await createSession(env, u.id);
    return json({ user: { id: u.id, email: u.email, name: u.name }, teams: await teamsOf(env, u.id) }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  // Contraseña nueva con un link de un solo uso (?reset=<token>)
  if (parts[0] === 'auth' && parts[1] === 'reset') {
    await enforceRate(env, 'reset-ip:' + clientIp(req), 20, 15 * 60000);
    const rb = method === 'POST' ? await body(req) : {};
    const token = method === 'GET' ? parts[2] : rb.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(400, 'Link inválido.', 'reset');
    const th = await sha256(token), now = Date.now();
    const row = await env.DB.prepare(`SELECT r.user_id, u.name, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`).bind(th, now).first();
    if (!row) throw new HttpError(400, 'Este link para cambiar la contraseña venció o ya se usó. Pide uno nuevo.', 'reset');
    if (method === 'GET') return json({ name: row.name, email: row.email });
    if (method === 'POST') {
      const b = rb;
      const bad = checkPassword(b.password, row.email); if (bad) throw new HttpError(400, bad, 'password');
      const salt = randomBytes(16);
      const hash = await pbkdf2(b.password, salt, PBKDF2_ITER);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?').bind(hash, b64url(salt), PBKDF2_ITER, row.user_id),
        env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').bind(now, th),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id), // se cierran las sesiones abiertas en otros teléfonos
      ]);
      const tok = await createSession(env, row.user_id);
      return json({ user: { id: row.user_id, email: row.email, name: row.name }, teams: await teamsOf(env, row.user_id) }, 200, { 'Set-Cookie': sessionCookie(tok) });
    }
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const u = await getUser(req, env);
    if (u) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(u.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/me' && method === 'GET') {
    const u = await getUser(req, env);
    if (!u) return json({ user: null, teams: [] });
    return json({ user: { id: u.id, email: u.email, name: u.name }, teams: await teamsOf(env, u.id) });
  }

  // --- invitaciones ---
  if (parts[0] === 'invites' && parts[1]) {
    await enforceRate(env, 'invite-ip:' + clientIp(req), 60, 15 * 60000);
    const inv = await findInvite(env, parts[1]);
    if (!inv) throw new HttpError(404, 'La invitación venció o ya no es válida. Pide una nueva.', 'invitacion');
    if (method === 'GET' && parts.length === 2) return json({ team: inv.team_name, role: inv.role });
    if (method === 'POST' && parts[2] === 'accept') {
      const u = await requireUser(req, env);
      await joinTeam(env, inv, u.id);
      return json({ teams: await teamsOf(env, u.id), teamId: inv.team_id });
    }
  }

  // --- equipo ---
  if (parts[0] === 'teams' && parts[1]) {
    const user = await requireUser(req, env);
    const teamId = parts[1];
    const role = await requireMember(env, user, teamId);
    const sub = parts[2];

    if (sub === 'members' && method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT u.id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ? ORDER BY m.created_at`).bind(teamId).all();
      return json({ members: results.map((m) => ({ ...m, me: m.id === user.id, email: role === 'admin' ? m.email : undefined })) });
    }

    if (sub === 'members' && parts[3] && method === 'DELETE') {
      if (role !== 'admin') throw new HttpError(403, 'Solo un administrador puede quitar miembros.', 'sin-acceso');
      const target = parts[3];
      if (target === user.id) throw new HttpError(400, 'No puedes quitarte a ti mismo.', 'propio');
      const m = await env.DB.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').bind(teamId, target).first();
      if (!m) throw new HttpError(404, 'Esa persona ya no está en el equipo.', 'no-existe');
      await env.DB.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?').bind(teamId, target).run();
      // Si ya no pertenece a ningún equipo, se cierran sus sesiones.
      const other = await env.DB.prepare('SELECT 1 FROM members WHERE user_id = ? LIMIT 1').bind(target).first();
      if (!other) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target).run();
      return json({ ok: true });
    }

    if (sub === 'invites' && method === 'POST') {
      if (role !== 'admin') throw new HttpError(403, 'Solo un administrador puede invitar.', 'sin-acceso');
      const b = await body(req);
      const r = b.role === 'admin' ? 'admin' : 'miembro';
      const token = randomToken(24), now = Date.now();
      await env.DB.prepare('INSERT INTO invites (token_hash, team_id, role, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .bind(await sha256(token), teamId, r, user.id, now, now + INVITE_MS).run();
      return json({ url: `${url.origin}/?invite=${token}`, expiresAt: new Date(now + INVITE_MS).toISOString(), role: r, uses: 1 });
    }

    // Cambios desde seq (paginado)
    if (sub === 'changes' && method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const { results } = await env.DB.prepare(`SELECT kind, id, data, updated_at, deleted, seq FROM records
        WHERE team_id = ? AND seq > ? ORDER BY seq LIMIT 500`).bind(teamId, since).all();
      return json({
        records: results.map((r) => ({ kind: r.kind, id: r.id, deleted: !!r.deleted, updatedAt: r.updated_at, seq: r.seq, data: r.data ? JSON.parse(r.data) : null })),
        seq: results.length ? results[results.length - 1].seq : since,
        more: results.length === 500,
      });
    }

    // Guardar o borrar un registro. Gana el cambio más reciente (updatedAt del teléfono).
    if (sub === 'records' && KINDS.has(parts[3]) && parts[4] && method === 'PUT') {
      const kind = parts[3], id = parts[4];
      if (id.length > 64) throw new HttpError(400, 'Id inválido.', 'id');
      const raw = await req.text();
      if (raw.length > MAX_RECORD) throw new HttpError(413, 'Registro demasiado grande.', 'grande');
      let b; try { b = JSON.parse(raw); } catch { throw new HttpError(400, 'Solicitud inválida.', 'json'); }
      const deleted = !!b.deleted;
      const updatedAt = Number(b.updatedAt) || Date.now();
      const data = deleted ? null : b.data;
      if (!deleted && (typeof data !== 'object' || !data)) throw new HttpError(400, 'Faltan datos.', 'datos');

      const prev = await env.DB.prepare('SELECT data, updated_at, deleted, author_id FROM records WHERE team_id = ? AND kind = ? AND id = ?')
        .bind(teamId, kind, id).first();
      if (kind === 'map' && deleted && prev && role !== 'admin' && prev.author_id !== user.id) {
        throw new HttpError(403, 'Solo quien subió el plano o un administrador puede borrarlo.', 'sin-acceso');
      }
      if (prev && prev.updated_at > updatedAt) return json({ ok: true, stale: true }); // ya hay un cambio más nuevo

      const row = await env.DB.prepare(`INSERT INTO records (team_id, kind, id, data, updated_at, deleted, author_id, seq)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records WHERE team_id = ?1))
        ON CONFLICT(team_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
          deleted = excluded.deleted, seq = excluded.seq
        WHERE excluded.updated_at >= records.updated_at
        RETURNING seq`).bind(teamId, kind, id, data ? JSON.stringify(data) : null, updatedAt, deleted ? 1 : 0, prev?.author_id || user.id).first();

      // Archivos que ya nadie usa (fotos quitadas, punto o plano borrado)
      if (prev?.data) {
        const keep = new Set(filesOf(kind, data));
        const gone = filesOf(kind, JSON.parse(prev.data)).filter((f) => !keep.has(f));
        if (gone.length) ctx.waitUntil(deleteFiles(env, teamId, gone));
      }
      return json({ ok: true, seq: row?.seq ?? null });
    }

    // Archivos: subir (cuerpo binario) y bajar
    if (sub === 'files' && parts[3]) {
      const id = parts[3];
      if (!/^[\w.-]{4,80}$/.test(id)) throw new HttpError(400, 'Id inválido.', 'id');
      const key = fileKey(teamId, id);
      if (method === 'PUT') {
        const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
        const size = Number(req.headers.get('Content-Length'));
        if (!FILE_TYPES.has(type)) throw new HttpError(415, 'Solo se aceptan imágenes JPEG, PNG o WebP.', 'tipo');
        if (!size || size > MAX_FILE) throw new HttpError(413, 'Archivo demasiado grande (máximo 60 MB).', 'grande');
        await env.FILES.put(key, req.body, { httpMetadata: { contentType: type } });
        await env.DB.prepare(`INSERT INTO files (team_id, id, r2_key, type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team_id, id) DO UPDATE SET type = excluded.type, size = excluded.size`)
          .bind(teamId, id, key, type, size, user.id, Date.now()).run();
        return json({ ok: true, id, size });
      }
      if (method === 'GET') {
        const obj = await env.FILES.get(key);
        if (!obj) throw new HttpError(404, 'Archivo no encontrado.', 'no-existe');
        return new Response(obj.body, { headers: {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        } });
      }
    }

    // Uso del equipo (cuánto ocupa)
    if (sub === 'usage' && method === 'GET') {
      const f = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE team_id = ?').bind(teamId).first();
      const r = await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM records WHERE team_id = ? AND deleted = 0 GROUP BY kind').bind(teamId).all();
      return json({ files: f.n, bytes: f.bytes, records: Object.fromEntries(r.results.map((x) => [x.kind, x.n])) });
    }
  }

  throw new HttpError(404, 'No encontrado.', 'no-existe');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status, e.headers);
      console.error(e);
      return json({ error: 'Error del servidor. Intenta de nuevo.', code: 'interno' }, 500);
    }
  },
};
