const OWNER = "rariolaisla";
const REPO = "rli";
const BRANCH = "main";
const DEFAULT_PANEL_ORIGIN = "https://panel.radiolaisla.es";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.PANEL_ORIGIN || DEFAULT_PANEL_ORIGIN;

    if (request.method === "OPTIONS") {
      return handleOptions(origin, allowedOrigin);
    }

    if (origin && origin !== allowedOrigin) {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }

    if (!env.GITHUB_TOKEN) {
      return jsonResponse({ error: "missing_github_token" }, 500, origin, allowedOrigin);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/file") {
        return await readFile(url, env, origin, allowedOrigin);
      }

      if (request.method === "PUT" && url.pathname === "/api/file") {
        return await updateFile(request, env, origin, allowedOrigin);
      }

      return jsonResponse({ error: "not_found" }, 404, origin, allowedOrigin);
    } catch (error) {
      return jsonResponse(
        { error: error.message || "worker_error", path: error.path },
        error.status || 500,
        origin,
        allowedOrigin
      );
    }
  }
};

async function readFile(url, env, origin, allowedOrigin) {
  const path = validatePath(url.searchParams.get("path"));
  const githubPath = encodePath(path);
  const githubUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${githubPath}?ref=${encodeURIComponent(BRANCH)}`;
  const response = await fetch(githubUrl, { headers: githubHeaders(env) });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw githubError(data, response.status, path);
  }

  return jsonResponse(
    {
      path,
      sha: data.sha,
      content: decodeBase64(data.content || "")
    },
    200,
    origin,
    allowedOrigin
  );
}

async function updateFile(request, env, origin, allowedOrigin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "invalid_json" }, 400, origin, allowedOrigin);
  }

  const path = validatePath(body.path);
  const content = typeof body.content === "string" ? body.content : "";
  const message = typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : `Actualizar ${path}`;

  const payload = {
    message,
    content: encodeBase64(content),
    branch: BRANCH
  };

  if (typeof body.sha === "string" && body.sha) {
    payload.sha = body.sha;
  }

  const githubPath = encodePath(path);
  const githubUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${githubPath}`;
  const response = await fetch(githubUrl, {
    method: "PUT",
    headers: {
      ...githubHeaders(env),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw githubError(data, response.status, path);
  }

  return jsonResponse(
    {
      path,
      sha: data.content?.sha || null
    },
    200,
    origin,
    allowedOrigin
  );
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
  if (typeof path !== "string" || !path.trim()) {
    const error = new Error("missing_path");
    error.status = 400;
    throw error;
  }

  const cleanPath = path.trim();
  const segments = cleanPath.split("/");
  const isUnsafe = cleanPath.startsWith("/") ||
    cleanPath.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..");

  if (isUnsafe) {
    const error = new Error("invalid_path");
    error.status = 400;
    throw error;
  }

  return cleanPath;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubError(data, status, path) {
  const error = new Error(data.message || "github_error");
  error.status = status;
  error.path = path;
  return error;
}

function handleOptions(origin, allowedOrigin) {
  if (origin !== allowedOrigin) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, allowedOrigin)
  });
}

function jsonResponse(data, status = 200, origin, allowedOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin, allowedOrigin)
    }
  });
}

function corsHeaders(origin, allowedOrigin) {
  if (origin !== allowedOrigin) return {};

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
