import { test } from "node:test"
import assert from "node:assert/strict"
import { createClient, parseEnvelope, parseJsonOutput, parseReadOutput, checkProtocol, HerdrError, KEY_MAP, PINNED_PROTOCOL } from "../src/herdr.js"

/** A fake run that records the argv it was given and answers from a table. */
function fakeRun(answers) {
  const calls = []
  const run = async (bin, args) => {
    calls.push({ bin, args })
    const key = args.slice(0, 2).join(" ")
    const answer = answers[key] ?? answers["*"] ?? { stdout: "" }
    return { error: answer.error ?? null, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
  }
  return { run, calls }
}

const ok = (result) => ({ stdout: JSON.stringify({ id: 1, result }) })
const err = (code, message) => ({ stdout: JSON.stringify({ id: 1, error: { code, message } }) })

const STATUS_RUNNING = {
  client: { version: "0.8.2", channel: "stable", protocol: 20, binary: "/somewhere/herdr", session: null },
  server: { status: "running", running: true, version: "0.8.2", protocol: 20, capabilities: [], compatible: true, socket: "/tmp/x.sock", restart_needed: false },
  update: { restart_needed: false },
}
const STATUS_DOWN = {
  client: { version: "0.8.2", channel: "stable", protocol: 20, binary: "/somewhere/herdr", session: null },
  server: { status: "not_running", running: false, version: null, protocol: null, capabilities: null, compatible: null, socket: "/tmp/x.sock", restart_needed: false },
  update: { restart_needed: false },
}

test("parseEnvelope unwraps a success result", () => {
  const r = parseEnvelope(JSON.stringify({ id: 7, result: { type: "ok" } }))
  assert.deepEqual(r, { type: "ok" })
})

test("parseEnvelope throws on an error body even when the exit code was zero", () => {
  assert.throws(
    () => parseEnvelope(JSON.stringify({ id: 1, error: { code: "server_not_running", message: "no server" } })),
    (e) => e instanceof HerdrError && e.code === "server_not_running" && e.status === 503 && e.message === "no server",
  )
  assert.throws(() => parseEnvelope(JSON.stringify({ id: 1, error: {} })), (e) => e.code === "herdr_error" && e.status === 502)
})

test("parseEnvelope accepts a bare result with a type and refuses anything else", () => {
  assert.deepEqual(parseEnvelope('{"type":"pong","version":"0.8.2"}'), { type: "pong", version: "0.8.2" })
  assert.throws(() => parseEnvelope('{"hello":1}'), (e) => e.code === "bad_response")
  assert.throws(() => parseEnvelope("[1,2]"), (e) => e.code === "bad_response")
})

test("parseJsonOutput finds the JSON under a printed note", () => {
  assert.deepEqual(parseJsonOutput('note: updating\n{"id":1,"result":{"type":"ok"}}\n'), { id: 1, result: { type: "ok" } })
  assert.throws(() => parseJsonOutput(""), (e) => e.code === "empty_response")
  assert.throws(() => parseJsonOutput("   \n"), (e) => e.code === "empty_response")
  assert.throws(() => parseJsonOutput("usage: herdr ..."), (e) => e.code === "bad_response")
})

test("a binary that cannot be started is a clear cli_failed error", async () => {
  const { run } = fakeRun({ "*": { error: Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }) } })
  const client = createClient({ bin: "herdr", run })
  await assert.rejects(client.snapshot(), (e) => e.code === "cli_failed" && e.message.includes("is herdr installed"))
})

test("a non-zero exit with output still reads the body", async () => {
  const { run } = fakeRun({ "api snapshot": { ...err("boom", "it broke"), error: Object.assign(new Error("exit 1"), { code: 1 }) } })
  await assert.rejects(createClient({ run }).snapshot(), (e) => e.code === "boom" && e.message === "it broke")
})

