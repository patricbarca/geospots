// IndexedDB: planos, puntos (pins), fotos, recorridos y la cola de envío quedan en el teléfono.
const DB_NAME = 'geoplano';
const VERSION = 2;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['maps', 'pins', 'tracks', 'outbox']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('pointId', 'pointId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  });
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  count: (store) => tx(store, 'readonly', (s) => s.count()),
  byIndex: (store, index, key) => tx(store, 'readonly', (s) => s.index(index).getAll(key)),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
