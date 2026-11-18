# GeoSpots

App web tipo Avenza, pensada para equipos en terreno. Importas un GeoPDF, ves tu posición GPS sobre el plano y registras defectos, eventos y notas con fotos. Todo se comparte con tu equipo.

**App:** https://geospots.patricbarca.workers.dev
La dirección vieja, patricbarca.github.io/geospots, redirige a la nueva.

## Qué hace
- **Lectura del GeoPDF:** lee la georreferencia (`/VP` → `/Measure /GEO`: GPTS, LPTS, EPSG/WKT) con pdf-lib.
- **Plano sobre el mapa:** dibuja la zona con pdf.js, hasta unos 16 MP, y la pone sobre MapLibre usando sus 4 esquinas.
- **GPS en vivo:** muestra el círculo de precisión y avisa "en el plano" o "a X m del plano". Da las coordenadas en lat/lon y en Este/Norte de la proyección del plano (MGA2020, etc.).
- **Inspección:**
  - Defectos, eventos y notas con categoría, severidad, estado y fotos.
  - Recorridos grabados.
  - Exportación a ZIP (CSV + fotos), KML y GeoJSON.
- **Cuentas y equipos:**
  - Cuentas con email y contraseña.
  - Equipos con invitación por link.
  - El plano procesado, los puntos, las fotos y los recorridos se comparten con el equipo.
- **Sin conexión:** todo se guarda primero en el teléfono (IndexedDB) y se envía cuando hay señal. El service worker guarda la app y las teselas ya vistas.

## Arquitectura (Cloudflare, plan gratis)
- `public/`: la PWA, que se sirve como assets del Worker.
- `src/worker.js`: la API `/api/*`, que cubre:
  - cuentas: registro, login y sesiones;
  - equipos e invitaciones;
  - registros sincronizados, con un número de cambio por equipo;
  - archivos.
- `migrations/`: el esquema de D1.
- D1 `geospots` (región Oceanía) guarda usuarios, equipos y registros. R2 `geospots-files` guarda las imágenes de planos y las fotos.

## Archivos de la app
- `public/js/geo.js`: lectura del GeoPDF, homografía y proyecciones.
- `public/js/importer.js`: render del PDF a imagen y guardado.
- `public/js/inspect.js`: tipos de punto, fotos y cola de envío.
- `public/js/cloud.js`: cuenta, envío y recepción de cambios.
- `public/js/app.js`: mapa, GPS, puntos, recorridos, cuenta y exportación.
- `public/sw.js`: modo sin conexión. La API nunca se guarda en caché.

Despliegue y desarrollo local: ver [DESPLIEGUE.md](DESPLIEGUE.md).

## Límites conocidos
- En iOS el GPS se detiene con la pantalla apagada. La app pide mantener la pantalla encendida mientras graba.
- Las teselas de OpenStreetMap sirven para pruebas. Para uso real hace falta un proveedor con plan (MapTiler, Stadia, etc.).
- Aún no lee el formato antiguo de TerraGo (LGIDict) ni recorta con `/Bounds`.
- Todavía no hay recuperación de contraseña por email.
