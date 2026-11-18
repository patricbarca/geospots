// GeoPlano: planos GeoPDF sobre el mapa con GPS, pines y recorridos.
import { db, uid } from './db.js';
import { importPdf } from './importer.js';
import { makeProj, utmFor, distM, lineLengthM, insideOrDistance, fmtDist } from './geo.js';
import { TYPES, SEVERITIES, STATUSES, normalizePoint, compressPhoto, enqueue, pendingCount, onQueueChange, syncNow } from './inspect.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- preferencias (solo comodidad, en este navegador) ----------
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('geoplano.prefs') || '{}'); } catch {}
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('geoplano.prefs', JSON.stringify(p)); } catch {} },
  };
})();

const state = {
  maps: [], active: null, activeUrl: null, proj: null,
  base: prefs.get('base', 'osm'),
  pos: null, watchId: null, follow: false,
  recording: false, rec: [], wakeLock: null,
  pins: [], tracks: [], markers: new Map(),
};

// ---------- mapa ----------
const map = new maplibregl.Map({
  container: 'map',
  center: prefs.get('center', [0, 15]),
  zoom: prefs.get('zoom', 1.5),
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19,
        attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics' },
      tracks: { type: 'geojson', data: fc([]) },
      rec: { type: 'geojson', data: fc([]) },
      me: { type: 'geojson', data: fc([]) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe5ea' } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: state.base === 'osm' ? 'visible' : 'none' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: state.base === 'sat' ? 'visible' : 'none' } },
      { id: 'tracks-line', type: 'line', source: 'tracks', paint: { 'line-color': '#7b3fe4', 'line-width': 4, 'line-opacity': 0.9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
      { id: 'rec-line', type: 'line', source: 'rec', paint: { 'line-color': '#ff5c35', 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
      { id: 'me-acc', type: 'fill', source: 'me', filter: ['==', ['get', 'k'], 'acc'], paint: { 'fill-color': '#2f9bff', 'fill-opacity': 0.15 } },
      { id: 'me-acc-line', type: 'line', source: 'me', filter: ['==', ['get', 'k'], 'acc'], paint: { 'line-color': '#2f9bff', 'line-width': 1, 'line-opacity': 0.6 } },
      { id: 'me-halo', type: 'circle', source: 'me', filter: ['==', ['get', 'k'], 'pt'], paint: { 'circle-radius': 11, 'circle-color': '#fff' } },
      { id: 'me-dot', type: 'circle', source: 'me', filter: ['==', ['get', 'k'], 'pt'], paint: { 'circle-radius': 7.5, 'circle-color': '#2f9bff' } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showZoom: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.touchPitch.disable();
map.dragRotate.disable();

function fc(features) { return { type: 'FeatureCollection', features }; }

// Listo apenas carga el estilo (sin esperar las teselas: sin conexión no llegarían).
const ready = new Promise((r) => {
  const check = () => { if (map.isStyleLoaded()) { map.off('styledata', check); r(); } };
  map.on('styledata', check);
  map.on('load', r);
});

map.on('moveend', () => {
  const c = map.getCenter();
  prefs.set('center', [c.lng, c.lat]);
  prefs.set('zoom', map.getZoom());
});
map.on('move', updateCenterLine);
map.on('dragstart', () => setFollow(false));

// ---------- planos ----------
async function loadMaps() {
  state.maps = (await db.all('maps')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderMapList();
}

async function activateMap(id, fit = true) {
  await ready;
  if (map.getLayer('plano')) map.removeLayer('plano');
  if (map.getSource('plano')) map.removeSource('plano');
  if (state.activeUrl) URL.revokeObjectURL(state.activeUrl);
  state.active = null; state.activeUrl = null; state.proj = null;

  const m = id && state.maps.find((x) => x.id === id);
  if (m) {
    state.active = m;
    state.activeUrl = URL.createObjectURL(m.image);
    state.proj = makeProj(m.epsg, m.wkt);
    map.addSource('plano', { type: 'image', url: state.activeUrl, coordinates: m.corners });
    map.addLayer({ id: 'plano', type: 'raster', source: 'plano', paint: { 'raster-opacity': prefs.get('opacity', 100) / 100, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, 'tracks-line');
    if (fit) {
      const lons = m.corners.map((c) => c[0]), lats = m.corners.map((c) => c[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, duration: 600 });
    }
  }
  prefs.set('activeMap', m ? m.id : null);
  $('#activeName').textContent = m ? m.name : 'Sin plano';
  $('#opacityWrap').hidden = !m;
  $('#opacity').value = prefs.get('opacity', 100);
  renderMapList();
  updateGpsLine();
  updateCenterLine();
}

$('#opacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  prefs.set('opacity', v);
  if (map.getLayer('plano')) map.setPaintProperty('plano', 'raster-opacity', v / 100);
});

function renderMapList() {
  const ul = $('#mapList');
  if (!state.maps.length) { ul.innerHTML = '<li class="empty">Aún no hay planos. Importa un GeoPDF para empezar.</li>'; return; }
  ul.innerHTML = '';
  for (const m of state.maps) {
    const li = document.createElement('li');
    if (state.active?.id === m.id) li.className = 'active';
    const thumb = URL.createObjectURL(m.thumb);
    const prec = m.precisionM ? ` · ±${Math.max(1, Math.round(m.precisionM))} m` : '';
    li.innerHTML = `<img alt="" src="${thumb}"><div class="meta"><b>${esc(m.name)}</b>
      <small>${m.epsg ? 'EPSG:' + m.epsg : 'Geográficas'} · ${m.points} puntos${prec}</small></div>
      <div class="acts"><button data-open>${state.active?.id === m.id ? 'Ver' : 'Abrir'}</button><button class="del" data-del aria-label="Borrar">✕</button></div>`;
    li.querySelector('img').onload = () => URL.revokeObjectURL(thumb);
    li.querySelector('[data-open]').onclick = () => { activateMap(m.id); closeSheets(); };
    li.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmBox('Borrar plano', `¿Borrar "${m.name}" de este teléfono?`, 'Borrar'))) return;
      await db.del('maps', m.id);
      if (state.active?.id === m.id) await activateMap(null, false);
      await loadMaps();
    };
    ul.appendChild(li);
  }
}

async function handleFiles(files) {
  let last;
  for (const f of files) {
    try {
      busy(`Leyendo ${f.name}…`);
      const saved = await importPdf(await f.arrayBuffer(), f.name, busy);
      last = saved[saved.length - 1];
      toast(`Plano importado: ${saved.map((s) => s.name).join(', ')}`);
    } catch (e) {
      console.error(e);
      toast(e.code === 'NO_GEO' ? e.message : `No se pudo importar ${f.name}: ${e.message}`, 6000);
    } finally { busy(null); }
  }
  await loadMaps();
  if (last) { await activateMap(last.id); closeSheets(); }
}

$('#btnImport').onclick = () => $('#file').click();
$('#file').onchange = (e) => { handleFiles([...e.target.files]); e.target.value = ''; };
// Arrastrar y soltar en escritorio
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (files.length) handleFiles(files);
});

// ---------- mapa base ----------
$('#btnBase').onclick = async () => {
  await ready;
  state.base = state.base === 'osm' ? 'sat' : 'osm';
  prefs.set('base', state.base);
  map.setLayoutProperty('osm', 'visibility', state.base === 'osm' ? 'visible' : 'none');
  map.setLayoutProperty('sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
  toast(state.base === 'sat' ? 'Mapa base: satélite' : 'Mapa base: calles');
};

// ---------- GPS ----------
function startGps() {
  if (state.watchId != null) return;
  if (!('geolocation' in navigator)) { toast('Este navegador no tiene GPS'); return; }
  $('#gpsLine').innerHTML = 'Buscando señal GPS…';
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function onGpsError(err) {
  const msg = err.code === 1 ? 'Permiso de ubicación denegado. Actívalo en los ajustes del navegador.' : 'Sin señal GPS todavía…';
  $('#gpsLine').innerHTML = `<span class="warn">${msg}</span>`;
  if (err.code === 1) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
}

async function onPosition(p) {
  const { longitude: lon, latitude: lat, accuracy, heading } = p.coords;
  const first = !state.pos;
  state.pos = { lon, lat, accuracy, heading, t: p.timestamp };
  await ready;
  map.getSource('me').setData(fc([
    { type: 'Feature', properties: { k: 'acc' }, geometry: circle([lon, lat], accuracy) },
    { type: 'Feature', properties: { k: 'pt' }, geometry: { type: 'Point', coordinates: [lon, lat] } },
  ]));
  if (state.follow || first) map.easeTo({ center: [lon, lat], zoom: first ? Math.max(map.getZoom(), 16) : map.getZoom(), duration: first ? 800 : 300 });
  if (state.recording && accuracy <= 35) {
    const last = state.rec[state.rec.length - 1];
    if (!last || distM(last, [lon, lat]) >= Math.max(3, accuracy / 3)) {
      state.rec.push([lon, lat]);
      map.getSource('rec').setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: state.rec } }]));
    }
  }
  updateGpsLine();
}

function circle([lon, lat], r, n = 48) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540, ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lon + (Math.cos(a) * r) / kx, lat + (Math.sin(a) * r) / ky]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function fmtEN(lon, lat) {
  const pr = state.proj || utmFor(lon, lat);
  if (!pr) return '';
  const [e, n] = pr.fwd([lon, lat]);
  const f = (v) => Math.round(v).toLocaleString('es-CL');
  return `E ${f(e)} · N ${f(n)} <small>${esc(pr.label)}</small>`;
}

function updateGpsLine() {
  const el = $('#gpsLine');
  if (!state.pos) return;
  const { lon, lat, accuracy } = state.pos;
  let where = '';
  if (state.active) {
    const r = insideOrDistance([lon, lat], state.active.corners);
    where = r.inside ? ' · <span class="good">en el plano</span>' : ` · <span class="warn">a ${fmtDist(r.dist)} del plano</span>`;
  }
  const rec = state.recording ? ` · ⏺ ${fmtDist(lineLengthM(state.rec))}` : '';
  el.innerHTML = `<b>${lat.toFixed(6)}, ${lon.toFixed(6)}</b> <small>±${Math.round(accuracy)} m</small>${where}${rec}<br>${fmtEN(lon, lat)}`;
}

function updateCenterLine() {
  if (state.follow) { $('#centerLine').textContent = ''; return; }
  const c = map.getCenter();
  $('#centerLine').innerHTML = `Mira: ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)} · ${fmtEN(c.lng, c.lat)}`;
}

function setFollow(on) {
  state.follow = on;
  document.body.classList.toggle('following', on);
  $('#btnLocate').classList.toggle('on', on);
  updateCenterLine();
}

$('#btnLocate').onclick = () => {
  startGps();
  setFollow(!state.follow || !state.pos);
  if (state.pos) map.easeTo({ center: [state.pos.lon, state.pos.lat], zoom: Math.max(map.getZoom(), 16) });
};

// ---------- puntos (defectos, eventos, notas) ----------
const pinSvg = (color) => `<svg viewBox="0 0 26 34"><path d="M13 33s11-10 11-19.5A11 11 0 0 0 2 13.5C2 23 13 33 13 33Z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4" fill="#fff"/></svg>`;
const filters = { types: new Set(prefs.get('fTypes', Object.keys(TYPES))), openOnly: prefs.get('fOpen', false) };
const visible = (p) => filters.types.has(p.type) && (!filters.openOnly || p.status !== 'resuelto');

async function loadPins() {
  state.pins = (await db.all('pins')).map(normalizePoint);
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  for (const p of state.pins) if (visible(p)) addMarker(p);
  renderFilters();
  renderPinList();
}

function addMarker(p) {
  const t = TYPES[p.type] || TYPES.nota;
  const el = document.createElement('div');
  el.className = `pin-marker ${p.status}`;
  el.innerHTML = pinSvg(p.status === 'resuelto' ? '#1f7a52' : t.color) + `<span class="pin-label">${esc(p.name)}</span>`;
  const popup = new maplibregl.Popup({ offset: 30, closeButton: true, maxWidth: '280px' });
  popup.on('open', async () => {
    const d = state.pos ? ` · a ${fmtDist(distM([state.pos.lon, state.pos.lat], p.coords))} de ti` : '';
    const sev = t.severity ? `<span class="tag ${p.severity}">${SEVERITIES[p.severity]}</span>` : '';
    const st = p.status === 'resuelto' ? '<span class="tag ok">Resuelto</span>' : '';
    popup.setHTML(`<div class="popup"><b>${esc(p.name)}</b>
      <small>${sev}${st}${esc(t.label)}${p.category ? ' · ' + esc(p.category) : ''}</small>
      ${p.note ? `<small>${esc(p.note)}</small>` : ''}
      <small>${fmtEN(p.coords[0], p.coords[1])}${d}</small>
      <div class="thumbs" data-thumbs></div>
      <div class="acts"><button class="edit" data-edit-pin="${p.id}">Editar</button></div></div>`);
    const box = popup.getElement()?.querySelector('[data-thumbs]');
    if (box && p.photoIds.length) {
      for (const ph of await db.byIndex('photos', 'pointId', p.id)) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(ph.blob);
        img.onclick = () => viewPhoto(ph.blob);
        box.appendChild(img);
      }
    }
  });
  const mk = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(p.coords).setPopup(popup).addTo(map);
  state.markers.set(p.id, mk);
}

