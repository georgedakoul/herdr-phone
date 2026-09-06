// Routes added for full control: happy paths against a recording client, and 400s against
// the real client with a fake run, so the validation in src/herdr.js is exercised end to end.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createApp, COOKIE } from "../src/app.js"
import { createClient } from "../src/herdr.js"

const TOKEN = "route-token"
const authed = { cookie: `${COOKIE}=${TOKEN}` }

/** A client that records every call and answers with a canned value. */
function recorder() {
  const calls = []
  const client = new Proxy(
    {},
    {
      get: (_, name) => {
        if (name === "snapshot") return async () => SNAPSHOT
        if (name === "then") return undefined
        return async (...args) => {
          calls.push([name, ...args])
          return { name }
        }
      },
    },
  )
  return { client, calls }
}

const SNAPSHOT = {
  protocol: 20,
  workspaces: [{ workspace_id: "w1", label: "Home", focused: true, active_tab_id: "w1:t1" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "one", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true, agent: "claude", agent_status: "idle" }],
  agents: [{ pane_id: "w1:p1", agent_status: "idle" }],
  layouts: [{ tab_id: "w1:t1", zoomed: true, focused_pane_id: "w1:p1" }, { tab_id: "w1:t2", zoomed: false, focused_pane_id: "w1:p2" }],
  focused_workspace_id: "w1",
  focused_tab_id: "w1:t1",
  focused_pane_id: "w1:p1",
}

/** The real client on a run that never spawns: validation happens before run is reached. */
function strictClient() {
  const argv = []
  const run = async (_bin, args) => {
    argv.push(args)
    return { stdout: JSON.stringify({ id: 1, result: { pane: { pane_id: "w1:p9" }, agent: {} } }), stderr: "" }
  }
  return { client: createClient({ bin: "herdr", run }), argv }
}

let happy, strict, happyBase, strictBase, servers

before(async () => {
  happy = recorder()
  strict = strictClient()
  servers = [createServer(createApp({ client: happy.client, token: TOKEN })), createServer(createApp({ client: strict.client, token: TOKEN }))]
  for (const s of servers) await new Promise((r) => s.listen(0, "127.0.0.1", r))
  happyBase = `http://127.0.0.1:${servers[0].address().port}`
  strictBase = `http://127.0.0.1:${servers[1].address().port}`
})
after(() => servers.forEach((s) => s.close()))

const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie: authed.cookie }, body: JSON.stringify(body) })
const get = (base, path) => fetch(base + path, { headers: authed })

async function okPost(path, body, expected) {
  const res = await post(happyBase, path, body)
  assert.equal(res.status, 200, `${path} ${await res.clone().text()}`)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.deepEqual(happy.calls.at(-1), expected, path)
  return json
}

async function badPost(path, body, pattern) {
  const before = strict.argv.length
  const res = await post(strictBase, path, body)
  assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`)
  const json = await res.json()
  assert.match(json.error, pattern, path)
  assert.equal(strict.argv.length, before, `${path} must not spawn herdr on a bad body`)
}

test("kinds and layout come from the client and the snapshot", async () => {
  const kinds = await get(happyBase, "/api/kinds")
  assert.equal(kinds.status, 200)
  assert.deepEqual(await kinds.json(), { name: "kinds" })

  const layout = await get(happyBase, "/api/layout")
  assert.equal(layout.status, 200)
  assert.deepEqual(await layout.json(), {
    workspaces: SNAPSHOT.workspaces,
    tabs: SNAPSHOT.tabs,
    panes: SNAPSHOT.panes,
    zoomed: ["w1:p1"],
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
  })
})

test("layout tolerates a snapshot with missing groups", async () => {
  const { client } = recorder()
  const bare = { ...client, snapshot: async () => ({ protocol: 20 }) }
  const s = createServer(createApp({ client: bare, token: TOKEN }))
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/layout`, { headers: authed })
    assert.deepEqual(await res.json(), { workspaces: [], tabs: [], panes: [], zoomed: [], focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null })
  } finally {
    s.close()
  }
})

