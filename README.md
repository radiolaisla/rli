# PANEL WEB - RADIO LA ISLA

Panel web estatico en HTML, CSS y JavaScript puro para administrar contenidos de RADIO LA ISLA.

El frontend se despliega en Cloudflare Pages y no contiene tokens de GitHub. Las operaciones de lectura y escritura contra GitHub pasan por un Cloudflare Worker, que usa el secret `GITHUB_TOKEN`.

## Estructura

```text
.
|-- index.html
|-- styles.css
|-- app.js
|-- README.md
|-- assets/
|   `-- logo.webp
`-- worker/
    |-- index.js
    `-- wrangler.toml
```

## Repositorio

Repositorio definitivo:

```text
https://github.com/radiolaisla/rli
```

Configuracion usada por el Worker:

```text
owner: radiolaisla
repo: rli
branch: main
```

## Arquitectura

- `index.html`, `styles.css` y `app.js` se sirven desde Cloudflare Pages.
- `app.js` llama al Worker configurado en el panel.
- El Worker expone endpoints para leer y actualizar archivos.
- El Worker usa `env.GITHUB_TOKEN` para comunicarse con la API de GitHub.
- El token no se incluye en el frontend ni en el repositorio.

## Endpoints del Worker

Leer un archivo:

```http
GET /api/file?path=programacion.csv
```

Respuesta:

```json
{
  "path": "programacion.csv",
  "sha": "...",
  "content": "..."
}
```

Actualizar un archivo:

```http
PUT /api/file
Content-Type: application/json
```

Body:

```json
{
  "path": "programacion.csv",
  "content": "dia,inicio,fin,programa,locutor,descripcion\n",
  "sha": "...",
  "message": "Actualizar programacion de radio"
}
```

## Desplegar Cloudflare Pages

1. Sube estos archivos al repositorio `https://github.com/radiolaisla/rli`.
2. En Cloudflare, entra en **Workers & Pages**.
3. Crea una nueva aplicacion de **Pages**.
4. Conecta GitHub y selecciona el repositorio `radiolaisla/rli`.
5. Usa esta configuracion:

```text
Framework preset: None
Build command: exit 0
Build output directory: /
Production branch: main
```

6. Despliega el sitio.

Cloudflare Pages servira los archivos estaticos desde la raiz del repositorio.

## Desplegar el Worker

El codigo del Worker esta en `worker/`.

1. Instala Wrangler si no lo tienes:

```bash
npm install -g wrangler
```

2. Inicia sesion en Cloudflare:

```bash
wrangler login
```

3. Revisa `worker/wrangler.toml` y ajusta el nombre del Worker si hace falta.

4. Configura el origen permitido para CORS. El ejemplo incluido usa:

```text
https://panel.radiolaisla.es
```

5. Despliega el Worker:

```bash
cd worker
wrangler deploy
```

6. Copia la URL del Worker desplegado y pegala en el panel, en **Configuracion > URL del Worker**.

## Secret GITHUB_TOKEN

El token de GitHub debe guardarse como secret del Worker:

```bash
cd worker
wrangler secret put GITHUB_TOKEN
```

Wrangler pedira el valor del token por consola. No lo escribas en `app.js`, `index.html`, `README.md`, `wrangler.toml` ni en ningun archivo del repositorio.

## Permisos del token de GitHub

Usa un token con el menor alcance posible.

Para un fine-grained personal access token:

- Repository access: solo `radiolaisla/rli`.
- Permissions: **Contents: Read and write**.

Si usas un token clasico, limita su uso al repositorio y permisos necesarios para leer y escribir contenidos.

## CORS

El Worker solo devuelve cabeceras CORS para los dominios configurados como `ALLOWED_ORIGINS`.

Valor de ejemplo en `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://panel.radiolaisla.es,https://rli.informativos.workers.dev"
```

Cambia esos valores por los dominios reales desde donde se abrira el panel.

## Archivos administrados por el panel

Programacion CSV:

```csv
dia,inicio,fin,programa,locutor,descripcion
```

Podcasts JSON:

```json
[
  {
    "name": "Nombre del podcast",
    "rssUrl": "https://www.ivoox.com/feed_fg_f123456_filtro_1.xml"
  }
]
```

## Seguridad

- No hay tokens reales en el codigo.
- `GITHUB_TOKEN` se lee solo desde `env.GITHUB_TOKEN` en el Worker.
- El frontend no llama directamente a la API de GitHub.
- El Worker valida rutas basicas y restringe CORS al dominio del panel.
