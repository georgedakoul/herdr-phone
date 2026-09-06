/**
 * The control methods added for full control from the phone: every one is checked for
 * the exact argv it hands to herdr, and for refusing bad input before anything is spawned.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createClient, parseIntegrationStatus, KINDS, MAX_WAIT_MS } from "../src/herdr.js"

function fakeRun(answers) {
  const calls = []
  const run = async (bin, args, options) => {
    calls.push({ bin, args, options })
    const key = args.slice(0, 2).join(" ")
    const answer = answers[key] ?? answers["*"] ?? { stdout: "" }
    return { error: answer.error ?? null, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
  }
  return { run, calls }
}

const ok = (result) => ({ stdout: JSON.stringify({ id: 1, result }) })
const err = (code, message) => ({ stdout: JSON.stringify({ id: 1, error: { code, message } }) })
const last = (fake) => fake.calls.at(-1).args

const INTEGRATION_TEXT = [
  "pi: not installed (/x/pi.sh)",
  "claude: current (v8) (/x/claude.ps1)",
  "codex: not installed (/x/codex.sh)",
  "antigravity-cli: outdated (v2, latest v3) (/x/agy.sh)",
  "opencode: installed (/x/opencode.sh)",
  "mystery: current (/x/mystery.sh)",
  "claude: current (v8) (/x/claude.sh)",
  "",
].join("\n")

test("parseIntegrationStatus keeps installed kinds, maps antigravity-cli, drops unknown and duplicates", () => {
  assert.deepEqual(parseIntegrationStatus(INTEGRATION_TEXT), ["claude", "agy", "opencode"])
  assert.deepEqual(parseIntegrationStatus(""), [])
  assert.deepEqual(parseIntegrationStatus(null), [])
})

test("kinds() runs integration status and returns installed plus the allowlist", async () => {
  const fake = fakeRun({ "integration status": { stdout: INTEGRATION_TEXT } })
  const client = createClient({ run: fake.run })
  assert.deepEqual(await client.kinds(), { installed: ["claude", "agy", "opencode"], all: KINDS })
  assert.deepEqual(last(fake), ["integration", "status"])
  assert.equal(KINDS.length, 22)
})

test("startAgent splits the focused pane in its cwd, then starts the agent with a capped timeout", async () => {
  const fake = fakeRun({
    "pane current": ok({ pane: { pane_id: "w1:p4", cwd: "/home/dev/src/app" }, type: "pane_current" }),
    "pane split": ok({ pane: { pane_id: "w1:p9" }, type: "pane_split" }),
    "agent start": ok({ agent: { name: "docs", status: "idle" }, type: "agent_info" }),
  })
  const client = createClient({ run: fake.run })
  const result = await client.startAgent({ name: "docs", kind: "claude" })
  assert.deepEqual(result, { pane_id: "w1:p9", agent: { name: "docs", status: "idle" }, ready: true })
  assert.deepEqual(fake.calls.map((c) => c.args), [
    ["pane", "current"],
    ["pane", "split", "w1:p4", "--direction", "right", "--cwd", "/home/dev/src/app", "--no-focus"],
    ["agent", "start", "docs", "--kind", "claude", "--pane", "w1:p9", "--timeout", String(MAX_WAIT_MS)],
  ])
  assert.equal(fake.calls.at(-1).options.timeout, MAX_WAIT_MS + 5000)
})

test("startAgent takes a chosen pane, direction and shorter timeout", async () => {
  const fake = fakeRun({
    "pane get": ok({ pane: { pane_id: "w1:p3", cwd: "/home/dev/src/other" } }),
    "pane split": ok({ pane: { pane_id: "w1:p5" } }),
    "agent start": ok({ agent: { name: "tests" } }),
  })
  const client = createClient({ run: fake.run })
  await client.startAgent({ name: "tests", kind: "codex", pane: "w1:p3", direction: "down", timeout: 10_000 })
  assert.deepEqual(fake.calls[0].args, ["pane", "get", "w1:p3"])
  assert.deepEqual(fake.calls[1].args, ["pane", "split", "w1:p3", "--direction", "down", "--cwd", "/home/dev/src/other", "--no-focus"])
  assert.deepEqual(fake.calls[2].args, ["agent", "start", "tests", "--kind", "codex", "--pane", "w1:p5", "--timeout", "10000"])
})

test("startAgent reports agent_not_ready as ready:false with the pane that now exists", async () => {
  const fake = fakeRun({
    "pane current": ok({ pane: { pane_id: "w1:p4", cwd: "/home/dev" } }),
    "pane split": ok({ pane: { pane_id: "w1:p9" } }),
    "agent start": err("agent_not_ready", "agent did not become ready in 120000 ms"),
  })
  const client = createClient({ run: fake.run })
  const result = await client.startAgent({ name: "slow", kind: "claude" })
  assert.deepEqual(result, { pane_id: "w1:p9", agent: null, ready: false, message: "agent did not become ready in 120000 ms" })
})

test("startAgent passes other herdr errors through and refuses bad input before spawning", async () => {
  const fake = fakeRun({
    "pane current": ok({ pane: { pane_id: "w1:p4", cwd: "/home/dev" } }),
    "pane split": err("pane_not_found", "no such pane"),
  })
  const client = createClient({ run: fake.run })
  await assert.rejects(client.startAgent({ name: "x", kind: "claude" }), (e) => e.code === "pane_not_found" && e.status === 502)
  const before = fake.calls.length
  await assert.rejects(client.startAgent({ name: "Bad Name", kind: "claude" }), (e) => e.status === 400)
  await assert.rejects(client.startAgent({ name: "ok", kind: "bash" }), (e) => e.status === 400 && e.message === "invalid kind")
  await assert.rejects(client.startAgent({ name: "ok", kind: "claude", direction: "left" }), (e) => e.status === 400)
  await assert.rejects(client.startAgent({ name: "ok", kind: "claude", pane: "a b" }), (e) => e.status === 400)
  assert.equal(fake.calls.length, before)
})

test("startAgent fails clearly when there is no pane or the split returns none", async () => {
  const noPane = fakeRun({ "pane current": ok({ pane: {} }) })
  await assert.rejects(createClient({ run: noPane.run }).startAgent({ name: "a", kind: "claude" }), (e) => e.code === "no_pane")
  const noSplit = fakeRun({ "pane current": ok({ pane: { pane_id: "w1:p1" } }), "pane split": ok({ type: "ok" }) })
  await assert.rejects(createClient({ run: noSplit.run }).startAgent({ name: "a", kind: "claude" }), (e) => e.code === "bad_response")
})

test("agent rename, clear, focus, explain and wait build the right argv", async () => {
  const fake = fakeRun({
    "agent explain": { stdout: "docs is idle\r\nlast line\r\n" },
    "agent wait": ok({ agent: { name: "docs", status: "idle" } }),
    "*": ok({ type: "ok" }),
  })
  const client = createClient({ run: fake.run })

  await client.renameAgent("w1:p3", "writer")
  assert.deepEqual(last(fake), ["agent", "rename", "w1:p3", "writer"])
  await client.renameAgent("w1:p3", null)
  assert.deepEqual(last(fake), ["agent", "rename", "w1:p3", "--clear"])
  await assert.rejects(client.renameAgent("w1:p3", "Bad"), (e) => e.status === 400)

  await client.focusAgent("docs")
  assert.deepEqual(last(fake), ["agent", "focus", "docs"])

  assert.deepEqual(await client.explainAgent("docs"), { text: "docs is idle\nlast line" })
  assert.deepEqual(last(fake), ["agent", "explain", "docs"])

  assert.deepEqual(await client.waitAgent("docs"), { name: "docs", status: "idle" })
  assert.deepEqual(last(fake), ["agent", "wait", "docs", "--timeout", "120000"])
  await client.waitAgent("docs", { until: ["idle", "blocked"], timeout: 5000 })
  assert.deepEqual(last(fake), ["agent", "wait", "docs", "--until", "idle", "--until", "blocked", "--timeout", "5000"])
  assert.equal(fake.calls.at(-1).options.timeout, 10_000)
  await client.waitAgent("docs", { until: "done", timeout: 999_999 })
  assert.deepEqual(last(fake), ["agent", "wait", "docs", "--until", "done", "--timeout", "120000"])
  await assert.rejects(client.waitAgent("docs", { until: ["running"] }), (e) => e.status === 400 && e.message === "invalid state")
})

test("pane split, close, zoom, rename, run, send-text and send-keys", async () => {
  const fake = fakeRun({ "pane split": ok({ pane: { pane_id: "w1:p8" } }), "*": ok({ type: "ok" }) })
  const client = createClient({ run: fake.run })

  assert.deepEqual(await client.splitPane("w1:p3"), { pane_id: "w1:p8" })
  assert.deepEqual(last(fake), ["pane", "split", "w1:p3", "--direction", "right", "--no-focus"])
  await client.splitPane("w1:p3", { direction: "down", cwd: "/home/dev" })
  assert.deepEqual(last(fake), ["pane", "split", "w1:p3", "--direction", "down", "--cwd", "/home/dev", "--no-focus"])
  await assert.rejects(client.splitPane("w1:p3", { cwd: "-x" }), (e) => e.status === 400)

  await client.closePane("w1:p8")
  assert.deepEqual(last(fake), ["pane", "close", "w1:p8"])

  await client.zoomPane("w1:p8")
  assert.deepEqual(last(fake), ["pane", "zoom", "w1:p8", "--toggle"])
  await client.zoomPane("w1:p8", "off")
  assert.deepEqual(last(fake), ["pane", "zoom", "w1:p8", "--off"])
  await assert.rejects(client.zoomPane("w1:p8", "--on"), (e) => e.status === 400)

  await client.renamePane("w1:p8", "build log")
  assert.deepEqual(last(fake), ["pane", "rename", "w1:p8", "build log"])
  await client.renamePane("w1:p8", null)
  assert.deepEqual(last(fake), ["pane", "rename", "w1:p8", "--clear"])

  await client.runInPane("w1:p8", "npm test")
  assert.deepEqual(last(fake), ["pane", "run", "w1:p8", "npm test"])
  await assert.rejects(client.runInPane("w1:p8", "--version"), (e) => e.status === 400)
  await assert.rejects(client.runInPane("w1:p8", ""), (e) => e.status === 400)

  await client.sendText("w1:p8", "hello there")
  assert.deepEqual(last(fake), ["pane", "send-text", "w1:p8", "hello there"])

  assert.deepEqual(await client.paneSendKey("w1:p8", "yes"), { sent: ["y", "enter"] })
  assert.deepEqual(last(fake), ["pane", "send-keys", "w1:p8", "y", "enter"])
  await assert.rejects(client.paneSendKey("w1:p8", "constructor"), (e) => e.status === 400)
})

test("pane move, swap and resize", async () => {
  const fake = fakeRun({ "*": ok({ type: "ok" }) })
  const client = createClient({ run: fake.run })

  await client.movePane("w1:p8", { new_tab: true })
  assert.deepEqual(last(fake), ["pane", "move", "w1:p8", "--new-tab"])
  await client.movePane("w1:p8", { new_tab: true, workspace: "w2", label: "logs" })
  assert.deepEqual(last(fake), ["pane", "move", "w1:p8", "--new-tab", "--workspace", "w2", "--label", "logs"])
  await client.movePane("w1:p8", { new_workspace: true, label: "spike" })
  assert.deepEqual(last(fake), ["pane", "move", "w1:p8", "--new-workspace", "--label", "spike"])
  await client.movePane("w1:p8", { tab: "w1:t2", split: "down", target_pane: "w1:p3" })
  assert.deepEqual(last(fake), ["pane", "move", "w1:p8", "--tab", "w1:t2", "--split", "down", "--target-pane", "w1:p3", "--no-focus"])
  await client.movePane("w1:p8", { tab: "w1:t2" })
  assert.deepEqual(last(fake), ["pane", "move", "w1:p8", "--tab", "w1:t2", "--split", "right", "--no-focus"])
  await assert.rejects(client.movePane("w1:p8", {}), (e) => e.status === 400)
  await assert.rejects(client.movePane("w1:p8", { tab: "w1:t2", split: "left" }), (e) => e.status === 400)

  await client.swapPanes("w1:p8", "w1:p3")
  assert.deepEqual(last(fake), ["pane", "swap", "--source-pane", "w1:p8", "--target-pane", "w1:p3"])

  await client.resizePane("w1:p8", "left")
  assert.deepEqual(last(fake), ["pane", "resize", "--pane", "w1:p8", "--direction", "left"])
  await client.resizePane("w1:p8", "up", 0.25)
  assert.deepEqual(last(fake), ["pane", "resize", "--pane", "w1:p8", "--direction", "up", "--amount", "0.25"])
  await assert.rejects(client.resizePane("w1:p8", "sideways"), (e) => e.status === 400)
  await assert.rejects(client.resizePane("w1:p8", "up", 5), (e) => e.status === 400 && e.message === "invalid amount")
  await assert.rejects(client.resizePane("w1:p8", "up", "abc"), (e) => e.status === 400)
})

test("workspace and tab create, focus, rename, close", async () => {
  const fake = fakeRun({ "*": ok({ type: "ok" }) })
  const client = createClient({ run: fake.run })

  await client.createWorkspace()
  assert.deepEqual(last(fake), ["workspace", "create", "--no-focus"])
  await client.createWorkspace({ cwd: "/home/dev/src/app", label: "app" })
  assert.deepEqual(last(fake), ["workspace", "create", "--cwd", "/home/dev/src/app", "--label", "app", "--no-focus"])
  await client.focusWorkspace("w2")
  assert.deepEqual(last(fake), ["workspace", "focus", "w2"])
  await client.renameWorkspace("w2", "the app")
  assert.deepEqual(last(fake), ["workspace", "rename", "w2", "the app"])
  await assert.rejects(client.renameWorkspace("w2", ""), (e) => e.status === 400)
  await client.closeWorkspace("w2")
  assert.deepEqual(last(fake), ["workspace", "close", "w2"])

  await client.createTab({ workspace: "w1", cwd: "/home/dev", label: "shell" })
  assert.deepEqual(last(fake), ["tab", "create", "--workspace", "w1", "--cwd", "/home/dev", "--label", "shell", "--no-focus"])
  await client.createTab()
  assert.deepEqual(last(fake), ["tab", "create", "--no-focus"])
  await client.focusTab("w1:t2")
  assert.deepEqual(last(fake), ["tab", "focus", "w1:t2"])
  await client.renameTab("w1:t2", "tests")
  assert.deepEqual(last(fake), ["tab", "rename", "w1:t2", "tests"])
  await client.closeTab("w1:t2")
  assert.deepEqual(last(fake), ["tab", "close", "w1:t2"])
  await assert.rejects(client.closeTab("w1 t2"), (e) => e.status === 400)
})

test("worktree create, open and remove", async () => {
  const fake = fakeRun({ "*": ok({ type: "ok" }) })
  const client = createClient({ run: fake.run })

  await client.createWorktree({ workspace: "w1", branch: "feature/x" })
  assert.deepEqual(last(fake), ["worktree", "create", "--workspace", "w1", "--branch", "feature/x", "--no-focus"])
  await client.createWorktree({ cwd: "/home/dev/src/app", branch: "spike", base: "main", path: "/home/dev/src/app-spike", label: "spike" })
  assert.deepEqual(last(fake), [
    "worktree", "create", "--cwd", "/home/dev/src/app", "--branch", "spike", "--base", "main",
    "--path", "/home/dev/src/app-spike", "--label", "spike", "--no-focus",
  ])
  await assert.rejects(client.createWorktree({ workspace: "w1" }), (e) => e.status === 400 && e.message === "invalid branch")
  await assert.rejects(client.createWorktree({ workspace: "w1", branch: "-D" }), (e) => e.status === 400)
  await client.createWorktree({ workspace: "w1", branch: "b".repeat(512) })
  await assert.rejects(client.createWorktree({ workspace: "w1", branch: "b".repeat(513) }), (e) => e.status === 400)

  await client.openWorktree({ path: "/home/dev/src/app-spike" })
  assert.deepEqual(last(fake), ["worktree", "open", "--path", "/home/dev/src/app-spike", "--no-focus"])
  await client.openWorktree({ branch: "spike", label: "spike" })
  assert.deepEqual(last(fake), ["worktree", "open", "--branch", "spike", "--label", "spike", "--no-focus"])
  await assert.rejects(client.openWorktree({}), (e) => e.status === 400)

  await client.removeWorktree("w3")
  assert.deepEqual(last(fake), ["worktree", "remove", "--workspace", "w3"])
  await client.removeWorktree("w3", true)
  assert.deepEqual(last(fake), ["worktree", "remove", "--workspace", "w3", "--force"])
})

test("notify builds notification show with the optional flags", async () => {
  const fake = fakeRun({ "*": ok({ type: "ok" }) })
  const client = createClient({ run: fake.run })
  await client.notify({ title: "Build done" })
  assert.deepEqual(last(fake), ["notification", "show", "Build done"])
  await client.notify({ title: "Build done", body: "all green", position: "top-right", sound: "done" })
  assert.deepEqual(last(fake), ["notification", "show", "Build done", "--body", "all green", "--position", "top-right", "--sound", "done"])
  await assert.rejects(client.notify({ title: "" }), (e) => e.status === 400)
  await assert.rejects(client.notify({ title: "x", position: "middle" }), (e) => e.status === 400)
  await assert.rejects(client.notify({ title: "x", sound: "loud" }), (e) => e.status === 400)
})

test("paneCurrent and paneGet unwrap the pane", async () => {
  const fake = fakeRun({ "pane current": ok({ pane: { pane_id: "w1:p4" } }), "pane get": ok({ pane: { pane_id: "w1:p3", cwd: "/x" } }) })
  const client = createClient({ run: fake.run })
  assert.deepEqual(await client.paneCurrent(), { pane_id: "w1:p4" })
  assert.deepEqual(await client.paneGet("w1:p3"), { pane_id: "w1:p3", cwd: "/x" })
  assert.deepEqual(last(fake), ["pane", "get", "w1:p3"])
  await assert.rejects(client.paneGet("nope nope"), (e) => e.status === 400)
})