function viewPhoto(blob) {
  const v = document.createElement('div');
  v.className = 'viewer';
  const url = URL.createObjectURL(blob);
  v.innerHTML = `<img alt="Foto" src="${url}">`;
  v.onclick = () => { URL.revokeObjectURL(url); v.remove(); };
  document.body.appendChild(v);
}

document.addEventListener('click', (e) => {
  const id = e.target?.dataset?.editPin;
  if (!id) return;
  for (const m of state.markers.values()) if (m.getPopup()?.isOpen()) m.togglePopup();
  openPointEditor(state.pins.find((p) => p.id === id));
});

// --- ubicar un punto nuevo: tocar el mapa, usar el GPS o la cruz ---
let pickMarker = null;
function showPick(coords) {
  if (!pickMarker) {
    const el = document.createElement('div');
    el.className = 'pick-marker';
    el.innerHTML = pinSvg('#ff5c35');
    pickMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
  }
  pickMarker.setLngLat(coords).addTo(map);
}
function hidePick() { pickMarker?.remove(); }
const gpsOk = () => state.pos && state.pos.accuracy <= 100;

function startPlacing() {
  closeSheets();
  setFollow(false);
  state.placing = true;
  document.body.classList.add('placing');
  $('#placeBar').hidden = false;
  $('#placeGps').disabled = !gpsOk();
  $('#placeGps').textContent = gpsOk() ? `Usar mi GPS (±${Math.round(state.pos.accuracy)} m)` : 'GPS sin señal';
}
function stopPlacing() {
  state.placing = false;
  document.body.classList.remove('placing');
  $('#placeBar').hidden = true;
}
async function placeAt(coords, accuracy = null) {
  stopPlacing();
  await openPointEditor(null, { coords, accuracy });
  showPick(coords);
}
$('#btnPin').onclick = () => (state.placing ? stopPlacing() : startPlacing());
$('#placeCancel').onclick = stopPlacing;
$('#placeCenter').onclick = () => { const c = map.getCenter(); placeAt([c.lng, c.lat]); };
$('#placeGps').onclick = () => { if (gpsOk()) placeAt([state.pos.lon, state.pos.lat], Math.round(state.pos.accuracy)); };


