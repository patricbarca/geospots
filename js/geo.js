// Georreferencia de GeoPDF (ISO 32000: /VP -> /Measure /Subtype /GEO) y utilidades geográficas.

const P = () => window.PDFLib;

/** Lee las páginas del PDF y sus viewports georreferenciados. */
export async function readGeoPdf(bytes) {
  const { PDFDocument, PDFName, PDFRef, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString, ParseSpeeds } = P();
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false, parseSpeed: ParseSpeeds.Fastest,
  });
  const ctx = doc.context;
  const L = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const num = (o) => { o = L(o); return o instanceof PDFNumber ? o.asNumber() : NaN; };
  const nums = (o) => { o = L(o); return o instanceof PDFArray ? o.asArray().map(num) : null; };
  const str = (o) => {
    o = L(o);
    if (!o) return null;
    if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
    if (o instanceof PDFName) return o.asString().replace(/^\//, '');
    if (o instanceof PDFNumber) return String(o.asNumber());
    return null;
  };
  const get = (d, k) => (d instanceof PDFDict ? L(d.get(PDFName.of(k))) : undefined);

  return doc.getPages().map((page, index) => {
    const viewports = [];
    const vpArr = L(page.node.get(PDFName.of('VP')));
    if (vpArr instanceof PDFArray) {
      for (const item of vpArr.asArray()) {
        const vp = L(item);
        const m = get(vp, 'Measure');
        if (!(m instanceof PDFDict)) continue;
        const sub = str(get(m, 'Subtype'));
        if (sub && sub !== 'GEO') continue;
        const gpts = nums(get(m, 'GPTS'));
        const lpts = nums(get(m, 'LPTS')) || nums(get(m, 'Bounds')) || [0, 1, 0, 0, 1, 0, 1, 1];
        let bbox = nums(get(vp, 'BBox'));
        if (!gpts || gpts.length < 6 || !bbox || bbox.length !== 4) continue;
        bbox = [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])];
        const gcs = get(m, 'GCS');
        viewports.push({
          name: str(get(vp, 'Name')) || '',
          bbox, gpts, lpts,
          epsg: num(get(gcs, 'EPSG')) || null,
          wkt: str(get(gcs, 'WKT')) || null,
        });
      }
    }
    return { index, rotation: page.getRotation().angle || 0, viewports };
  });
}

/** Proyección del plano (para leer Este/Norte). Devuelve {fwd([lon,lat]) -> [x,y], inv, label} o null. */
export function makeProj(epsg, wkt) {
  const proj4 = window.proj4;
  const tryDef = (def, label) => {
    try {
      const c = proj4(def);
      const t = c.forward([149, -35]);
      if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) return null;
      return { fwd: (p) => c.forward(p), inv: (p) => c.inverse(p), label };
    } catch { return null; }
  };
  // MGA2020 (EPSG 7846-7859) y MGA94 (28348-28358): UTM sur.
  if (epsg >= 7846 && epsg <= 7859) return tryDef(`+proj=utm +zone=${epsg - 7800} +south +ellps=GRS80 +units=m +no_defs`, `MGA2020 z${epsg - 7800}`);
  if (epsg >= 28348 && epsg <= 28358) return tryDef(`+proj=utm +zone=${epsg - 28300} +south +ellps=GRS80 +units=m +no_defs`, `MGA94 z${epsg - 28300}`);
  if (epsg >= 32601 && epsg <= 32660) return tryDef(`+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`, `UTM ${epsg - 32600}N`);
  if (epsg >= 32701 && epsg <= 32760) return tryDef(`+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`, `UTM ${epsg - 32700}S`);
  if (wkt) {
    const m = /PROJCS\["([^"]+)"/.exec(wkt);
    const r = tryDef(wkt, m ? m[1].replace(/_/g, ' ') : 'Proyectado');
    if (r) return r;
  }
  return null;
}

/** UTM automática para un punto (si el plano no trae proyección). */
export function utmFor(lon, lat) {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const south = lat < 0;
  return makeProj(south ? 32700 + zone : 32600 + zone, null);
}

