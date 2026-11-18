// Importa un GeoPDF: lee las coordenadas, dibuja la zona georreferenciada como imagen y la guarda.
import { readGeoPdf, georeference } from './geo.js';
import { db, uid } from './db.js';

const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let workerReady;

async function pdfjs() {
  const lib = window.pdfjsLib;
  if (!workerReady) {
    // El worker viene de otro dominio: se carga como blob para que funcione (y sin conexión vía caché).
    workerReady = fetch(PDFJS_WORKER).then((r) => r.blob()).then((b) => {
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([b], { type: 'text/javascript' }));
    });
  }
  await workerReady;
  return lib;
}

function maxTexture() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    return Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
  } catch { return 4096; }
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/**
 * @param {ArrayBuffer} buffer contenido del PDF
 * @param {string} fileName
 * @param {(msg:string)=>void} progress
 * @returns {Promise<object[]>} planos guardados
 */
export async function importPdf(buffer, fileName, progress = () => {}) {
  progress('Leyendo coordenadas del PDF…');
  const pages = await readGeoPdf(new Uint8Array(buffer.slice(0)));
  const geoPages = pages.filter((p) => p.viewports.length);
  if (!geoPages.length) {
    const err = new Error('Este PDF no trae georreferencia (no tiene /VP /Measure /GEO). Necesitas un GeoPDF.');
    err.code = 'NO_GEO';
    throw err;
  }

  const lib = await pdfjs();
  progress('Abriendo el plano…');
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const baseName = fileName.replace(/\.pdf$/i, '');
  const saved = [];
  const maxSide = maxTexture();

  try {
    for (const gp of geoPages) {
      const page = await pdf.getPage(gp.index + 1);
      const view = page.view; // [x0,y0,x1,y1] en puntos PDF (CropBox)
      // Si hay varios viewports, usa el más grande (el marco del mapa).
      const vp = gp.viewports.slice().sort((a, b) => area(b.bbox) - area(a.bbox))[0];
      const rect = [Math.max(vp.bbox[0], view[0]), Math.max(vp.bbox[1], view[1]), Math.min(vp.bbox[2], view[2]), Math.min(vp.bbox[3], view[3])];
      const wPt = rect[2] - rect[0], hPt = rect[3] - rect[1];
      if (wPt <= 1 || hPt <= 1) continue;

      const geo = georeference(vp, rect);
      const scale = Math.min(maxSide / wPt, maxSide / hPt, Math.sqrt(16e6 / (wPt * hPt)));
      const w = Math.floor(wPt * scale), h = Math.floor(hPt * scale);

      progress(`Dibujando página ${gp.index + 1} (${w}×${h} px)…`);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      const viewport = page.getViewport({ scale, rotation: 0 });
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, -(rect[0] - view[0]) * scale, -(view[3] - rect[3]) * scale],
      }).promise;

      progress('Guardando en el teléfono…');
      const image = await toBlob(canvas, 'image/jpeg', 0.9);
      const thumbC = document.createElement('canvas');
      const ts = 160 / Math.max(w, h);
      thumbC.width = Math.round(w * ts); thumbC.height = Math.round(h * ts);
      thumbC.getContext('2d').drawImage(canvas, 0, 0, thumbC.width, thumbC.height);
      const thumb = await toBlob(thumbC, 'image/jpeg', 0.8);
      canvas.width = canvas.height = 0;

      const map = {
        id: uid(),
        name: geoPages.length > 1 ? `${baseName} · p${gp.index + 1}` : baseName,
        fileName,
        page: gp.index + 1,
        corners: geo.corners,
        epsg: vp.epsg,
        wkt: vp.wkt,
        points: geo.points,
        precisionM: geo.precisionM,
        rmsM: geo.rmsM,
        rotation: gp.rotation,
        size: [w, h],
        image, thumb,
        createdAt: new Date().toISOString(),
      };
      await db.put('maps', map);
      saved.push(map);
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return saved;
}

const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
