// Cuenta y sincronización con el servidor (Cloudflare Worker + D1 + R2).
// El teléfono sigue siendo la fuente principal: todo se guarda primero aquí y se envía cuando hay señal.
import { db } from './db.js';
import { setSyncAdapter, syncNow } from './inspect.js';

const LS = 'geospots.cloud';
const STORE = { map: 'maps', pin: 'pins', track: 'tracks' };
const KIND = { maps: 'map', pins: 'pin', tracks: 'track' };

let cfg = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch {} };

export const cloud = {
  available: null, // null = sin probar; false = esta copia de la app no tiene servidor
  get user() { return cfg.user || null; },
  get teams() { return cfg.teams || []; },
  get teamId() { return cfg.teamId || null; },
  get team() { return (cfg.teams || []).find((t) => t.id === cfg.teamId) || null; },
  get lastSync() { return cfg.lastSync || null; },
};

const listeners = new Set();
export const onCloudChange = (fn) => listeners.add(fn);
const emit = (what) => listeners.forEach((f) => f(what));

async function call(path, opts = {}) {
  const headers = { 'X-GeoSpots': '1', ...(opts.headers || {}) };
  let bodyv = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; bodyv = JSON.stringify(opts.json); }
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: bodyv, credentials: 'same-origin' });
  const isJson = (r.headers.get('Content-Type') || '').includes('json');
  const data = isJson ? await r.json().catch(() => null) : null;
  if (!r.ok || (!isJson && !opts.raw)) {
    const e = new Error(data?.error || (r.status === 404 && !isJson ? 'Sin servidor' : `Error ${r.status}`));
    e.status = r.status; e.code = data?.code || (!isJson ? 'sin-servidor' : 'error');
    if (r.status === 401 && cfg.user && !path.startsWith('/auth/')) { cfg.user = null; save(); setSyncAdapter(null); emit('session'); }
    throw e;
  }
  return opts.raw ? r : data;
}

function setAccount(res) {
  cfg.user = res.user;
  cfg.teams = res.teams || [];
  if (!cfg.teams.some((t) => t.id === cfg.teamId)) cfg.teamId = cfg.teams[0]?.id || null;
  cfg.seq = cfg.seq || {};
  save();
  setSyncAdapter(cfg.user && cfg.teamId ? adapter : null);
  emit('account');
}

// ---------- cuenta ----------
export async function refreshMe() {
  try {
    const res = await call('/me');
    cloud.available = true;
    if (!res.user && cfg.user) { cfg.user = null; save(); }
    if (res.user) setAccount(res); else { setSyncAdapter(null); emit('account'); }
  } catch (e) {
    if (e.code === 'sin-servidor') cloud.available = false;
    // Sin señal: se sigue con la cuenta guardada.
    else if (cfg.user && cfg.teamId) setSyncAdapter(adapter);
    emit('account');
  }
}

export async function signup({ name, email, password, team, invite, signupCode }) {
  const res = await call('/auth/signup', { method: 'POST', json: { name, email, password, team, invite, signupCode } });
  await adoptAccount(res);
}
export async function login({ email, password, invite }) {
  const res = await call('/auth/login', { method: 'POST', json: { email, password, invite } });
  await adoptAccount(res);
}
// Primer ingreso en este teléfono: lo que ya estaba guardado aquí se sube al equipo.
async function adoptAccount(res) {
  const firstTime = !cfg.teamId;
  setAccount(res);
  if (firstTime && cfg.teamId) await queueLocal();
  sync();
}
async function queueLocal() {
  const { enqueue } = await import('./inspect.js');
  for (const store of ['maps', 'pins', 'tracks']) {
    for (const r of await db.all(store)) if (!r.syncedAt) await enqueue(store, r.id);
  }
}

export async function logout() {
  try { await call('/auth/logout', { method: 'POST', json: {} }); } catch {}
  await wipeLocal();
  cfg = {}; save();
  setSyncAdapter(null);
  emit('logout');
}
export async function wipeLocal() {
  for (const s of ['maps', 'pins', 'tracks', 'photos', 'outbox']) for (const r of await db.all(s)) await db.del(s, r.id);
}

export async function switchTeam(teamId) {
  if (teamId === cfg.teamId) return;
  await wipeLocal();
  cfg.teamId = teamId; save();
  setSyncAdapter(adapter);
  emit('team');
  await sync();
}