test("a non-zero exit with no output uses stderr", async () => {
  const { run } = fakeRun({ "*": { error: new Error("exit 2"), stderr: "bad flag" } })
  await assert.rejects(createClient({ run }).worktrees(), (e) => e.code === "cli_failed" && e.message === "bad flag")
})

test("snapshot, read, prompt, keys, worktrees and actions build the documented argv", async () => {
  const { run, calls } = fakeRun({
    "api snapshot": ok({ type: "session_snapshot", snapshot: { version: 1, protocol: 20, workspaces: [], tabs: [], panes: [], layouts: [], agents: [{ terminal_id: "t1", agent_status: "blocked" }] } }),
    "agent read": { stdout: "hello\r\nworld\r\n" },
    "pane read": { stdout: "raw" },
    "agent prompt": ok({ type: "agent_prompted", agent: { terminal_id: "t1", agent_status: "working" } }),
    "agent send-keys": ok({ type: "ok" }),
    "worktree list": ok({ type: "worktree_list", source: "cwd", worktrees: [{ path: "/w", label: "w", branch: "main" }] }),
    "plugin action": ok({ type: "plugin_action_list", actions: [{ plugin_id: "p", action_id: "a", title: "A", command: "x" }] }),
  })
  const client = createClient({ bin: "/opt/herdr", run })

  const snap = await client.snapshot()
  assert.equal(snap.agents[0].agent_status, "blocked")
  assert.deepEqual(calls.at(-1).args, ["api", "snapshot"])
  assert.equal(calls.at(-1).bin, "/opt/herdr")

  const read = await client.agentRead("t1", { lines: 99999 })
  assert.deepEqual(read, { text: "hello\nworld\n", truncated: false, revision: null })
  assert.deepEqual(calls.at(-1).args, ["agent", "read", "t1", "--source", "recent", "--format", "text", "--lines", "5000"])

  await client.agentRead("t1", { source: "visible" })
  assert.deepEqual(calls.at(-1).args, ["agent", "read", "t1", "--source", "visible", "--format", "text"])

  const pane = await client.paneRead("p1")
  assert.equal(pane.text, "raw")
  assert.deepEqual(calls.at(-1).args, ["pane", "read", "p1", "--source", "visible", "--format", "ansi"])

  const agent = await client.prompt("t1", "do the thing; rm -rf / && echo $(x)")
  assert.equal(agent.agent_status, "working")
  assert.deepEqual(calls.at(-1).args, ["agent", "prompt", "t1", "do the thing; rm -rf / && echo $(x)"])

  assert.deepEqual(await client.sendKey("t1", "yes"), { sent: ["y", "enter"] })
  assert.deepEqual(calls.at(-1).args, ["agent", "send-keys", "t1", "y", "enter"])
  await client.sendKey("t1", "esc")
  assert.deepEqual(calls.at(-1).args, ["agent", "send-keys", "t1", "esc"])

  const wts = await client.worktrees()
  assert.equal(wts[0].label, "w")
  assert.deepEqual(calls.at(-1).args, ["worktree", "list"])

  const actions = await client.actions()
  assert.equal(actions[0].action_id, "a")
  assert.deepEqual(calls.at(-1).args, ["plugin", "action", "list"])
})

test("invokeAction passes the plugin only when given and reports the log", async () => {
  const { run, calls } = fakeRun({ "plugin action": ok({ type: "plugin_action_invoked", action: { action_id: "a" }, context: {}, log: "done" }) })
  const client = createClient({ run })
  assert.deepEqual(await client.invokeAction("a"), { action: { action_id: "a" }, log: "done" })
  assert.deepEqual(calls.at(-1).args, ["plugin", "action", "invoke", "a"])
  await client.invokeAction("a", "p")
  assert.deepEqual(calls.at(-1).args, ["plugin", "action", "invoke", "a", "--plugin", "p"])
})

