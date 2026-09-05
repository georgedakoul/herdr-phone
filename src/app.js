/**
 * The HTTP handler. No server of its own, so index.js, the tests and the fixture can all
 * mount the same function. One auth check at the top, then a flat route table.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { BadRequest, readJson, readForm, parseCookies, escapeHtml, requireId } from "./valid.js"
import { ansiToHtml } from "./ansi.js"
import { KEY_MAP } from "./herdr.js"

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url))
export const COOKIE = "herdr_phone"

/** Only these files are ever served from disk, so a path can never walk out of public/. */
const STATIC = {
  "/app.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json",
  "/icon.svg": "image/svg+xml",
}
const PUBLIC_PATHS = new Set(["/login", "/style.css", "/manifest.webmanifest", "/icon.svg"])

const STATUS_ORDER = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 }

const sha = (value) => createHash("sha256").update(String(value ?? "")).digest()

/** Hashing first means the compare is constant time whatever the lengths are. */
export const tokenMatches = (given, expected) => timingSafeEqual(sha(given), sha(expected))

export const sortAgents = (agents) =>
  [...agents].sort((a, b) => (STATUS_ORDER[a.agent_status] ?? 9) - (STATUS_ORDER[b.agent_status] ?? 9))

const isSecure = (req) => Boolean(req.socket?.encrypted) || req.headers["x-forwarded-proto"] === "https"

const cookieHeader = (value, req, maxAge) =>
  [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`, isSecure(req) ? "Secure" : ""]
    .filter(Boolean)
    .join("; ")

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers })
  res.end(body)
}

const json = (res, status, data) => send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" })
const html = (res, status, body, headers) => send(res, status, body, { "Content-Type": "text/html; charset=utf-8", ...headers })

function loginPage(message = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>herdr-phone login</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/style.css">
</head>
<body class="login">
<main>
<h1>herdr-phone</h1>
<p>Paste the token the server printed when it started.</p>
${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/login">
<label for="token">Token</label>
<input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`
}

export function createApp({ client, token }) {
  if (!token) throw new Error("createApp needs a token, auth is not optional")

  const routes = {
    "GET /api/agents": async () => {
      const snapshot = await client.snapshot()
      return { agents: sortAgents(snapshot.agents ?? []), workspaces: snapshot.workspaces ?? [], protocol: snapshot.protocol ?? null }
    },
    "GET /api/agent/:target": async ({ target, url }) => {
      const read = await client.agentRead(target, { lines: url.searchParams.get("lines") || undefined })
      return { text: read.text ?? "", truncated: Boolean(read.truncated), revision: read.revision ?? null, pane_id: read.pane_id ?? null }
    },
    "POST /api/agent/:target/prompt": async ({ target, req }) => {
      const body = await readJson(req)
      if (typeof body.text !== "string" || !body.text.trim()) throw new BadRequest("prompt text is empty")
      const agent = await client.prompt(target, body.text)
      return { ok: true, agent }
    },
    "POST /api/agent/:target/keys": async ({ target, req }) => {
      const body = await readJson(req)
      const key = String(body.key ?? "")
      if (!KEY_MAP[key]) throw new BadRequest(`unknown key "${key}"`)
      return { ok: true, ...(await client.sendKey(target, key)) }
    },
    "GET /api/pane/:target": async ({ target }) => {
      const read = await client.paneRead(target)
      return { html: ansiToHtml(read.text ?? ""), truncated: Boolean(read.truncated), revision: read.revision ?? null }
    },
    "GET /api/worktrees": async () => ({ worktrees: await client.worktrees() }),
    "GET /api/actions": async () => ({ actions: await client.actions() }),
    "POST /api/actions/invoke": async ({ req }) => {
      const body = await readJson(req)
      const pluginId = body.plugin_id ? String(body.plugin_id) : undefined
      const result = await client.invokeAction(String(body.action_id ?? ""), pluginId)
      return { ok: true, ...result }
    },
  }

  /** Matches "/api/agent/<id>/prompt" style paths against the table above. */
  function match(method, pathname) {
    const parts = pathname.split("/")
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(" ")
      if (m !== method) continue
      const want = pattern.split("/")
      if (want.length !== parts.length) continue
      let target
      let ok = true
      for (let i = 0; i < want.length; i += 1) {
        if (want[i] === ":target") target = parts[i]
        else if (want[i] !== parts[i]) { ok = false; break }
      }
      if (ok) return { handler: routes[key], target }
    }
    return null
  }

  return async function app(req, res) {
    const url = new URL(req.url, "http://localhost")
    const path = url.pathname
    const method = req.method === "HEAD" ? "GET" : req.method

    try {
      if (path === "/login") {
        if (method === "GET") return html(res, 200, loginPage())
        if (method === "POST") {
          const form = await readForm(req)
          if (tokenMatches(form.token, token)) {
            return send(res, 303, "", { Location: "/", "Set-Cookie": cookieHeader(token, req, 60 * 60 * 24 * 365) })
          }
          return html(res, 401, loginPage("That token did not match."))
        }
        return send(res, 405, "method not allowed")
      }

      const authed = tokenMatches(parseCookies(req.headers.cookie)[COOKIE] ?? "", token)

      if (path === "/logout" && method === "POST") {
        return send(res, 303, "", { Location: "/login", "Set-Cookie": cookieHeader("", req, 0) })
      }

      if (!authed && !PUBLIC_PATHS.has(path)) {
        if (path.startsWith("/api/")) return json(res, 401, { error: "not signed in" })
        return send(res, 302, "", { Location: "/login" })
      }

      if (method === "GET" && path === "/") {
        return html(res, 200, await readFile(`${PUBLIC_DIR}index.html`, "utf8"))
      }
      if (method === "GET" && STATIC[path]) {
        return send(res, 200, await readFile(`${PUBLIC_DIR}${path.slice(1)}`), { "Content-Type": STATIC[path] })
      }

      const route = match(method, path)
      if (!route) {
        if (path.startsWith("/api/")) return json(res, 404, { error: "no such route" })
        return send(res, 404, "not found")
      }
      if (route.target !== undefined) requireId(route.target, "target")
      return json(res, 200, await route.handler({ target: route.target, req, url }))
    } catch (error) {
      if (error instanceof BadRequest) return json(res, 400, { error: error.message })
      if (error?.status === 502 || error?.status === 503) return json(res, error.status, { error: error.message, code: error.code })
      console.error(`herdr-phone: ${req.method} ${path} failed:`, error)
      return json(res, 500, { error: "internal error" })
    }
  }
}