test("agents/start passes only the known fields, as strings", async () => {
  const json = await okPost("/api/agents/start", { name: "bot", kind: "claude", pane: "w1:p1", direction: "down", extra: "no", timeout: 5000 }, [
    "startAgent",
    { name: "bot", kind: "claude", pane: "w1:p1", direction: "down", timeout: 5000 },
  ])
  assert.equal(json.name, "startAgent")
  await okPost("/api/agents/start", { name: "bot", kind: "claude", pane: "" }, ["startAgent", { name: "bot", kind: "claude" }])
})

test("agent routes", async () => {
  await okPost("/api/agent/w1%3Ap1/rename", { name: "bot" }, ["renameAgent", "w1:p1", "bot"])
  await okPost("/api/agent/w1%3Ap1/rename", { clear: true }, ["renameAgent", "w1:p1", null])
  await okPost("/api/agent/w1%3Ap1/focus", {}, ["focusAgent", "w1:p1"])
  await okPost("/api/agent/w1%3Ap1/wait", { until: ["idle", "done"], timeout: 3000 }, ["waitAgent", "w1:p1", { until: ["idle", "done"], timeout: 3000 }])
  await okPost("/api/agent/w1%3Ap1/wait", {}, ["waitAgent", "w1:p1", {}])
  const explain = await get(happyBase, "/api/agent/w1%3Ap1/explain")
  assert.equal(explain.status, 200)
  assert.deepEqual(happy.calls.at(-1), ["explainAgent", "w1:p1"])
})

test("pane routes", async () => {
  const split = await okPost("/api/pane/w1%3Ap1/split", { direction: "down", cwd: "/tmp/x" }, ["splitPane", "w1:p1", { direction: "down", cwd: "/tmp/x" }])
  assert.deepEqual(split.pane, { name: "splitPane" })
  await okPost("/api/pane/w1%3Ap1/split", {}, ["splitPane", "w1:p1", {}])
  await okPost("/api/pane/w1%3Ap1/close", {}, ["closePane", "w1:p1"])
  await okPost("/api/pane/w1%3Ap1/zoom", {}, ["zoomPane", "w1:p1", "toggle"])
  await okPost("/api/pane/w1%3Ap1/zoom", { mode: "on" }, ["zoomPane", "w1:p1", "on"])
  await okPost("/api/pane/w1%3Ap1/rename", { label: "left" }, ["renamePane", "w1:p1", "left"])
  await okPost("/api/pane/w1%3Ap1/rename", { clear: true }, ["renamePane", "w1:p1", null])
  await okPost("/api/pane/w1%3Ap1/run", { command: "ls" }, ["runInPane", "w1:p1", "ls"])
  await okPost("/api/pane/w1%3Ap1/text", { text: "hi" }, ["sendText", "w1:p1", "hi"])
  await okPost("/api/pane/w1%3Ap1/keys", { key: "enter" }, ["paneSendKey", "w1:p1", "enter"])
  await okPost("/api/pane/w1%3Ap1/move", { new_tab: true, label: "x" }, ["movePane", "w1:p1", { new_tab: true, label: "x" }])
  await okPost("/api/pane/w1%3Ap1/swap", { with: "w1:p2" }, ["swapPanes", "w1:p1", "w1:p2"])
  await okPost("/api/pane/w1%3Ap1/resize", { direction: "left", amount: 0.2 }, ["resizePane", "w1:p1", "left", 0.2])
  await okPost("/api/pane/w1%3Ap1/resize", { direction: "up" }, ["resizePane", "w1:p1", "up", undefined])
})

test("workspace, tab, worktree and notify routes", async () => {
  await okPost("/api/workspaces", { cwd: "/tmp", label: "L" }, ["createWorkspace", { cwd: "/tmp", label: "L" }])
  await okPost("/api/workspace/w1/focus", {}, ["focusWorkspace", "w1"])
  await okPost("/api/workspace/w1/rename", { label: "New" }, ["renameWorkspace", "w1", "New"])
  await okPost("/api/workspace/w1/close", {}, ["closeWorkspace", "w1"])
  await okPost("/api/tabs", { workspace: "w1", label: "T" }, ["createTab", { workspace: "w1", label: "T" }])
  await okPost("/api/tab/w1%3At1/focus", {}, ["focusTab", "w1:t1"])
  await okPost("/api/tab/w1%3At1/rename", { label: "T2" }, ["renameTab", "w1:t1", "T2"])
  await okPost("/api/tab/w1%3At1/close", {}, ["closeTab", "w1:t1"])
  await okPost("/api/worktrees", { workspace: "w1", branch: "feat", base: "main", label: "F" }, ["createWorktree", { workspace: "w1", branch: "feat", base: "main", label: "F" }])
  await okPost("/api/worktrees/open", { branch: "feat" }, ["openWorktree", { branch: "feat" }])
  await okPost("/api/worktrees/remove", { workspace: "w2", force: true }, ["removeWorktree", "w2", true])
  await okPost("/api/worktrees/remove", { workspace: "w2" }, ["removeWorktree", "w2", false])
  await okPost("/api/notify", { title: "Done", body: "b", position: "top-right", sound: "done" }, ["notify", { title: "Done", body: "b", position: "top-right", sound: "done" }])
})