// --- editor de punto ---
const editor = { point: null, photos: [], removed: [] }; // photos: [{id, blob, isNew}]

function radios(el, name, options, value, colors = {}) {
  el.innerHTML = Object.entries(options).map(([k, label]) =>
    `<label style="${colors[k] ? `--c:${colors[k]}` : ''}"><input type="radio" name="${name}" value="${k}" ${k === value ? 'checked' : ''}>${esc(label)}</label>`).join('');
}

function fillCategories(type, value) {
  const cats = TYPES[type].categories;
  $('#catWrap').hidden = !cats.length;
  $('#sevWrap').hidden = !TYPES[type].severity;
  $('#pCat').innerHTML = cats.map((c) => `<option ${c === value ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

async function openPointEditor(point, place = null) {
  const isNew = !point;
  const type = point?.type || prefs.get('lastType', 'defecto');
  editor.point = point;
  editor.place = place;
  editor.removed = [];
  editor.photos = isNew ? [] : (await db.byIndex('photos', 'pointId', point.id)).map((ph) => ({ id: ph.id, blob: ph.blob, isNew: false }));
  $('#pointTitle').textContent = isNew ? 'Nuevo punto' : 'Editar punto';
  radios($('#typeSeg'), 'type', Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.label])), type,
    Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.color])));
  fillCategories(type, point?.category);
  radios($('#sevSeg'), 'severity', SEVERITIES, point?.severity || 'media', { baja: '#4a5a68', media: '#a86a00', alta: '#c0392b' });
  radios($('#statusSeg'), 'status', STATUSES, point?.status || 'abierto', { abierto: '#2f9bff', resuelto: '#1f7a52' });
  const f = $('#pointForm');
  f.name.value = point?.name || `${TYPES[type].label} ${state.pins.filter((p) => p.type === type).length + 1}`;
  f.assignee.value = point?.assignee || '';
  f.note.value = point?.note || '';
  f.author.value = point?.author || prefs.get('author', '');
  $('#whereWrap').hidden = !isNew;
  if (isNew) {
    const [lon, lat] = place.coords;
    let txt = place.accuracy != null ? `Tu posición GPS ±${place.accuracy} m` : 'Donde marcaste en el mapa';
    if (state.active) {
      const r = insideOrDistance([lon, lat], state.active.corners);
      txt += r.inside ? ' · en el plano' : ` · ⚠ a ${fmtDist(r.dist)} del plano`;
    }
    $('#whereSeg').innerHTML = `<small>${esc(txt)}<br>${fmtEN(lon, lat)}</small>`;
  }
  $('#pointMeta').textContent = isNew ? '' : `Creado ${new Date(point.createdAt).toLocaleString('es-CL')}${point.author ? ' por ' + point.author : ''} · ${point.syncedAt ? 'enviado ✓' : 'pendiente de envío'}`;
  $('#btnDelPoint').hidden = isNew;
  renderPhotos();
  openSheet('#sheetPoint');
}

$('#typeSeg').addEventListener('change', (e) => {
  const t = e.target.value;
  fillCategories(t);
  const f = $('#pointForm');
  if (!editor.point && /^(Defecto|Evento|Nota) \d+$/.test(f.name.value)) f.name.value = `${TYPES[t].label} ${state.pins.filter((p) => p.type === t).length + 1}`;
});

function renderPhotos() {
  const g = $('#photoGrid');
  g.innerHTML = '';
  editor.photos.forEach((ph, i) => {
    const d = document.createElement('div');
    d.className = 'ph';
    const url = URL.createObjectURL(ph.blob);
    d.innerHTML = `<img alt="Foto ${i + 1}" src="${url}"><button type="button" aria-label="Quitar foto">✕</button>`;
    d.querySelector('img').onclick = () => viewPhoto(ph.blob);
    d.querySelector('button').onclick = () => { if (!ph.isNew) editor.removed.push(ph.id); editor.photos.splice(i, 1); renderPhotos(); };
    g.appendChild(d);
  });
}

async function addPhotos(files) {
  for (const file of files) {
    try {
      busy('Procesando foto…');
      editor.photos.push({ id: uid(), blob: await compressPhoto(file), isNew: true });
    } catch (e) { toast(e.message); } finally { busy(null); }
  }
  renderPhotos();
}
$('#btnCamera').onclick = () => $('#cameraInput').click();
$('#btnGallery').onclick = () => $('#galleryInput').click();
for (const id of ['#cameraInput', '#galleryInput']) $(id).onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };

$('#pointForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const now = new Date().toISOString();
  const old = editor.point;
  let coords = old?.coords, accuracy = old?.accuracy ?? null;
  if (!old) ({ coords, accuracy } = editor.place);
  try {
  const id = old?.id || uid();
  for (const pid of editor.removed) await db.del('photos', pid);
  for (const ph of editor.photos.filter((x) => x.isNew)) await db.put('photos', { id: ph.id, pointId: id, blob: ph.blob, createdAt: now });
  const point = {
    ...(old || {}), id,
    type: fd.type, category: TYPES[fd.type].categories.length ? fd.category : '',
    name: fd.name.trim() || TYPES[fd.type].label, severity: fd.severity || 'media', status: fd.status,
    assignee: fd.assignee.trim(), note: fd.note.trim(), author: fd.author.trim(),
    coords, accuracy, photoIds: editor.photos.map((x) => x.id),
    mapId: old?.mapId ?? state.active?.id ?? null, mapName: old?.mapName ?? state.active?.name ?? null,
    createdAt: old?.createdAt || now, updatedAt: now, syncedAt: null,
  };
  await db.put('pins', point);
  await enqueue('pins', id);
  prefs.set('author', point.author);
  prefs.set('lastType', point.type);
  if (!filters.types.has(point.type)) { filters.types.add(point.type); prefs.set('fTypes', [...filters.types]); }
  if (filters.openOnly && point.status === 'resuelto') { filters.openOnly = false; prefs.set('fOpen', false); }
  closeSheets();
  await loadPins();
  if (!map.getBounds().contains(point.coords)) map.easeTo({ center: point.coords });
  toast(`Guardado en el teléfono: ${point.name}`);
  } catch (err) {
    console.error(err);
    toast('No se pudo guardar: ' + (err?.message || err), 6000);
  }
};

$('#btnDelPoint').onclick = async () => {
  const p = editor.point;
  if (!p || !(await confirmBox('Borrar punto', `¿Borrar "${p.name}" y sus fotos?`, 'Borrar'))) return;
  for (const ph of await db.byIndex('photos', 'pointId', p.id)) await db.del('photos', ph.id);
  await db.del('pins', p.id);
  await enqueue('pins', p.id, 'delete');
  closeSheets();
  await loadPins();
};

// --- filtros y lista ---
function renderFilters() {
  const box = $('#filters');
  box.innerHTML = '';
  for (const [k, t] of Object.entries(TYPES)) {
    const n = state.pins.filter((p) => p.type === k).length;
    const b = document.createElement('button');
    b.className = filters.types.has(k) ? 'on' : '';
    b.style.setProperty('--c', t.color);
    b.textContent = `${t.label}s (${n})`;
    b.onclick = () => { filters.types.has(k) ? filters.types.delete(k) : filters.types.add(k); prefs.set('fTypes', [...filters.types]); loadPins(); };
    box.appendChild(b);
  }
  const o = document.createElement('button');
  o.className = filters.openOnly ? 'on' : '';
  o.textContent = 'Solo abiertos';
  o.onclick = () => { filters.openOnly = !filters.openOnly; prefs.set('fOpen', filters.openOnly); loadPins(); };
  box.appendChild(o);
}

function renderPinList() {
  const ul = $('#pinList');
  const list = state.pins.filter(visible).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('#pointsHead').textContent = `Puntos (${list.length}${list.length !== state.pins.length ? ' de ' + state.pins.length : ''})`;
  if (!list.length) { ul.innerHTML = '<li class="empty">Sin puntos. Usa el botón naranjo del pin para registrar un defecto, evento o nota.</li>'; return; }
  ul.innerHTML = '';
  for (const p of list) {
    const t = TYPES[p.type] || TYPES.nota;
    const li = document.createElement('li');
    const sev = t.severity ? `<span class="tag ${p.severity}">${SEVERITIES[p.severity]}</span>` : '';
    const st = p.status === 'resuelto' ? '<span class="tag ok">Resuelto</span>' : '';
    li.innerHTML = `<span class="dot" style="background:${p.status === 'resuelto' ? '#1f7a52' : t.color}"></span>
      <div class="meta"><b>${esc(p.name)}</b><small>${sev}${st}${esc(p.category || t.label)}${p.photoIds.length ? ` · 📷 ${p.photoIds.length}` : ''}${p.syncedAt ? '' : ' · ⏳'}</small></div>
      <div class="acts"><button data-go>Ir</button><button data-edit>Editar</button></div>`;
    li.querySelector('[data-go]').onclick = () => { setFollow(false); closeSheets(); map.flyTo({ center: p.coords, zoom: Math.max(map.getZoom(), 17) }); };
    li.querySelector('[data-edit]').onclick = () => openPointEditor(p);
    ul.appendChild(li);
  }
}

// --- estado de envío ---
async function updateSyncBadge(n) {
  if (n == null) n = await pendingCount();
  const b = $('#btnSync');
  b.classList.toggle('pending', n > 0);
  $('#syncText').textContent = n > 0 ? `⏳ ${n} pendiente${n === 1 ? '' : 's'}` : '✓ Al día';
}
onQueueChange(updateSyncBadge);
$('#btnSync').onclick = async () => {
  const r = await syncNow();
  if (r.reason === 'offline') toast('Sin conexión. Todo queda guardado en el teléfono y se enviará al volver la señal.', 5000);
  else if (r.reason === 'sin-servidor') toast('Versión de prueba: los datos quedan guardados en este teléfono. El envío al servidor se conecta en el siguiente paso.', 6000);
  else if (r.ok) toast(r.sent ? `Enviados ${r.sent}` : 'Todo al día');
};

// ---------- recorridos ----------
async function loadTracks() {
  state.tracks = await db.all('tracks');
  await ready;
  map.getSource('tracks').setData(fc(state.tracks.map((t) => ({ type: 'Feature', properties: { name: t.name }, geometry: { type: 'LineString', coordinates: t.coords } }))));
  renderTrackList();
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.recording) keepAwake(true); });

$('#btnRec').onclick = async () => {
  if (!state.recording) {
    startGps();
    state.recording = true; state.rec = [];
    if (state.pos && state.pos.accuracy <= 35) state.rec.push([state.pos.lon, state.pos.lat]);
    $('#btnRec').classList.add('on');
    keepAwake(true);
    toast('Grabando recorrido. Deja la pantalla encendida.');
    updateGpsLine();
    return;
  }
  state.recording = false;
  $('#btnRec').classList.remove('on');
  keepAwake(false);
  const coords = state.rec.slice();
  map.getSource('rec').setData(fc([]));
  updateGpsLine();
  if (coords.length < 2) { toast('Recorrido muy corto, no se guardó'); return; }
  const d = new Date();
  const res = await formBox('Guardar recorrido', `<label>Nombre</label><input type="text" name="name" value="Recorrido ${d.toLocaleDateString('es-CL')} ${d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}">
    <p class="hint">${fmtDist(lineLengthM(coords))} · ${coords.length} puntos</p>`);
  if (!res) return;
  const id = uid();
  await db.put('tracks', { id, name: res.name.trim() || 'Recorrido', coords, lengthM: lineLengthM(coords), mapId: state.active?.id || null, author: prefs.get('author', ''), createdAt: d.toISOString() });
  await enqueue('tracks', id);
  await loadTracks();
  toast('Recorrido guardado');
};

function renderTrackList() {
  const ul = $('#trackList');
  if (!state.tracks.length) { ul.innerHTML = '<li class="empty">Sin recorridos. Usa el botón de grabar.</li>'; return; }
  ul.innerHTML = '';
  for (const t of state.tracks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:#7b3fe4"></span><div class="meta"><b>${esc(t.name)}</b><small>${fmtDist(t.lengthM)} · ${new Date(t.createdAt).toLocaleString('es-CL')}</small></div>
      <div class="acts"><button data-go>Ver</button><button class="del" data-del aria-label="Borrar">✕</button></div>`;
    li.querySelector('[data-go]').onclick = () => {
      setFollow(false);
      const lons = t.coords.map((c) => c[0]), lats = t.coords.map((c) => c[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 18 });
      closeSheets();
    };
    li.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmBox('Borrar recorrido', `¿Borrar "${t.name}"?`, 'Borrar'))) return;
      await db.del('tracks', t.id); await enqueue('tracks', t.id, 'delete'); await loadTracks();
    };
    ul.appendChild(li);
  }
}

