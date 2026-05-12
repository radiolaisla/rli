const OWNER = "radiolaisla";
const REPO = "rli";
const BRANCH = "main";
const SESSION_COOKIE = "rli_session";
const SESSION_HOURS = 8;
const PASSWORD_ITERATIONS = 310000;
const PASSWORD_MIN_LENGTH = 12;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const STATIC_ROUTES = new Set(["/", "/index.html", "/styles.css", "/app.js", "/assets/logo.webp"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (!env.DB) return jsonResponse({ error: "missing_d1_binding" }, 500);

      if (request.method === "GET" && url.pathname === "/login") {
        const session = await getSessionUser(request, env);
        return session ? redirect("/") : htmlResponse(loginPage());
      }

      if (request.method === "GET" && url.pathname === "/assets/logo.webp") {
        return serveStatic(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/login") {
        return await login(request, env);
      }

      const session = await getSessionUser(request, env);
      if (!session) {
        return wantsJson(request) || url.pathname.startsWith("/api/")
          ? jsonResponse({ error: "authentication_required" }, 401)
          : redirect("/login");
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        return await logout(request, env, session);
      }

      if (request.method === "GET" && url.pathname === "/api/me") {
        return jsonResponse({ email: session.user.email, role: session.user.role });
      }

      if (request.method === "GET" && url.pathname === "/api/github/config") {
        return jsonResponse({ owner: OWNER, repo: REPO, branch: BRANCH });
      }

      if (request.method === "GET" && url.pathname === "/api/github/file") {
        return await readGithubFile(url, env);
      }

      if (request.method === "PUT" && url.pathname === "/api/github/file") {
        return await updateGithubFile(request, env);
      }

      if (url.pathname === "/admin/users") {
        return await adminUsersRoute(request, env, session);
      }

      if (url.pathname.startsWith("/api/admin/users")) {
        return await adminUsersApi(request, env, session);
      }

      if (request.method === "GET" && STATIC_ROUTES.has(url.pathname)) {
        return serveStatic(request, env);
      }

      return htmlResponse(notFoundPage(), 404);
    } catch (error) {
      return handleError(error, request);
    }
  }
};

async function login(request, env) {
  const form = await request.formData().catch(() => null);
  const email = normalizeEmail(form?.get("email"));
  const password = String(form?.get("password") || "");
  const ipHash = await requestIpHash(request, env);
  const userAgent = request.headers.get("User-Agent") || "";

  if (!email || !password) {
    await recordLoginAttempt(env, email || "missing", ipHash, false);
    return loginFailed();
  }

  const blocked = await isLoginBlocked(env, email, ipHash);
  if (blocked) return htmlResponse(loginPage("Demasiados intentos. Espera unos minutos."), 429);

  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first();
  const validPassword = user?.active ? await verifyPassword(password, user.password_hash, user.password_salt) : false;

  if (!user || !user.active || !validPassword) {
    await recordLoginAttempt(env, email, ipHash, false);
    return loginFailed();
  }

  await recordLoginAttempt(env, email, ipHash, true);
  const token = randomBase64Url(32);
  const tokenHash = await secretHash(token, env);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, session_token_hash, created_at, expires_at, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, user.id, tokenHash, now.toISOString(), expiresAt.toISOString(), userAgent.slice(0, 300), ipHash).run();
  await env.DB.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .bind(now.toISOString(), now.toISOString(), user.id)
    .run();

  return redirect("/", {
    "Set-Cookie": sessionCookie(token, expiresAt)
  });
}

function loginFailed() {
  return htmlResponse(loginPage("Credenciales incorrectas."), 401);
}

async function logout(request, env, session) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.session.id).run();
  return redirect("/login", {
    "Set-Cookie": clearSessionCookie()
  });
}

async function getSessionUser(request, env) {
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = await secretHash(token, env);
  const row = await env.DB.prepare(
    `SELECT
       sessions.id AS session_id,
       sessions.expires_at,
       users.id AS user_id,
       users.email,
       users.role,
       users.active
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.session_token_hash = ?
     LIMIT 1`
  ).bind(tokenHash).first();

  if (!row || !row.active || new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_token_hash = ?").bind(tokenHash).run();
    return null;
  }

  return {
    session: { id: row.session_id, expiresAt: row.expires_at },
    user: { id: row.user_id, email: row.email, role: row.role }
  };
}

