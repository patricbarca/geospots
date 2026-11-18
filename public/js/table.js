// Vista de tabla: todos los puntos del plano (o de todos los planos) con sus datos en columnas.
// Filtra, ordena y exporta lo que se ve a Excel (.xlsx) o CSV.
import { db } from './db.js';
import { TYPES, SEVERITIES, STATUSES } from './inspect.js';

let ctx; // { state, enFor, esc, toast, download, stamp, goTo, edit, onOpen }
const $ = (s) => document.querySelector(s);
const view = { scope: 'map', types: new Set(Object.keys(TYPES)), status: 'todos', q: '', sort: 'creado', dir: 1 };

// Columnas: key, título, valor para la tabla y valor para Excel/CSV.
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }); };
export const COLUMNS = [
  { key: 'n', title: 'N°', num: true },
  { key: 'tipo', title: 'Tipo' },
  { key: 'categoria', title: 'Categoría' },
  { key: 'titulo', title: 'Título', wide: true },
  { key: 'severidad', title: 'Severidad' },
  { key: 'estado', title: 'Estado' },
  { key: 'responsable', title: 'Responsable' },
  { key: 'nota', title: 'Nota', wide: true },
  { key: 'latitud', title: 'Latitud', num: true, dec: 7 },
  { key: 'longitud', title: 'Longitud', num: true, dec: 7 },
  { key: 'este', title: 'Este (m)', num: true, dec: 2 },
  { key: 'norte', title: 'Norte (m)', num: true, dec: 2 },
  { key: 'sistema', title: 'Sistema' },
  { key: 'precision', title: 'Precisión GPS (m)', num: true },
  { key: 'fotos', title: 'Fotos', num: true },
  { key: 'plano', title: 'Plano' },
  { key: 'autor', title: 'Registrado por' },
  { key: 'creado', title: 'Creado', date: true },
  { key: 'actualizado', title: 'Actualizado', date: true },
  { key: 'enviado', title: 'Enviado' },
  { key: 'id', title: 'ID' },
];

/** Filas con todos los datos de cada punto (mismo orden de creación → N° estable). */
export function pointRows(pins) {
  const all = ctx.state.pins.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const num = new Map(all.map((p, i) => [p.id, i + 1]));
  return pins.map((p) => {
    const t = TYPES[p.type] || TYPES.nota;
    const [e, n, sys] = ctx.enFor(p);
    return {
      _p: p,
      n: num.get(p.id),
      tipo: t.label,
      categoria: p.category || '',
      titulo: p.name,
      severidad: t.severity ? SEVERITIES[p.severity] || '' : '',
      estado: STATUSES[p.status] || p.status,
      responsable: p.assignee || '',
      nota: p.note || '',
      latitud: p.coords[1],
      longitud: p.coords[0],
      este: e === '' ? '' : Number(e),
      norte: n === '' ? '' : Number(n),
      sistema: sys,
      precision: p.accuracy ?? '',
      fotos: p.photoIds.length,
      plano: p.mapName || '',
      autor: p.author || '',
      creado: p.createdAt,
      actualizado: p.updatedAt,
      enviado: p.syncedAt ? 'Sí' : 'Pendiente',
      id: p.id,
    };
  });
}

function filtered() {
  const { state } = ctx;
  const q = view.q.trim().toLowerCase();
  let pins = state.pins;
  if (view.scope === 'map' && state.active) pins = pins.filter((p) => p.mapId === state.active.id);
  pins = pins.filter((p) => view.types.has(p.type) && (view.status === 'todos' || p.status === view.status));
  let rows = pointRows(pins);
  if (q) rows = rows.filter((r) => [r.titulo, r.nota, r.categoria, r.responsable, r.autor, r.tipo, r.plano].some((v) => String(v).toLowerCase().includes(q)));
  const col = COLUMNS.find((c) => c.key === view.sort) || COLUMNS[0];
  rows.sort((a, b) => {
    const RANK = { severidad: { alta: 3, media: 2, baja: 1 }, estado: { abierto: 2, resuelto: 1 } };
    const x = RANK[col.key] ? (RANK[col.key][col.key === 'severidad' ? (TYPES[a._p.type]?.severity ? a._p.severity : '') : a._p.status] || 0) : a[col.key];
    const y = RANK[col.key] ? (RANK[col.key][col.key === 'severidad' ? (TYPES[b._p.type]?.severity ? b._p.severity : '') : b._p.status] || 0) : b[col.key];
    const r = col.num || typeof x === 'number' ? (Number(x) || 0) - (Number(y) || 0) : String(x).localeCompare(String(y), 'es');
    return r * view.dir;
  });
  return rows;
}