// ---------- exportar ----------
function enFor(p) {
  const pr = state.proj || utmFor(p.coords[0], p.coords[1]);
  if (!pr) return ['', '', ''];
  const [e, n] = pr.fwd(p.coords);
  return [e.toFixed(2), n.toFixed(2), pr.label];
}

function pointProps(p) {
  return {
    tipo: TYPES[p.type]?.label || p.type, categoria: p.category, titulo: p.name,
    severidad: TYPES[p.type]?.severity ? SEVERITIES[p.severity] : '', estado: STATUSES[p.status], responsable: p.assignee,
    nota: p.note, autor: p.author, fotos: p.photoIds.length, plano: p.mapName || '', precision_gps_m: p.accuracy ?? '',
    creado: p.createdAt, actualizado: p.updatedAt, id: p.id,
  };
}

function exportGeoJSON() {
  const feats = [
    ...state.pins.map((p) => ({ type: 'Feature', properties: pointProps(p), geometry: { type: 'Point', coordinates: p.coords } })),
    ...state.tracks.map((t) => ({ type: 'Feature', properties: { tipo: 'Recorrido', titulo: t.name, largo_m: Math.round(t.lengthM), creado: t.createdAt }, geometry: { type: 'LineString', coordinates: t.coords } })),
  ];
  return JSON.stringify(fc(feats), null, 2);
}

