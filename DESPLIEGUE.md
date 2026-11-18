# Despliegue de GeoSpots en Cloudflare

- **Cuenta:** la de Pat, con Wrangler autorizado por OAuth.
- **D1 `geospots`:** creada el 18-nov-2026 en la región `oc` (Oceanía), porque la app es para Australia.
  - `database_id`: `c550a8a3-d2ec-4174-a2ec-891d33a6ac04`
  - La migración 0001 ya está aplicada en remoto.
- **R2 `geospots-files`:** creado el 18-nov-2026 en `oc` (Pat activó R2 ese día).
- **URL:** https://geospots.comandia.workers.dev (el subdominio workers.dev de la cuenta es `comandia`). Se puede cambiar por un dominio propio.

Primer despliegue: 18-nov-2026. Después se borraron las cuentas de prueba (@ejemplo.com) y sus archivos.

## Para volver a desplegar
```bash
npm run deploy
```
Ese comando aplica las migraciones nuevas en remoto y despliega.

## Desarrollo local
En Windows, la ruta de esta carpeta es muy larga para la base local de Wrangler, así que hay que usar `--persist-to` con una ruta corta:
```bash
npx wrangler d1 migrations apply geospots --local --persist-to C:/gs-state
npx wrangler dev --port 8799 --persist-to C:/gs-state
```

## GitHub Pages
`index.html`, `404.html` y `sw.js` de la raíz del repo publican en https://patricbarca.github.io/geospots/ una página que redirige a la URL de Cloudflare y desinstala el service worker viejo.