test("ids are refused before any process is started", async () => {
  const { run, calls } = fakeRun({})
  const client = createClient({ run })
  await assert.rejects(client.agentRead("a b"), (e) => e.status === 400 && e.message === "invalid agent")
  await assert.rejects(client.paneRead("../x"), (e) => e.status === 400 && e.message === "invalid pane id")
  await assert.rejects(client.prompt("t1", "   "), (e) => e.status === 400 && e.message === "prompt text is empty")
  await assert.rejects(client.prompt("bad id", "x"), (e) => e.status === 400)
  await assert.rejects(client.sendKey("t1", "ctrl-c"), (e) => e.status === 400 && e.message.includes("unknown key"))
  await assert.rejects(client.invokeAction("a", "bad plugin"), (e) => e.status === 400 && e.message === "invalid plugin id")
  assert.equal(calls.length, 0)
})

test("missing optional fields come back as empty, not as a crash", async () => {
  const { run } = fakeRun({ "*": ok({ type: "whatever" }) })
  const client = createClient({ run })
  assert.deepEqual(await client.snapshot(), {})
  assert.deepEqual(await client.worktrees(), [])
  assert.deepEqual(await client.actions(), [])
  assert.deepEqual(await client.agentRead("t1"), { text: "", truncated: false, revision: null })
  assert.deepEqual(await client.invokeAction("a"), { action: {}, log: null })
})

test("status reads herdr status --json which is not an envelope", async () => {
  const { run, calls } = fakeRun({ "status --json": { stdout: JSON.stringify(STATUS_DOWN) } })
  const status = await createClient({ run }).status()
  assert.equal(status.server.running, false)
  assert.deepEqual(calls[0].args, ["status", "--json"])
})

test("checkProtocol refuses a dead server, a wrong protocol, and accepts a match", () => {
  const down = checkProtocol(STATUS_DOWN)
  assert.equal(down.ok, false)
  assert.match(down.message, /no herdr server is running/)
  assert.match(down.message, /x\.sock/)

  const wrong = checkProtocol({ ...STATUS_RUNNING, server: { ...STATUS_RUNNING.server, protocol: 21 } })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /protocol 21/)
  assert.match(wrong.message, /written for 20/)
  assert.match(wrong.message, /0\.8\.2/)
  assert.match(wrong.message, /HERDR_PROTOCOL=21/)

  const fine = checkProtocol(STATUS_RUNNING)
  assert.equal(fine.ok, true)
  assert.equal(fine.message, "herdr 0.8.2, protocol 20")

  const forced = checkProtocol({ ...STATUS_RUNNING, server: { ...STATUS_RUNNING.server, protocol: 21 } }, 21)
  assert.equal(forced.ok, true)
  assert.equal(checkProtocol(undefined).ok, false)
  assert.equal(PINNED_PROTOCOL, 20)
})

test("the key map matches the spec", () => {
  assert.deepEqual(Object.keys(KEY_MAP).sort(), ["down", "enter", "esc", "no", "up", "yes"])
  assert.deepEqual(KEY_MAP.no, ["n", "enter"])
})

test("read output is pane text, except a one-line error envelope for a bad target", async () => {
  assert.deepEqual(parseReadOutput("plain\r\ntext"), { text: "plain\ntext", truncated: false, revision: null })
  assert.deepEqual(parseReadOutput('{"a": 1}\nsecond line'), { text: '{"a": 1}\nsecond line', truncated: false, revision: null })
  assert.deepEqual(parseReadOutput("{not json"), { text: "{not json", truncated: false, revision: null })
  assert.deepEqual(parseReadOutput(""), { text: "", truncated: false, revision: null })
  assert.throws(() => parseReadOutput(JSON.stringify({ id: 1, error: { code: "agent_not_found", message: "no" } })), (e) => e.code === "agent_not_found")
  const { run } = fakeRun({ "agent read": err("agent_not_found", "no such agent") })
  await assert.rejects(createClient({ run }).agentRead("term_1"), (e) => e.code === "agent_not_found")
})
