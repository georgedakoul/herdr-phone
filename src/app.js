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
import { createGate, GLOBAL } from "./gate.js"

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
const statusRank = (status) => (Object.hasOwn(STATUS_ORDER, status) ? STATUS_ORDER[status] : 9)

const sha = (value) => createHash("sha256").update(String(value ?? "")).digest()

/** Hashing first means the compare is constant time whatever the lengths are. */
export const tokenMatches = (given, expected) => timingSafeEqual(sha(given), sha(expected))

export const sortAgents = (agents) =>
  [...agents].sort((a, b) => statusRank(a.agent_status) - statusRank(b.agent_status))

const isSecure = (req) => Boolean(req.socket?.encrypted) || req.headers["x-forwarded-proto"] === "https"

/**
 * Who a login attempt is being counted against. Behind `tailscale serve` every connection
 * arrives from 127.0.0.1, so the socket address alone tells us nothing and these headers are
 * what separate one phone from another. A process on this machine can forge them, which is why
 * a global counter sits underneath this one.
 */
export const sourceOf = (req) => {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
  const account = String(req.headers["tailscale-user-login"] ?? "").trim()
  return `${forwarded || req.socket?.remoteAddress || "unknown"} ${account}`.trim()
}

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

export function createApp({ client, token, alert = null }) {
  if (!token) throw new Error("createApp needs a token, auth is not optional")

  // Per device, then a backstop that no forged header can dodge.
  const perSource = createGate()
  const anyone = createGate({ free: 10 })

  /**
   * Queued as a microtask, so the response is already written by the time the SMTP session
   * starts. A login must never wait on mail, or fail because mail failed.
   */
  const notify = (subject, lines) => {
    if (!alert) return
    Promise.resolve()
      .then(() => alert({ subject, body: lines.join("\n") }))
      .catch((error) => console.error(`herdr-phone: alert not sent: ${error.message}`))
  }

  const details = (req, key) => [
    `Source: ${key}`,
    `Browser: ${req.headers["user-agent"] ?? "none sent"}`,
    `Time: ${new Date().toISOString()}`,
    "",
    "These details come from request headers and are a label, not proof of who it was.",
  ]

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
      if (!Object.hasOwn(KEY_MAP, key)) throw new BadRequest(`unknown key "${key}"`)
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

    // Full control. The client validates every field and builds the argv, so a route
    // only hands the body fields over, through pick() where a call takes an options object.
    // Anything wrong is a BadRequest from there.
    "GET /api/kinds": () => client.kinds(),
    "GET /api/layout": async () => {
      const snapshot = await client.snapshot()
      return {
        workspaces: snapshot.workspaces ?? [],
        tabs: snapshot.tabs ?? [],
        panes: snapshot.panes ?? [],
        zoomed: (snapshot.layouts ?? []).filter((l) => l.zoomed).map((l) => l.focused_pane_id).filter(Boolean),
        focused_workspace_id: snapshot.focused_workspace_id ?? null,
        focused_tab_id: snapshot.focused_tab_id ?? null,
        focused_pane_id: snapshot.focused_pane_id ?? null,
      }
    },
    "POST /api/agents/start": async ({ req }) => {
      const body = await readJson(req)
      return { ok: true, ...(await client.startAgent(pick(body, "name", "kind", "pane", "direction", "cwd", "timeout"))) }
    },
    "POST /api/agent/:target/rename": async ({ target, req }) => done(client.renameAgent(target, await nameOrClear(req, "name"))),
    "POST /api/agent/:target/focus": ({ target }) => done(client.focusAgent(target)),
    "GET /api/agent/:target/explain": ({ target }) => client.explainAgent(target),
    "POST /api/agent/:target/wait": async ({ target, req }) => {
      const body = await readJson(req)
      return { ok: true, agent: await client.waitAgent(target, pick(body, "until", "timeout")) }
    },
    "POST /api/pane/:target/split": async ({ target, req }) => {
      const body = await readJson(req)
      return { ok: true, pane: await client.splitPane(target, pick(body, "direction", "cwd")) }
    },
    "POST /api/pane/:target/close": ({ target }) => done(client.closePane(target)),
    "POST /api/pane/:target/zoom": async ({ target, req }) => done(client.zoomPane(target, (await readJson(req)).mode ?? "toggle")),
    "POST /api/pane/:target/rename": async ({ target, req }) => done(client.renamePane(target, await nameOrClear(req, "label"))),
    "POST /api/pane/:target/run": async ({ target, req }) => done(client.runInPane(target, (await readJson(req)).command)),
    "POST /api/pane/:target/text": async ({ target, req }) => done(client.sendText(target, (await readJson(req)).text)),
    "POST /api/pane/:target/keys": async ({ target, req }) => {
      const key = String((await readJson(req)).key ?? "")
      return { ok: true, ...(await client.paneSendKey(target, key)) }
    },
    "POST /api/pane/:target/move": async ({ target, req }) => done(client.movePane(target, await readJson(req))),
    "POST /api/pane/:target/swap": async ({ target, req }) => done(client.swapPanes(target, (await readJson(req)).with)),
    "POST /api/pane/:target/resize": async ({ target, req }) => {
      const body = await readJson(req)
      return done(client.resizePane(target, body.direction, body.amount))
    },
    "POST /api/workspaces": async ({ req }) => done(client.createWorkspace(pick(await readJson(req), "cwd", "label"))),
    "POST /api/workspace/:target/focus": ({ target }) => done(client.focusWorkspace(target)),
    "POST /api/workspace/:target/rename": async ({ target, req }) => done(client.renameWorkspace(target, (await readJson(req)).label)),
    "POST /api/workspace/:target/close": ({ target }) => done(client.closeWorkspace(target)),
    "POST /api/tabs": async ({ req }) => done(client.createTab(pick(await readJson(req), "workspace", "cwd", "label"))),
    "POST /api/tab/:target/focus": ({ target }) => done(client.focusTab(target)),
    "POST /api/tab/:target/rename": async ({ target, req }) => done(client.renameTab(target, (await readJson(req)).label)),
    "POST /api/tab/:target/close": ({ target }) => done(client.closeTab(target)),
    "POST /api/worktrees": async ({ req }) =>
      done(client.createWorktree(pick(await readJson(req), "workspace", "cwd", "branch", "base", "path", "label"))),
    "POST /api/worktrees/open": async ({ req }) => done(client.openWorktree(pick(await readJson(req), "path", "branch", "label"))),
    "POST /api/worktrees/remove": async ({ req }) => {
      const body = await readJson(req)
      return done(client.removeWorktree(body.workspace, Boolean(body.force)))
    },
    "POST /api/notify": async ({ req }) => done(client.notify(pick(await readJson(req), "title", "body", "position", "sound"))),
  }

  /** The named fields only, as strings, so a body cannot smuggle extra options into a client call. */
  function pick(body, ...names) {
    const out = {}
    for (const name of names) {
      const value = body[name]
      if (value === undefined || value === null || value === "") continue
      out[name] = Array.isArray(value) ? value.map(String) : typeof value === "number" ? value : String(value)
    }
    return out
  }

  /** A rename body carries the new value, or clear:true. */
  async function nameOrClear(req, field) {
    const body = await readJson(req)
    if (body.clear === true) return null
    return body[field]
  }

  /** Writes answer ok plus whatever herdr returned, which the phone shows or ignores. */
  const done = async (promise) => ({ ok: true, result: (await promise) ?? null })

  /** Ids such as "w1:p1" arrive percent encoded. A malformed escape becomes an empty id, which fails requireId with a 400. */
  const decodeSegment = (segment) => {
    try { return decodeURIComponent(segment) } catch { return "" }
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
        if (want[i] === ":target") target = decodeSegment(parts[i])
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
          const key = sourceOf(req)
          const waits = [perSource.check(key), anyone.check(GLOBAL)].filter((result) => !result.ok)
          if (waits.length) {
            // Refuse outright rather than sleeping. Holding the socket open for the wait would
            // hand out a cheaper attack than the one being prevented.
            const retryAfter = Math.max(...waits.map((result) => result.retryAfter))
            return html(res, 429, loginPage(`Too many wrong tries. Try again in ${retryAfter}s.`), { "Retry-After": String(retryAfter) })
          }
          if (tokenMatches(form.token, token)) {
            const source = perSource.pass(key)
            const overall = anyone.pass(GLOBAL)
            if (source.hadTripped || overall.hadTripped) {
              notify("herdr-phone: signed in after failed tries", [
                "Someone signed in successfully from a source that had been refused for guessing.",
                ...details(req, key),
              ])
            }
            return send(res, 303, "", { Location: "/", "Set-Cookie": cookieHeader(token, req, 60 * 60 * 24 * 365) })
          }
          const source = perSource.fail(key)
          const overall = anyone.fail(GLOBAL)
          const tripped = source.tripped ? source : overall.tripped ? overall : null
          if (tripped) {
            notify("herdr-phone: too many wrong passwords", [
              `${tripped.fails} wrong passwords in a row.`,
              `Further tries are refused for ${Math.round(tripped.waitMs / 1000)}s, doubling after that.`,
              ...details(req, key),
            ])
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