function kmlColor(hex) { const h = hex.replace('#', ''); return `ff${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`; }
function exportKML() {
  const x = (s) => esc(s);
  const styles = Object.entries(TYPES).map(([k, t]) => `<Style id="${k}"><IconStyle><color>${kmlColor(t.color)}</color></IconStyle></Style>`).join('') +
    '<Style id="resuelto"><IconStyle><color>ff527a1f</color></IconStyle></Style>';
  const pins = state.pins.map((p) => {
    const pr = pointProps(p);
    const data = Object.entries(pr).map(([k, v]) => `<Data name="${k}"><value>${x(v)}</value></Data>`).join('');
    return `<Placemark><name>${x(p.name)}</name><styleUrl>#${p.status === 'resuelto' ? 'resuelto' : p.type}</styleUrl><description>${x([pr.tipo, pr.categoria, pr.severidad, pr.estado, p.note].filter(Boolean).join(' · '))}</description><ExtendedData>${data}</ExtendedData><Point><coordinates>${p.coords[0]},${p.coords[1]}</coordinates></Point></Placemark>`;
  });
  const tr = state.tracks.map((t) => `<Placemark><name>${x(t.name)}</name><Style><LineStyle><color>ffe43f7b</color><width>4</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${t.coords.map((c) => c.join(',')).join(' ')}</coordinates></LineString></Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>GeoPlano</name>${styles}${pins.join('')}${tr.join('')}</Document></kml>`;
}

function exportCSV() {
  const cols = ['id', 'tipo', 'categoria', 'titulo', 'severidad', 'estado', 'responsable', 'nota', 'latitud', 'longitud', 'este', 'norte', 'sistema', 'precision_gps_m', 'fotos', 'archivos_fotos', 'plano', 'autor', 'creado', 'actualizado'];
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = state.pins.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((p) => {
    const pr = pointProps(p);
    const [e, n, sys] = enFor(p);
    const files = p.photoIds.map((_, i) => `fotos/${p.id}-${i + 1}.jpg`).join(' ');
    return { ...pr, latitud: p.coords[1].toFixed(7), longitud: p.coords[0].toFixed(7), este: e, norte: n, sistema: sys, archivos_fotos: files };
  });
  // ; como separador y BOM para que Excel en español lo abra bien
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\r\n');
}

async function exportZip() {
  if (!state.pins.length) { toast('No hay puntos para exportar'); return; }
  busy('Armando ZIP con fotos…');
  try {
    const zip = new JSZip();
    zip.file('puntos.csv', exportCSV());
    zip.file('puntos.kml', exportKML());
    zip.file('puntos.geojson', exportGeoJSON());
    for (const p of state.pins) {
      const photos = await db.byIndex('photos', 'pointId', p.id);
      const order = new Map(p.photoIds.map((id, i) => [id, i]));
      photos.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
        .forEach((ph, i) => zip.file(`fotos/${p.id}-${i + 1}.jpg`, ph.blob));
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    await download(blob, `geoplano-${stamp()}.zip`, 'application/zip', true);
  } finally { busy(null); }
}

async function download(content, name, type, force = false) {
  if (!force && !state.pins.length && !state.tracks.length) { toast('No hay puntos ni recorridos para exportar'); return; }
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
$('#btnExportGeo').onclick = () => download(exportGeoJSON(), `geoplano-${stamp()}.geojson`, 'application/geo+json');
$('#btnExportKml').onclick = () => download(exportKML(), `geoplano-${stamp()}.kml`, 'application/vnd.google-earth.kml+xml');
$('#btnExportZip').onclick = () => exportZip();

// ---------- hojas, modales, avisos ----------
function openSheet(id) { closeSheets(); $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true)); hidePick(); }
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSheets));
$('#btnMaps').onclick = () => ($('#sheetMaps').hidden ? openSheet('#sheetMaps') : closeSheets());
$('#btnData').onclick = () => ($('#sheetData').hidden ? openSheet('#sheetData') : closeSheets());
map.on('click', (e) => (state.placing ? placeAt([e.lngLat.lng, e.lngLat.lat]) : closeSheets()));