/** Ajusta una homografía (u,v) -> (x,y) con mínimos cuadrados (4+ puntos). */
function fitHomography(src, dst) {
  // normalizar destino para estabilidad numérica
  const n = src.length;
  const mx = dst.reduce((a, p) => a + p[0], 0) / n, my = dst.reduce((a, p) => a + p[1], 0) / n;
  const sc = Math.max(1e-12, Math.max(...dst.map((p) => Math.hypot(p[0] - mx, p[1] - my))));
  const D = dst.map((p) => [(p[0] - mx) / sc, (p[1] - my) / sc]);
  const A = [], b = [];
  for (let i = 0; i < n; i++) {
    const [u, v] = src[i], [x, y] = D[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // ecuaciones normales
  const N = Array.from({ length: 8 }, () => new Array(9).fill(0));
  for (let r = 0; r < A.length; r++) for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) N[i][j] += A[r][i] * A[r][j];
    N[i][8] += A[r][i] * b[r];
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(N[r][c]) > Math.abs(N[p][c])) p = r;
    [N[c], N[p]] = [N[p], N[c]];
    if (Math.abs(N[c][c]) < 1e-14) throw new Error('Puntos de control degenerados');
    for (let r = 0; r < 8; r++) if (r !== c) {
      const f = N[r][c] / N[c][c];
      for (let k = c; k < 9; k++) N[r][k] -= f * N[c][k];
    }
  }
  const h = N.map((row, i) => row[8] / row[i]);
  return ([u, v]) => {
    const w = h[6] * u + h[7] * v + 1;
    return [((h[0] * u + h[1] * v + h[2]) / w) * sc + mx, ((h[3] * u + h[4] * v + h[5]) / w) * sc + my];
  };
}

/**
 * Calcula las 4 esquinas geográficas [lon,lat] (sup-izq, sup-der, inf-der, inf-izq)
 * de un rectángulo de la página (en puntos PDF) a partir de un viewport GEO.
 */
export function georeference(vp, rect) {
  const geo = [], uv = [];
  for (let i = 0; i + 1 < vp.gpts.length && i + 1 < vp.lpts.length; i += 2) {
    geo.push([vp.gpts[i + 1], vp.gpts[i]]); // GPTS = lat, lon
    uv.push([vp.lpts[i], vp.lpts[i + 1]]);
  }
  if (geo.length < 4) throw new Error('El plano trae menos de 4 puntos de control');
  const proj = makeProj(vp.epsg, vp.wkt);
  const dst = proj ? geo.map((g) => proj.fwd(g)) : geo;
  const H = fitHomography(uv, dst);
  const [bx0, by0, bx1, by1] = vp.bbox;
  const toUV = (x, y) => [(x - bx0) / (bx1 - bx0), (y - by0) / (by1 - by0)];
  const [x0, y0, x1, y1] = rect;
  const pts = [toUV(x0, y1), toUV(x1, y1), toUV(x1, y0), toUV(x0, y0)].map((p) => H(p));
  const corners = proj ? pts.map((p) => proj.inv(p)) : pts;
  // error de ajuste (solo > 0 si hay más de 4 puntos)
  let rms = 0;
  uv.forEach((p, i) => {
    const q = H(p), d = dst[i];
    rms += proj ? (q[0] - d[0]) ** 2 + (q[1] - d[1]) ** 2 : distM(q, d) ** 2;
  });
  return { corners, rmsM: Math.sqrt(rms / uv.length), points: geo.length, precisionM: gptsPrecisionM(vp.gpts) };
}

/** Precisión aproximada (m) que permiten los decimales de las coordenadas del PDF. */
function gptsPrecisionM(gpts) {
  // usa el máximo: los ceros finales se omiten (149.453 suele ser 149.4530)
  const dec = Math.max(...gpts.map((v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }));
  return (111320 * 10 ** -dec) / 2;
}

/** Distancia en metros entre [lon,lat]. */
export function distM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function lineLengthM(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += distM(coords[i - 1], coords[i]);
  return d;
}

/** ¿El punto está dentro del polígono? Si no, a cuántos metros del borde. */
export function insideOrDistance(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return { inside: true, dist: 0 };
  // distancia a cada lado en un plano local
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = (poly[j][0] - p[0]) * kx, ay = (poly[j][1] - p[1]) * ky;
    const bx = (poly[i][0] - p[0]) * kx, by = (poly[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return { inside: false, dist: best };
}

export function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}
