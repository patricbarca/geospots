# Despliegue de GeoSpots en Cloudflare

- **Cuenta:** la de Pat, con Wrangler autorizado por OAuth.
- **D1 `geospots`:** creada el 18-nov-2026 en la región `oc` (Oceanía), porque la app es para Australia.
  - `database_id`: `c550a8a3-d2ec-4174-a2ec-891d33a6ac04`
  - La migración 0001 ya está aplicada en remoto.
- **R2 `geospots-files`:** pendiente. Primero hay que activar R2 en la cuenta. Ese paso lo hace Pat en el panel de Cloudflare (R2 Object Storage → "Add R2 subscription"), porque implica aceptar una suscripción.
- **URL prevista:** https://geospots.comandia.workers.dev (el subdominio workers.dev de la cuenta es `comandia`). Se puede cambiar por un dominio propio.

## Primer despliegue (cuando R2 esté activo)
```bash
npx wrangler r2 bucket create geospots-files --location oc
npx wrangler deploy
```

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
La versión sin servidor sigue publicada desde `main` en https://patricbarca.github.io/geospots/. Después del despliegue, esa página debe redirigir a la URL de Cloudflare.
