import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createApp, sortAgents, tokenMatches, COOKIE } from "../src/app.js"
import { HerdrError } from "../src/herdr.js"

const TOKEN = "test-token-123"

/** A canned client with the same surface as createClient. */
function fakeClient(overrides = {}) {
  const calls = []
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args])
    if (value instanceof Error) throw value
    return typeof value === "function" ? value(...args) : value
  }
  const client = {
    snapshot: record("snapshot", { agents: [{ terminal_id: "a", agent_status: "idle" }, { terminal_id: "b", agent_status: "blocked" }], workspaces: [], protocol: 20 }),
    agentRead: record("agentRead", { pane_id: "p1", text: "line one\nline two", truncated: false, revision: 3 }),
    paneRead: record("paneRead", { text: `${String.fromCharCode(27)}[31m<b>${String.fromCharCode(27)}[0m`, truncated: false, revision: 4 }),
    prompt: record("prompt", { terminal_id: "a", agent_status: "working" }),
    sendKey: record("sendKey", { sent: ["esc"] }),
    worktrees: record("worktrees", [{ path: "/w", label: "w" }]),
    actions: record("actions", [{ plugin_id: "p", action_id: "x", title: "X", command: "x" }]),
    invokeAction: record("invokeAction", { action: { action_id: "x" }, log: "ran" }),
    ...overrides,
  }
  return { client, calls }
}

let server
let base
let fake

before(async () => {
  fake = fakeClient()
  server = createServer(createApp({ client: fake.client, token: TOKEN }))
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const authed = { cookie: `${COOKIE}=${TOKEN}` }
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: "manual" })
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" })

test("createApp refuses to run without a token", () => {
  assert.throws(() => createApp({ client: {}, token: "" }), /not optional/)
})

test("tokenMatches is exact and handles different lengths", () => {
  assert.equal(tokenMatches("abc", "abc"), true)
  assert.equal(tokenMatches("abc", "abcd"), false)
  assert.equal(tokenMatches("", "abc"), false)
  assert.equal(tokenMatches(undefined, "abc"), false)
})

test("sortAgents puts blocked first and does not mutate", () => {
  const input = [{ agent_status: "done" }, { agent_status: "idle" }, { agent_status: "blocked" }, { agent_status: "working" }, {}]
  const out = sortAgents(input)
  assert.deepEqual(out.map((a) => a.agent_status), ["blocked", "working", "idle", "done", undefined])
  assert.equal(input[0].agent_status, "done")
})

test("no cookie: api gets 401, pages redirect to login, login page is open", async () => {
  const api = await get("/api/agents")
  assert.equal(api.status, 401)
  assert.deepEqual(await api.json(), { error: "not signed in" })

  const page = await get("/")
  assert.equal(page.status, 302)
  assert.equal(page.headers.get("location"), "/login")

  const login = await get("/login")
  assert.equal(login.status, 200)
  assert.match(await login.text(), /<form method="post" action="\/login">/)

  const css = await get("/style.css")
  assert.equal(css.status, 200)
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8")

  const js = await get("/app.js")
  assert.equal(js.status, 302)
})

test("wrong token: cookie is rejected, form login shows the error", async () => {
  const api = await get("/api/agents", { cookie: `${COOKIE}=nope` })
  assert.equal(api.status, 401)

  const form = await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=nope", redirect: "manual" })
  assert.equal(form.status, 401)
  assert.equal(form.headers.get("set-cookie"), null)
  assert.match(await form.text(), /did not match/)
})

