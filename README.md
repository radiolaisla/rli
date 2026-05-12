# PANEL WEB - RADIO LA ISLA

Panel web protegido para RADIO LA ISLA. El proyecto usa HTML, CSS y JavaScript puro, servido por un Cloudflare Worker que tambien gestiona login, sesiones, usuarios y acceso a GitHub.

Repositorio definitivo:

```text
https://github.com/radiolaisla/rli
```

## Arquitectura

- El Worker sirve el panel en `/`.
- El Worker muestra el login en `/login`.
- Cloudflare D1 guarda usuarios, sesiones e intentos de login.
- El frontend no guarda ni recibe el token de GitHub.
- El Worker usa `GITHUB_TOKEN` desde Worker Secrets.
- El Worker usa `SESSION_SECRET` desde Worker Secrets para hashear tokens de sesion e IPs.

Dominios previstos:

```text
https://panel.radiolaisla.com/
https://rli.informativos.workers.dev/
```

## Estructura

```text
.
|-- index.html
|-- styles.css
|-- app.js
|-- README.md
|-- .gitignore
|-- assets/
|   `-- logo.webp
`-- worker/
    |-- index.js
    |-- wrangler.toml
    |-- migrations/
    |   `-- 0001_auth.sql
    `-- scripts/
        `-- create-admin.mjs
```

## Endpoints Principales

- `GET /login`: pantalla de login.
- `POST /api/login`: valida correo y contrasena.
- `POST /api/logout`: cierra sesion.
- `GET /api/me`: devuelve email y rol.
- `GET /admin/users`: administracion de usuarios, solo role `admin`.
- `GET /api/github/file?path=...`: lee archivos de GitHub.
- `PUT /api/github/file`: actualiza archivos de GitHub.
- `GET /api/github/config`: devuelve owner, repo y branch.

## Seguridad

- No hay registro publico.
- Los usuarios los crea un admin.
- Las contrasenas se guardan con PBKDF2-SHA-256, sal aleatoria e iteraciones altas.
- Las sesiones guardan solo el hash del token, no el token real.
- La cookie de sesion es `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` y expira en 8 horas.
- El login usa mensajes genericos.
- Hay limitacion basica de intentos por email/IP.
- No se deben subir tokens, contrasenas reales, hashes reales de produccion, `.env` ni `.dev.vars`.

## Configurar D1

Desde PowerShell:

```powershell
cd "C:\PANEL WEB\worker"
wrangler.cmd d1 create rli-panel-db
```

Cloudflare devolvera un `database_id`. Copialo en `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "rli-panel-db"
database_id = "TU_DATABASE_ID"
```

Aplica la migracion:

```powershell
wrangler.cmd d1 migrations apply rli-panel-db --remote
```

## Configurar Secrets

El token de GitHub debe tener acceso solo al repositorio `radiolaisla/rli`.

Permisos recomendados para fine-grained token:

```text
Repository access: solo radiolaisla/rli
Permissions: Contents: Read and write
```

Guarda el token como secret:

```powershell
wrangler.cmd secret put GITHUB_TOKEN
```

Crea tambien un secreto largo para sesiones:

```powershell
wrangler.cmd secret put SESSION_SECRET
```

Puedes generar un valor aleatorio en PowerShell:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

No escribas estos valores en GitHub ni en `wrangler.toml`.

## Crear El Primer Admin

Despues de aplicar migraciones y configurar `database_id`, ejecuta:

```powershell
cd "C:\PANEL WEB\worker"
node .\scripts\create-admin.mjs
```

El script pedira:

- Email del admin.
- Contrasena.
- Repeticion de contrasena.

La contrasena no se guarda en archivos. El script calcula el hash localmente y lo escribe en D1 usando Wrangler.

Si quieres usar otro nombre de base de datos:

```powershell
$env:D1_DATABASE_NAME="otro-nombre"
node .\scripts\create-admin.mjs
```

## Desplegar El Worker

Desde la carpeta del Worker:

```powershell
cd "C:\PANEL WEB\worker"
wrangler.cmd deploy
```

El `wrangler.toml` esta preparado para servir los archivos del panel como assets protegidos:

```toml
[assets]
directory = ".."
binding = "ASSETS"
```

Solo se sirven rutas estaticas permitidas, como `/`, `/index.html`, `/styles.css`, `/app.js` y `/assets/logo.webp`. Si no hay sesion valida, el panel redirige a `/login`.

## Acceso

Abre:

```text
https://rli.informativos.workers.dev/login
```

o el dominio propio cuando lo tengas:

```text
https://panel.radiolaisla.com/login
```

Entra con el primer usuario admin creado con el script.

Los admins pueden gestionar usuarios en:

```text
/admin/users
```

Desde ahi puedes:

- Crear usuarios.
- Cambiar contrasenas.
- Activar o desactivar usuarios.
- Cambiar rol `admin` o `editor`.

## Comprobar Que GitHub No Esta Expuesto

En el navegador, abre DevTools:

1. En **Network**, las llamadas del panel deben ir a `/api/github/file`, no a `api.github.com`.
2. En **Application > Cookies**, la sesion aparece como cookie `HttpOnly`.
3. En el codigo fuente del navegador no debe aparecer `GITHUB_TOKEN`.
4. En el repositorio no debe existir `.env`, `.dev.vars`, tokens ni backups reales de D1.

## Comandos Resumen

```powershell
cd "C:\PANEL WEB\worker"
wrangler.cmd d1 create rli-panel-db
wrangler.cmd d1 migrations apply rli-panel-db --remote
wrangler.cmd secret put GITHUB_TOKEN
wrangler.cmd secret put SESSION_SECRET
node .\scripts\create-admin.mjs
wrangler.cmd deploy
```