// ---------- vista ----------
export function initTable(c) {
  ctx = c;
  $('#tblScope').addEventListener('change', (e) => { view.scope = e.target.value; render(); });
  $('#tblStatus').addEventListener('change', (e) => { view.status = e.target.value; render(); });
  $('#tblSearch').addEventListener('input', (e) => { view.q = e.target.value; render(); });
  $('#tblClose').onclick = closeTable;
  $('#tblXlsx').onclick = () => exportXlsx(filtered());
  $('#tblCsv').onclick = () => exportCsvRows(filtered());
  $('#tblZip').onclick = () => ctx.exportZip(filtered().map((r) => r._p));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewTable').hidden) closeTable(); });
}

export function openTable() {
  ctx.onOpen?.();
  const hasMap = !!ctx.state.active;
  $('#tblScope').querySelector('[value=map]').disabled = !hasMap;
  if (!hasMap) view.scope = 'all';
  $(`#tblScope input[value=${view.scope}]`).checked = true;
  $('#tblScopeMap').textContent = 'Este plano';
  $('#tblScopeMap').title = hasMap ? ctx.state.active.name : '';
  $('#viewTable').hidden = false;
  document.body.classList.add('table-open');
  render();
}
export function closeTable() {
  $('#viewTable').hidden = true;
  document.body.classList.remove('table-open');
}
export const isTableOpen = () => !$('#viewTable').hidden;
export function refreshTable() { if (isTableOpen()) render(); }