async function adminUsersRoute(request, env, session) {
  if (session.user.role !== "admin") return htmlResponse(forbiddenPage(), 403);
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);

  const users = await env.DB.prepare(
    "SELECT id, email, role, active, created_at, updated_at, last_login_at FROM users ORDER BY email"
  ).all();
  return htmlResponse(adminUsersPage(users.results || [], session.user));
}

async function adminUsersApi(request, env, session) {
  if (session.user.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  const form = await request.formData();

  if (url.pathname === "/api/admin/users/create") {
    const email = normalizeEmail(form.get("email"));
    const password = String(form.get("password") || "");
    const role = normalizeRole(form.get("role"));
    validateEmail(email);
    validatePassword(password);
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(crypto.randomUUID(), email, hash.hash, hash.salt, role, now, now).run();
    return redirect("/admin/users?ok=user_created");
  }

  const userId = String(form.get("id") || "");
  if (!userId) return redirect("/admin/users?error=missing_user");
  const target = await env.DB.prepare("SELECT id, email, role, active FROM users WHERE id = ?").bind(userId).first();
  if (!target) return redirect("/admin/users?error=user_not_found");

  if (url.pathname === "/api/admin/users/password") {
    const password = String(form.get("password") || "");
    validatePassword(password);
    const hash = await hashPassword(password);
    await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .bind(hash.hash, hash.salt, new Date().toISOString(), userId)
      .run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    return redirect("/admin/users?ok=password_changed");
  }

  if (url.pathname === "/api/admin/users/role") {
    const role = normalizeRole(form.get("role"));
    await env.DB.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
      .bind(role, new Date().toISOString(), userId)
      .run();
    return redirect("/admin/users?ok=role_changed");
  }

  if (url.pathname === "/api/admin/users/active") {
    const active = form.get("active") === "1" ? 1 : 0;
    if (userId === session.user.id && active === 0) {
      return redirect("/admin/users?error=cannot_disable_self");
    }
    await env.DB.prepare("UPDATE users SET active = ?, updated_at = ? WHERE id = ?")
      .bind(active, new Date().toISOString(), userId)
      .run();
    if (!active) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    return redirect("/admin/users?ok=active_changed");
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function readGithubFile(url, env) {
  requireGithubToken(env);
  const path = validatePath(url.searchParams.get("path"));
  const githubPath = encodePath(path);
  const githubUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${githubPath}?ref=${encodeURIComponent(BRANCH)}`;
  const response = await fetch(githubUrl, { headers: githubHeaders(env) });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw githubError(data, response.status, path);

  return jsonResponse({ path, sha: data.sha, content: decodeBase64(data.content || "") });
}

async function updateGithubFile(request, env) {
  requireGithubToken(env);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResponse({ error: "invalid_json" }, 400);

  const path = validatePath(body.path);
  const content = typeof body.content === "string" ? body.content : "";
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : `Actualizar ${path}`;
  const payload = { message, content: encodeBase64(content), branch: BRANCH };
  if (typeof body.sha === "string" && body.sha) payload.sha = body.sha;

  const githubPath = encodePath(path);
  const githubUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${githubPath}`;
  const response = await fetch(githubUrl, {
    method: "PUT",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw githubError(data, response.status, path);
  return jsonResponse({ path, sha: data.content?.sha || null });
}

async function serveStatic(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/") url.pathname = "/index.html";
  const assetRequest = new Request(url.toString(), request);
  const response = await env.ASSETS.fetch(assetRequest);
  return withSecurityHeaders(response);
}

function requireGithubToken(env) {
  if (!env.GITHUB_TOKEN) {
    const error = new Error("missing_github_token");
    error.status = 500;
    throw error;
  }
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "radio-la-isla-panel-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function validatePath(path) {
  if (typeof path !== "string" || !path.trim()) throw statusError("missing_path", 400);
  const cleanPath = path.trim();
  const segments = cleanPath.split("/");
  const isUnsafe = cleanPath.startsWith("/") ||
    cleanPath.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..");
  if (isUnsafe) throw statusError("invalid_path", 400);
  return cleanPath;
}

function validateEmail(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw statusError("invalid_email", 400);
}

function validatePassword(password) {
  if (password.length < PASSWORD_MIN_LENGTH) throw statusError("weak_password", 400);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  return value === "admin" ? "admin" : "editor";
}

async function hashPassword(password, salt = randomBase64Url(16)) {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256
  );
  return {
    algorithm: "pbkdf2-sha256",
    iterations: PASSWORD_ITERATIONS,
    salt,
    hash: `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${salt}$${bytesToBase64Url(new Uint8Array(bits))}`
  };
}

async function verifyPassword(password, storedHash, storedSalt) {
  if (!storedHash || !storedSalt) return false;
  const [, iterationsText, salt] = storedHash.split("$");
  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;

  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(salt), iterations },
    key,
    256
  );
  const candidate = `pbkdf2-sha256$${iterations}$${salt}$${bytesToBase64Url(new Uint8Array(bits))}`;
  return timingSafeEqual(candidate, storedHash);
}

async function secretHash(value, env) {
  if (!env.SESSION_SECRET) throw statusError("missing_session_secret", 500);
  const secret = env.SESSION_SECRET;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, utf8(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function requestIpHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return secretHash(ip, env);
}

async function isLoginBlocked(env, email, ipHash) {
  const since = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM login_attempts
     WHERE success = 0 AND created_at > ? AND (email = ? OR ip_hash = ?)`
  ).bind(since, email, ipHash).first();
  return Number(row?.count || 0) >= LOGIN_MAX_ATTEMPTS;
}

async function recordLoginAttempt(env, email, ipHash, success) {
  await env.DB.prepare(
    "INSERT INTO login_attempts (id, email, ip_hash, success, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), email, ipHash, success ? 1 : 0, new Date().toISOString()).run();
}

function timingSafeEqual(a, b) {
  const left = utf8(a);
  const right = utf8(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

function sessionCookie(token, expiresAt) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expiresAt.toUTCString()}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key]) => key)
      .map(([key, ...value]) => [key, value.join("=")])
  );
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, ...headers }
  });
}

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders(),
      ...headers
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders()
    }
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders()).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function handleError(error, request) {
  const status = error.status || 500;
  if (wantsJson(request)) return jsonResponse({ error: error.message || "server_error" }, status);
  return htmlResponse(errorPage(error.message || "Error interno"), status);
}

function wantsJson(request) {
  return request.headers.get("Accept")?.includes("application/json");
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function githubError(data, status, path) {
  const error = new Error(data.message || "github_error");
  error.status = status;
  error.path = path;
  return error;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeBase64(value) {
  const bytes = utf8(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function utf8(value) {
  return new TextEncoder().encode(String(value));
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function loginPage(message = "") {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acceso - RADIO LA ISLA</title>
  <style>${loginCss()}</style>
</head>
<body>
  <main class="login-shell">
    <section class="login-card">
      <div class="brand">
        <img src="/assets/logo.webp" alt="RADIO LA ISLA" onerror="this.style.display='none'" />
        <div>
          <h1>RADIO LA ISLA</h1>
          <p>Panel protegido</p>
        </div>
      </div>
      ${message ? `<div class="form-error">${escapeHtml(message)}</div>` : ""}
      <form method="post" action="/api/login">
        <label>Correo
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <label>Contrase&ntilde;a
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Entrar</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function adminUsersPage(users, currentUser) {
  const rows = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${user.active ? "Activo" : "Inactivo"}</td>
      <td>${formatDate(user.last_login_at)}</td>
      <td>
        <form method="post" action="/api/admin/users/role" class="inline-form">
          <input type="hidden" name="id" value="${escapeHtml(user.id)}" />
          <select name="role">
            <option value="editor" ${user.role === "editor" ? "selected" : ""}>editor</option>
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
          </select>
          <button type="submit" class="secondary">Rol</button>
        </form>
        <form method="post" action="/api/admin/users/active" class="inline-form">
          <input type="hidden" name="id" value="${escapeHtml(user.id)}" />
          <input type="hidden" name="active" value="${user.active ? "0" : "1"}" />
          <button type="submit" class="${user.active ? "danger" : "secondary"}" ${user.id === currentUser.id && user.active ? "disabled" : ""}>
            ${user.active ? "Desactivar" : "Activar"}
          </button>
        </form>
        <form method="post" action="/api/admin/users/password" class="inline-form password-form">
          <input type="hidden" name="id" value="${escapeHtml(user.id)}" />
          <input name="password" type="password" placeholder="Nueva contrase&ntilde;a" minlength="${PASSWORD_MIN_LENGTH}" required />
          <button type="submit" class="secondary">Cambiar clave</button>
        </form>
      </td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Usuarios - RADIO LA ISLA</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand-shell">
      <span class="logo-frame"><img class="brand-logo" src="/assets/logo.webp" alt="Logo RADIO LA ISLA" /></span>
      <div class="brand-block">
        <h1>RADIO LA ISLA</h1>
        <p class="eyebrow">Administracion de usuarios</p>
        <p class="repo-summary">${escapeHtml(currentUser.email)} - ${escapeHtml(currentUser.role)}</p>
      </div>
    </div>
    <div class="topbar-actions">
      <a class="button-link secondary dark" href="/">Volver al panel</a>
      <form method="post" action="/api/logout"><button type="submit" class="secondary dark">Cerrar sesion</button></form>
    </div>
  </header>
  <main class="app-shell">
    <section class="workspace admin-workspace">
      <div class="tab-panel active">
        <div class="section-title">
          <div>
            <h2>Usuarios</h2>
            <p>Crea usuarios manualmente y gestiona roles de acceso.</p>
          </div>
        </div>
        <form method="post" action="/api/admin/users/create" class="tools-row admin-create-form">
          <label>Correo
            <input name="email" type="email" required />
          </label>
          <label>Contrase&ntilde;a inicial
            <input name="password" type="password" minlength="${PASSWORD_MIN_LENGTH}" required />
          </label>
          <label>Rol
            <select name="role">
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit">Crear usuario</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Correo</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Ultimo acceso</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="5" class="table-empty">No hay usuarios.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function forbiddenPage() {
  return basicPage("Acceso denegado", "Necesitas rol admin para entrar en esta seccion.", "/");
}

function notFoundPage() {
  return basicPage("No encontrado", "La ruta solicitada no existe.", "/");
}

function errorPage(message) {
  return basicPage("Error", message, "/");
}

function basicPage(title, message, href) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>${loginCss()}</style></head><body><main class="login-shell"><section class="login-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="text-link" href="${href}">Volver</a></section></main></body></html>`;
}

function loginCss() {
  return `
    :root { color-scheme: dark; --bg: #0f1b2d; --surface: #172a46; --muted: #a9b8d0; --text: #fff; --primary: #14b8a6; --border: rgba(255,255,255,.14); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(31,63,112,.55), transparent 34rem), var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    .login-shell { align-items: center; display: grid; min-height: 100vh; padding: 22px; }
    .login-card { background: rgba(23,42,70,.96); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 18px 40px rgba(0,0,0,.28); display: grid; gap: 18px; margin: auto; max-width: 430px; padding: 24px; width: 100%; }
    .brand { align-items: center; display: grid; gap: 14px; grid-template-columns: auto 1fr; }
    .brand img { background: #1f3f70; border-radius: 12px; height: 58px; object-fit: cover; width: 58px; }
    h1, p { margin: 0; }
    h1 { font-size: 1.65rem; line-height: 1; }
    p { color: var(--muted); }
    form { display: grid; gap: 14px; }
    label { color: var(--muted); display: grid; font-size: .9rem; font-weight: 800; gap: 7px; }
    input { background: rgba(11,20,36,.74); border: 1px solid var(--border); border-radius: 7px; color: var(--text); min-height: 44px; padding: 10px 12px; width: 100%; }
    button, .text-link { align-items: center; background: var(--primary); border: 0; border-radius: 7px; color: #04211e; cursor: pointer; display: inline-flex; font: inherit; font-weight: 850; justify-content: center; min-height: 44px; padding: 0 14px; text-decoration: none; }
    .form-error { background: rgba(239,68,68,.14); border: 1px solid rgba(239,68,68,.32); border-radius: 7px; color: #fecaca; font-weight: 750; padding: 10px 12px; }
  `;
}
