# Despliegue de GeoSpots en Cloudflare

- **Cuenta:** la de Pat, con Wrangler autorizado por OAuth.
- **D1 `geospots`:** creada el 18-nov-2026 en la región `oc` (Oceanía), porque la app es para Australia.
  - `database_id`: `c550a8a3-d2ec-4174-a2ec-891d33a6ac04`
  - La migración 0001 ya está aplicada en remoto.
- **R2 `geospots-files`:** creado el 18-nov-2026 en `oc` (Pat activó R2 ese día).
- **URL:** https://geospots.patricbarca.workers.dev (el subdominio workers.dev de la cuenta es `patricbarca` desde el 18-nov-2026; antes era `comandia`). Se puede cambiar por un dominio propio.

Primer despliegue: 18-nov-2026. Después se borraron las cuentas de prueba (@ejemplo.com) y sus archivos.

## Acceso
- El registro está cerrado. Para crear una cuenta hace falta una invitación (link de un solo uso que dura 7 días y que genera un administrador del equipo) o el link de alta de empresa: `https://geospots.patricbarca.workers.dev/?alta=<SIGNUP_CODE>`.
- `SIGNUP_CODE` es un secreto del Worker y no está en el repo. Para cambiarlo: `npx wrangler secret put SIGNUP_CODE`. Para abrir el registro a cualquiera hay que poner la variable `OPEN_SIGNUP` en `"true"`.
- En local, `.dev.vars` (fuera de git) define `SIGNUP_CODE`.
- Un administrador puede quitar miembros. Si la persona queda sin equipo, sus sesiones se cierran.

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