function formBox(title, html, okText = 'Guardar') {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalOk').textContent = okText;
    $('#modal').hidden = false;
    const first = $('#modalBody input[type=text]');
    if (first) setTimeout(() => first.select(), 50);
    const done = (v) => { $('#modal').hidden = true; $('#modalForm').onsubmit = null; $('#modalCancel').onclick = null; resolve(v); };
    $('#modalForm').onsubmit = (e) => { e.preventDefault(); done(Object.fromEntries(new FormData($('#modalForm')))); };
    $('#modalCancel').onclick = () => done(null);
  });
}
const confirmBox = (title, text, ok) => formBox(title, `<p>${esc(text)}</p>`, ok).then((r) => !!r);

function busy(msg) {
  $('#busy').hidden = !msg;
  if (msg) $('#busyMsg').textContent = msg;
}
let toastT;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

// ---------- inicio ----------
(async () => {
  try { navigator.storage?.persist?.(); } catch {}
  await ready;
  await Promise.all([loadMaps(), loadPins(), loadTracks(), updateSyncBadge()]);
  const last = prefs.get('activeMap', null);
  if (last && state.maps.some((m) => m.id === last)) await activateMap(last, false);
  updateCenterLine();

  // Si ya hay permiso de ubicación, arrancar el GPS directo.
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'granted') startGps();
  } catch {}

  // Para pruebas: ?import=ruta.pdf importa un PDF del mismo sitio.
  const imp = new URLSearchParams(location.search).get('import');
  if (imp && new URL(imp, location.href).origin === location.origin) {
    try {
      busy('Descargando PDF de prueba…');
      const r = await fetch(imp);
      const blob = await r.blob();
      await handleFiles([new File([blob], decodeURIComponent(imp.split('/').pop()), { type: 'application/pdf' })]);
    } finally { busy(null); history.replaceState(null, '', location.pathname); }
  }
  if (!state.maps.length) openSheet('#sheetMaps');
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

// para depurar
window.__geoplano = { state, map, exportCSV, exportKML };