export const inviteInfo = (token) => call(`/invites/${encodeURIComponent(token)}`);
export async function acceptInvite(token) {
  const res = await call(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', json: {} });
  cfg.teams = res.teams; save(); emit('account');
  return res.teamId;
}
export const createInvite = (role = 'miembro') => call(`/teams/${cfg.teamId}/invites`, { method: 'POST', json: { role } });
export const members = () => call(`/teams/${cfg.teamId}/members`);
export const removeMember = (userId) => call(`/teams/${cfg.teamId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE', json: {} });
export async function getConfig() { try { return await call('/config'); } catch { return { openSignup: false }; } }
export const usage = () => call(`/teams/${cfg.teamId}/usage`);

// ---------- envío ----------
async function upload(teamId, id, blob) {
  await call(`/teams/${teamId}/files/${encodeURIComponent(id)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg' } });
}
const ts = (r) => Date.parse(r?.updatedAt || r?.createdAt || '') || 0;

const adapter = {
  async push(item, rec) {
    const t = cfg.teamId;
    if (!t) throw new Error('Sin equipo');
    const kind = KIND[item.store];
    if (!kind) return;
    const url = `/teams/${t}/records/${kind}/${encodeURIComponent(item.recordId)}`;
    if (item.op === 'delete') { await call(url, { method: 'PUT', json: { deleted: true, updatedAt: Date.now() } }); return; }
    if (!rec) return; // se borró en el teléfono antes de enviarse
    let data;
    if (kind === 'map') {
      rec.imageId ||= `${rec.id}-img`;
      rec.thumbId ||= `${rec.id}-th`;
      rec.createdBy ||= cfg.user?.id;
      if (!rec.filesUploaded) {
        await upload(t, rec.imageId, rec.image);
        await upload(t, rec.thumbId, rec.thumb);
        rec.filesUploaded = true;
        await db.put('maps', rec);
      }
      const { image, thumb, syncedAt, filesUploaded, ...rest } = rec;
      data = rest;
    } else {
      if (kind === 'pin') {
        for (const pid of rec.photoIds || []) {
          const ph = await db.get('photos', pid);
          if (ph && !ph.uploadedAt) { await upload(t, pid, ph.blob); await db.put('photos', { ...ph, uploadedAt: new Date().toISOString() }); }
        }
      }
      const { syncedAt, ...rest } = rec;
      data = rest;
    }
    await call(url, { method: 'PUT', json: { data, updatedAt: ts(rec) || Date.now() } });
  },
};

// ---------- recepción ----------
async function download(teamId, id) {
  const r = await call(`/teams/${teamId}/files/${encodeURIComponent(id)}`, { raw: true });
  return r.blob();
}
async function removeLocal(store, id) {
  if (store === 'pins') for (const ph of await db.byIndex('photos', 'pointId', id)) await db.del('photos', ph.id);
  await db.del(store, id);
}

async function pull() {
  const t = cfg.teamId;
  cfg.seq = cfg.seq || {};
  let since = cfg.seq[t] || 0, changed = false, more = true;
  const pending = new Set((await db.all('outbox')).map((o) => o.id));
  while (more) {
    const r = await call(`/teams/${t}/changes?since=${since}`);
    for (const rec of r.records) {
      const store = STORE[rec.kind];
      if (!store || pending.has(`${store}:${rec.id}`)) continue; // hay un cambio local por enviar: gana ese
      if (rec.deleted) { if (await db.get(store, rec.id)) { await removeLocal(store, rec.id); changed = true; } continue; }
      const local = await db.get(store, rec.id);
      if (local && ts(local) > rec.updatedAt) continue;
      const now = new Date().toISOString();
      try {
        if (rec.kind === 'map') {
          const image = local?.image || await download(t, rec.data.imageId);
          const thumb = local?.thumb || await download(t, rec.data.thumbId);
          await db.put('maps', { ...rec.data, image, thumb, filesUploaded: true, syncedAt: now });
        } else if (rec.kind === 'pin') {
          for (const pid of rec.data.photoIds || []) {
            if (await db.get('photos', pid)) continue;
            try { await db.put('photos', { id: pid, pointId: rec.id, blob: await download(t, pid), createdAt: now, uploadedAt: now }); }
            catch (e) { if (e.status !== 404) throw e; }
          }
          // Fotos que se quitaron en otro teléfono
          for (const ph of await db.byIndex('photos', 'pointId', rec.id)) if (!(rec.data.photoIds || []).includes(ph.id)) await db.del('photos', ph.id);
          await db.put('pins', { ...rec.data, syncedAt: now });
        } else {
          await db.put(store, { ...rec.data, syncedAt: now });
        }
        changed = true;
      } catch (e) {
        if (e.status === 404) { console.warn('Archivo faltante', rec.kind, rec.id); continue; }
        throw e;
      }
    }
    since = r.seq; cfg.seq[t] = since; save();
    more = r.more;
  }
  return changed;
}

// Un administrador quitó a esta persona del equipo: se borra lo local de ese equipo.
async function lostAccess() {
  const lost = cloud.team?.name || 'el equipo';
  const before = cfg.teamId;
  await refreshMe();
  if (cfg.user && cfg.teamId === before && (cfg.teams || []).some((t) => t.id === before)) return; // sigue en el equipo
  await wipeLocal();
  if (cfg.seq) delete cfg.seq[before];
  save();
  emit({ type: 'removed', team: lost });
}

let running = null;
export function sync() {
  if (running) return running;
  running = (async () => {
    if (!cfg.user || !cfg.teamId) return { ok: false, reason: 'sin-cuenta' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };
    const pushed = await syncNow();
    let changed = false;
    try { changed = await pull(); } catch (e) {
      if (e.status === 403 || e.status === 401) { await lostAccess(); return { ok: false, reason: 'sin-acceso', error: e.message }; }
      return { ok: false, reason: 'error', error: e.message, sent: pushed.sent };
    }
    cfg.lastSync = new Date().toISOString(); save();
    if (changed) emit('data');
    emit('synced');
    return { ok: pushed.ok !== false, sent: pushed.sent || 0, received: changed, reason: pushed.reason, error: pushed.error };
  })().finally(() => { running = null; });
  return running;
}

// Sincronizar al volver la señal, al volver a la app y cada minuto mientras está abierta.
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);
