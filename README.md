# GeoSpots (PWA)

App web tipo Avenza: importas un GeoPDF y ves tu posición GPS sobre el plano.

## Qué hace
- Lee la georreferencia del PDF (`/VP` → `/Measure /GEO`: GPTS, LPTS, EPSG/WKT) con pdf-lib.
- Dibuja la zona georreferenciada con pdf.js (hasta unos 16 MP) y la pone sobre MapLibre con sus 4 esquinas.
- GPS en vivo, círculo de precisión, aviso "en el plano / a X m del plano".
- Coordenadas en lat/lon y Este/Norte en la proyección del plano (MGA2020, etc.).
- Pines con nota, recorridos grabados y exportación a GeoJSON/KML.
- Todo queda en el teléfono (IndexedDB). El service worker guarda la app y las teselas ya vistas para usarlas sin conexión.

## Correr en local
```
python -m http.server 8765 --bind 127.0.0.1
```
Abre http://localhost:8765. Para pruebas: `?import=samples/plano-prueba.pdf` importa el PDF de ejemplo.

En el teléfono el GPS solo funciona con HTTPS, así que hay que publicarla (Cloudflare Pages, GitHub Pages, etc.).

## Archivos
- `js/geo.js`: lectura del GeoPDF, homografía y proyecciones.
- `js/importer.js`: render del PDF a imagen y guardado.
- `js/app.js`: mapa, GPS, pines, recorridos, exportar.
- `js/db.js`: IndexedDB.
- `sw.js`: modo sin conexión.

## Límites conocidos
- En iOS el GPS se detiene con la pantalla apagada (la app pide mantener la pantalla encendida mientras graba).
- Teselas de OpenStreetMap: sirven para pruebas; para uso real hace falta un proveedor con plan (MapTiler, Stadia, etc.).
- Aún no lee el formato antiguo de TerraGo (LGIDict) ni recorta con `/Bounds`.