test("bad bodies are 400 from the real validation and never reach herdr", async () => {
  await badPost("/api/agents/start", { name: "Bad Name", kind: "claude" }, /invalid agent name/)
  await badPost("/api/agents/start", { name: "bot", kind: "notakind" }, /invalid kind/)
  await badPost("/api/agents/start", { name: "bot", kind: "claude", direction: "left" }, /invalid direction/)
  await badPost("/api/agents/start", { name: "bot", kind: "claude", pane: "bad id" }, /invalid pane/)
  await badPost("/api/agent/w1%3Ap1/rename", { name: "-x" }, /invalid agent name/)
  await badPost("/api/agent/w1%3Ap1/wait", { until: ["asleep"] }, /invalid state/)
  await badPost("/api/pane/w1%3Ap1/split", { direction: "up" }, /invalid direction/)
  await badPost("/api/pane/w1%3Ap1/split", { cwd: "-x" }, /cannot start with "-"/)
  await badPost("/api/pane/w1%3Ap1/zoom", { mode: "big" }, /invalid zoom mode/)
  await badPost("/api/pane/w1%3Ap1/rename", { label: "" }, /invalid label/)
  await badPost("/api/pane/w1%3Ap1/run", { command: "--help" }, /cannot start with "-"/)
  await badPost("/api/pane/w1%3Ap1/text", {}, /invalid text/)
  await badPost("/api/pane/w1%3Ap1/keys", { key: "nope" }, /unknown key/)
  await badPost("/api/pane/w1%3Ap1/move", {}, /move needs/)
  await badPost("/api/pane/w1%3Ap1/move", { tab: "bad id" }, /invalid tab/)
  await badPost("/api/pane/w1%3Ap1/swap", {}, /invalid pane id/)
  await badPost("/api/pane/w1%3Ap1/resize", { direction: "left", amount: 2 }, /invalid amount/)
  await badPost("/api/pane/w1%3Ap1/resize", { direction: "sideways" }, /invalid direction/)
  await badPost("/api/workspaces", { label: "-l" }, /cannot start with "-"/)
  await badPost("/api/workspace/w1/rename", {}, /invalid label/)
  await badPost("/api/tabs", { workspace: "w 1" }, /invalid workspace/)
  await badPost("/api/tab/w1%3At1/rename", { label: "x".repeat(121) }, /invalid label/)
  await badPost("/api/worktrees", { workspace: "w1" }, /invalid branch/)
  await badPost("/api/worktrees/open", {}, /open needs/)
  await badPost("/api/worktrees/remove", {}, /invalid workspace/)
  await badPost("/api/notify", { body: "no title" }, /invalid title/)
  await badPost("/api/notify", { title: "t", sound: "loud" }, /invalid sound/)
})

test("a good body on the real client spawns exactly one herdr call with the right argv", async () => {
  const res = await post(strictBase, "/api/pane/w1%3Ap1/rename", { label: "left" })
  assert.equal(res.status, 200)
  assert.deepEqual(strict.argv.at(-1), ["pane", "rename", "w1:p1", "left"])
  const notify = await post(strictBase, "/api/notify", { title: "Hi", sound: "done" })
  assert.equal(notify.status, 200)
  assert.deepEqual(strict.argv.at(-1), ["notification", "show", "Hi", "--sound", "done"])
})

test("bad ids in the path are 400 before any client call", async () => {
  const before = happy.calls.length
  const res = await post(happyBase, "/api/pane/bad%20id/close", {})
  assert.equal(res.status, 400)
  assert.equal(happy.calls.length, before)
})
