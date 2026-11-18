// Modo inspección: tipos de punto, fotos y cola de envío (sincronización cuando haya conexión).
import { db } from './db.js';

// Lista base. Se puede cambiar por la lista real de terreno.
export const TYPES = {
  defecto: {
    label: 'Defecto', color: '#ff5c35',
    categories: ['Módulo dañado / quebrado', 'Hot spot', 'Cableado expuesto o suelto', 'Conector / caja de conexión', 'Estructura / hincado',
      'Tracker / motor', 'Inversor / centro de transformación', 'Vegetación', 'Drenaje / erosión', 'Cerco / acceso / camino', 'Otro'],
    severity: true,
  },
  evento: {
    label: 'Evento', color: '#f5a524',
    categories: ['Incidente de seguridad', 'Casi accidente', 'Daño por clima', 'Fauna', 'Visita / inspección', 'Avance de obra', 'Otro'],
    severity: true,
  },
  nota: { label: 'Nota', color: '#2f9bff', categories: [], severity: false },
};
export const SEVERITIES = { baja: 'Baja', media: 'Media', alta: 'Alta' };
export const STATUSES = { abierto: 'Abierto', resuelto: 'Resuelto' };

/** Completa campos de puntos antiguos (pines de la versión anterior). */
export function normalizePoint(p) {
  return {
    type: 'nota', category: '', severity: 'media', status: 'abierto', assignee: '', author: '', note: '', photoIds: [],
    updatedAt: p.createdAt, ...p,
  };
}

/** Reduce la foto (máx. 1600 px, JPEG) para ahorrar espacio y datos. */
export async function compressPhoto(file, max = 1600, quality = 0.8) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bmp || (await loadImg(file));
  const w0 = src.width, h0 = src.height;
  const s = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  bmp?.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  c.width = c.height = 0;
  return blob;
}
function loadImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la foto')); };
    img.src = url;
  });
}

// ---------- cola de envío ----------
/** Marca un registro como pendiente de subir. Varias ediciones del mismo registro quedan como una sola. */
export async function enqueue(store, recordId, op = 'upsert') {
  await db.put('outbox', { id: `${store}:${recordId}`, store, recordId, op, at: new Date().toISOString(), tries: 0 });
  notify();
}
export const pendingCount = () => db.count('outbox');

const listeners = new Set();
export function onQueueChange(fn) { listeners.add(fn); }
async function notify() { const n = await pendingCount(); listeners.forEach((f) => f(n)); }

/** Servidor de sincronización: lo configura cloud.js al iniciar sesión (sin cuenta, todo queda en el teléfono). */
let adapter = null;
export function setSyncAdapter(a) { adapter = a; }

let syncing = false;
export async function syncNow() {
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  if (!adapter) return { ok: false, reason: 'sin-servidor' };
  if (syncing) return { ok: false, reason: 'en-curso' };
  syncing = true;
  let sent = 0, dropped = 0, error = null;
  try {
    const items = (await db.all('outbox')).sort((a, b) => a.at.localeCompare(b.at));
    for (const it of items) {
      try {
        const rec = it.op === 'delete' ? null : await db.get(it.store, it.recordId);
        await adapter.push(it, rec);
        await db.del('outbox', it.id);
        if (rec) await db.put(it.store, { ...rec, syncedAt: new Date().toISOString() });
        sent++;
      } catch (e) {
        error = String(e.message || e);
        // El servidor lo rechazó (permiso, datos inválidos): se descarta para no trabar la cola.
        if (e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) {
          await db.del('outbox', it.id); dropped++; continue;
        }
        await db.put('outbox', { ...it, tries: it.tries + 1, error });
        break; // se reintenta la próxima vez, en el mismo orden
      }
    }
  } finally { syncing = false; notify(); }
  return { ok: !error || dropped > 0, sent, dropped, error };
}