test("right token: form login sets a strict httpOnly cookie and redirects home", async () => {
  const form = await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${TOKEN}`, redirect: "manual" })
  assert.equal(form.status, 303)
  assert.equal(form.headers.get("location"), "/")
  const cookie = form.headers.get("set-cookie")
  assert.match(cookie, new RegExp(`^${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`))

  const proxied = await fetch(base + "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" }, body: `token=${TOKEN}`, redirect: "manual" })
  assert.match(proxied.headers.get("set-cookie"), /; Secure$/)
})

test("logout clears the cookie", async () => {
  const res = await post("/logout", "", authed)
  assert.equal(res.status, 303)
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/)
})

test("home shell and static files are served when signed in", async () => {
  const home = await get("/", authed)
  assert.equal(home.status, 200)
  assert.match(home.headers.get("content-type"), /text\/html/)
  assert.equal(home.headers.get("cache-control"), "no-store")
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/)
  const js = await get("/app.js", authed)
  assert.equal(js.status, 200)
  const missing = await get("/../package.json", authed)
  assert.notEqual(missing.status, 200)
})

test("agents are listed blocked first", async () => {
  const res = await get("/api/agents", authed)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.agents.map((a) => a.terminal_id), ["b", "a"])
  assert.equal(body.protocol, 20)
})

test("agent transcript, prompt and keys reach the client with validated ids", async () => {
  const read = await get("/api/agent/a?lines=50", authed)
  assert.deepEqual(await read.json(), { text: "line one\nline two", truncated: false, revision: 3, pane_id: "p1" })
  assert.deepEqual(fake.calls.at(-1), ["agentRead", "a", { lines: "50" }])

  const prompt = await post("/api/agent/a/prompt", { text: "hello there" }, authed)
  assert.equal(prompt.status, 200)
  assert.equal((await prompt.json()).agent.agent_status, "working")
  assert.deepEqual(fake.calls.at(-1), ["prompt", "a", "hello there"])

  const keys = await post("/api/agent/a/keys", { key: "esc" }, authed)
  assert.deepEqual(await keys.json(), { ok: true, sent: ["esc"] })
  assert.deepEqual(fake.calls.at(-1), ["sendKey", "a", "esc"])

  const before = fake.calls.length
  const bad = await get("/api/agent/a%20b", authed)
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: "invalid target" })
  assert.equal(fake.calls.length, before)
})

test("pane read comes back as escaped html", async () => {
  const res = await get("/api/pane/p1", authed)
  const body = await res.json()
  assert.equal(body.html, `<span style="color:#e05561">&lt;b&gt;</span>`)
  assert.deepEqual(fake.calls.at(-1), ["paneRead", "p1"])
})

test("worktrees, actions and invoke", async () => {
  assert.deepEqual(await (await get("/api/worktrees", authed)).json(), { worktrees: [{ path: "/w", label: "w" }] })
  assert.deepEqual((await (await get("/api/actions", authed)).json()).actions[0].action_id, "x")
  const inv = await post("/api/actions/invoke", { action_id: "x", plugin_id: "p" }, authed)
  assert.deepEqual(await inv.json(), { ok: true, action: { action_id: "x" }, log: "ran" })
  assert.deepEqual(fake.calls.at(-1), ["invokeAction", "x", "p"])
  const noPlugin = await post("/api/actions/invoke", { action_id: "x" }, authed)
  assert.equal(noPlugin.status, 200)
  assert.deepEqual(fake.calls.at(-1), ["invokeAction", "x", undefined])
})

test("bad bodies are 400 with a message, never a stack trace", async () => {
  const notJson = await post("/api/agent/a/prompt", "{oops", authed)
  assert.equal(notJson.status, 400)
  assert.deepEqual(await notJson.json(), { error: "body is not JSON" })

  const empty = await post("/api/agent/a/prompt", { text: "" }, authed)
  assert.equal(empty.status, 400)

  const huge = await post("/api/agent/a/prompt", JSON.stringify({ text: "x".repeat(70 * 1024) }), authed)
  assert.equal(huge.status, 400)
  assert.deepEqual(await huge.json(), { error: "body too large" })

  const badKey = await post("/api/agent/a/keys", { key: "ctrl-c" }, authed)
  assert.equal(badKey.status, 400)
})

test("herdr errors map to 502 and 503 with the herdr message", async () => {
  const down = fakeClient({ snapshot: async () => { throw new HerdrError("server_not_running", "no server") } })
  const s = createServer(createApp({ client: down.client, token: TOKEN }))
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const b = `http://127.0.0.1:${s.address().port}`
  try {
    const res = await fetch(`${b}/api/agents`, { headers: authed })
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: "no server", code: "server_not_running" })
    const generic = fakeClient({ worktrees: async () => { throw new HerdrError("weird", "odd thing") } })
    const s2 = createServer(createApp({ client: generic.client, token: TOKEN }))
    await new Promise((r) => s2.listen(0, "127.0.0.1", r))
    try {
      const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/worktrees`, { headers: authed })
      assert.equal(r2.status, 502)
    } finally {
      s2.close()
    }
  } finally {
    s.close()
  }
})

test("unexpected errors are a plain 500", async () => {
  const boom = fakeClient({ actions: async () => { throw new TypeError("undefined is not a function") } })
  const s = createServer(createApp({ client: boom.client, token: TOKEN }))
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const original = console.error
  console.error = () => {}
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/actions`, { headers: authed })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: "internal error" })
  } finally {
    console.error = original
    s.close()
  }
})

test("unknown api routes are 404 json, unknown pages 404 text", async () => {
  const api = await get("/api/nope", authed)
  assert.equal(api.status, 404)
  assert.deepEqual(await api.json(), { error: "no such route" })
  const page = await get("/nope", authed)
  assert.equal(page.status, 404)
})

test("ids with a colon survive the percent encoding the client applies", async () => {
  const res = await get(`/api/agent/${encodeURIComponent("w1:p1")}`, authed)
  assert.equal(res.status, 200)
  assert.deepEqual(fake.calls.at(-1), ["agentRead", "w1:p1", { lines: undefined }])
  const bad = await get("/api/agent/%E0%A4%A", authed)
  assert.equal(bad.status, 400)
})

test("key names that live on Object.prototype are unknown keys, not a 500", async () => {
  for (const key of ["constructor", "__proto__", "toString"]) {
    const res = await post("/api/agent/a/keys", JSON.stringify({ key }), authed)
    assert.equal(res.status, 400, key)
    assert.deepEqual(await res.json(), { error: `unknown key "${key}"` })
  }
})