function renderTypeChips() {
  const box = $('#tblTypes');
  box.innerHTML = Object.entries(TYPES).map(([k, t]) =>
    `<button type="button" class="chip-f ${view.types.has(k) ? 'on' : ''}" data-k="${k}" style="--c:${t.color}">${ctx.esc(t.label)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    const k = b.dataset.k;
    view.types.has(k) ? view.types.delete(k) : view.types.add(k);
    render();
  }));
}

const thumbs = new Map(); // pointId → objectURL de la primera foto
async function loadThumb(p, img) {
  if (!thumbs.has(p.id)) {
    const ph = p.photoIds[0] && (await db.get('photos', p.photoIds[0]));
    thumbs.set(p.id, ph ? URL.createObjectURL(ph.blob) : null);
  }
  const u = thumbs.get(p.id);
  if (u) { img.src = u; img.hidden = false; }
}

function cell(r, c) {
  const v = r[c.key];
  const esc = ctx.esc;
  if (c.key === 'tipo') {
    const t = TYPES[r._p.type] || TYPES.nota;
    return `<span class="dot" style="background:${r._p.status === 'resuelto' ? '#1f7a52' : t.color}"></span>${esc(v)}`;
  }
  if (c.key === 'severidad' && v) return `<span class="tag ${r._p.severity}">${esc(v)}</span>`;
  if (c.key === 'estado') return r._p.status === 'resuelto' ? `<span class="tag ok">${esc(v)}</span>` : esc(v);
  if (c.key === 'fotos') return v ? `<img alt="" hidden class="tthumb">${v}` : '0';
  if (c.date) return esc(fmtDate(v));
  if (c.dec != null && v !== '') return Number(v).toFixed(c.dec);
  return esc(v);
}

function render() {
  renderTypeChips();
  const rows = filtered();
  const total = ctx.state.pins.length;
  $('#tblCount').textContent = `${rows.length} punto${rows.length === 1 ? '' : 's'}${rows.length !== total ? ` de ${total}` : ''}`;
  for (const b of ['#tblXlsx', '#tblCsv', '#tblZip']) $(b).disabled = !rows.length;

  const head = COLUMNS.map((c) => `<th data-k="${c.key}" class="${c.num ? 'num' : ''} ${c.wide ? 'wide' : ''}" aria-sort="${view.sort === c.key ? (view.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.title}${view.sort === c.key ? (view.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  $('#tblHead').innerHTML = `<tr><th class="acts-col"></th>${head}</tr>`;
  $('#tblHead').querySelectorAll('th[data-k]').forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    if (view.sort === k) view.dir = -view.dir; else { view.sort = k; view.dir = k === 'severidad' || k === 'actualizado' ? -1 : 1; }
    render();
  }));

  const body = $('#tblBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="${COLUMNS.length + 1}">${total ? 'Ningún punto coincide con los filtros.' : 'Aún no hay puntos. Usa el botón naranjo del pin para registrar un defecto, evento o nota.'}</td></tr>`;
    return;
  }
  body.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="acts-col"><button type="button" data-go title="Ver en el mapa" aria-label="Ver en el mapa">📍</button><button type="button" data-edit title="Editar" aria-label="Editar">✎</button></td>` +
      COLUMNS.map((c) => `<td class="${c.num ? 'num' : ''} ${c.wide ? 'wide' : ''}">${cell(r, c)}</td>`).join('');
    tr.querySelector('[data-go]').onclick = () => { closeTable(); ctx.goTo(r._p); };
    tr.querySelector('[data-edit]').onclick = () => { closeTable(); ctx.edit(r._p); };
    const img = tr.querySelector('.tthumb');
    if (img) loadThumb(r._p, img);
    body.appendChild(tr);
  }
}

// ---------- exportar ----------
const fileName = (ext) => `geospots-puntos-${ctx.stamp()}.${ext}`;
const plain = (r, c) => {
  const v = r[c.key];
  if (c.date) { if (!v) return ''; const d = new Date(v); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; }
  if (c.dec != null && v !== '') return Number(v).toFixed(c.dec);
  return v ?? '';
};

export function csvFromRows(rows) {
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [COLUMNS.map((c) => q(c.title)).join(';'), ...rows.map((r) => COLUMNS.map((c) => q(plain(r, c))).join(';'))];
  return '﻿' + lines.join('\r\n'); // ; y BOM: Excel en español lo abre bien
}
function exportCsvRows(rows) {
  if (!rows.length) return ctx.toast('No hay puntos para exportar');
  ctx.download(csvFromRows(rows), fileName('csv'), 'text/csv', true);
}

// XLSX mínimo (Office Open XML) armado con JSZip: una hoja con encabezado fijo, filtros y fechas reales.
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const excelDate = (iso) => { const t = Date.parse(iso); if (isNaN(t)) return null; const d = new Date(t); return (t - d.getTimezoneOffset() * 60000) / 86400000 + 25569; };

export async function xlsxFromRows(rows) {
  // estilos: 0 normal, 1 encabezado, 2 fecha, 3 7 decimales, 4 2 decimales, 5 texto ajustado
  const styleOf = (c) => (c.date ? 2 : c.dec === 7 ? 3 : c.dec === 2 ? 4 : c.wide ? 5 : 0);
  const cellXml = (ref, c, v) => {
    if (v === '' || v == null) return '';
    if (c.date) { const n = excelDate(v); return n == null ? '' : `<c r="${ref}" s="2"><v>${n}</v></c>`; }
    if (c.num && typeof v === 'number' && isFinite(v)) return `<c r="${ref}" s="${styleOf(c)}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${styleOf(c)}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const headRow = `<row r="1">${COLUMNS.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${xmlEsc(c.title)}</t></is></c>`).join('')}</row>`;
  const bodyRows = rows.map((r, ri) => `<row r="${ri + 2}">${COLUMNS.map((c, i) => cellXml(`${colName(i)}${ri + 2}`, c, r[c.key])).join('')}</row>`).join('');
  const widths = COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.wide ? 40 : c.date ? 17 : c.key === 'n' ? 6 : c.key === 'id' ? 16 : 14}" customWidth="1"/>`).join('');
  const last = `${colName(COLUMNS.length - 1)}${rows.length + 1}`;

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols><sheetData>${headRow}${bodyRows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="165" formatCode="0.0000000"/><numFmt numFmtId="166" formatCode="0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17483F"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Puntos" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Puntos!$A$1:$${colName(COLUMNS.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', sheet);
  zip.file('xl/styles.xml', styles);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
async function exportXlsx(rows) {
  if (!rows.length) return ctx.toast('No hay puntos para exportar');
  const blob = await xlsxFromRows(rows);
  ctx.download(blob, fileName('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true);
}
