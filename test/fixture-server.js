#!/usr/bin/env node
// Serves the real app over a canned herdr client so the UI can be looked at
// and screenshotted without a herdr session. Token is always "fixture".
// The session state is mutable so every write the phone can do shows up on the next poll.
import { createServer } from "node:http"
import { createApp } from "../src/app.js"
import { HerdrError, KINDS } from "../src/herdr.js"

const ESC = String.fromCharCode(27)
const sgr = (codes, text) => `${ESC}[${codes}m${text}${ESC}[0m`

// One session: two workspaces, three tabs, five panes, four of them running an agent.
const workspaces = [
  { workspace_id: "ws-1", label: "api", number: 1, active_tab_id: "ws-1:t1" },
  { workspace_id: "ws-2", label: "retry", number: 2, active_tab_id: "ws-2:t1" },
]
const tabs = [
  { tab_id: "ws-1:t1", workspace_id: "ws-1", label: "agents", number: 1 },
  { tab_id: "ws-1:t2", workspace_id: "ws-1", label: "shell", number: 2 },
  { tab_id: "ws-2:t1", workspace_id: "ws-2", label: "docs", number: 1 },
]
const panes = [
  { pane_id: "pane-2", tab_id: "ws-1:t1", workspace_id: "ws-1", terminal_id: "term-2", agent: "claude", agent_session: "api refactor", agent_status: "blocked", cwd: "~/src/api", revision: 41, tokens: 88210 },
  { pane_id: "pane-3", tab_id: "ws-1:t1", workspace_id: "ws-1", terminal_id: "term-3", agent: "codex", agent_session: "tests", agent_status: "working", cwd: "~/src/api", revision: 7, tokens: 3020 },
  { pane_id: "pane-5", tab_id: "ws-1:t2", workspace_id: "ws-1", terminal_id: "term-5", agent: null, agent_session: null, agent_status: null, cwd: "~/src/api", revision: 1, terminal_title: "zsh" },
  { pane_id: "pane-1", tab_id: "ws-2:t1", workspace_id: "ws-2", terminal_id: "term-1", agent: "claude", agent_session: "docs", agent_status: "idle", cwd: "~/src/docs-site", revision: 3, tokens: 12400 },
  { pane_id: "pane-4", tab_id: "ws-2:t1", workspace_id: "ws-2", terminal_id: "term-4", agent: "claude", agent_session: "changelog", agent_status: "done", cwd: "~/src/docs-site", revision: 2, tokens: 640 },
]
const focus = { workspace_id: "ws-1", tab_id: "ws-1:t1", pane_id: "pane-2" }
const zoomed = new Set()
let nextId = 6

const transcripts = {
  "pane-2": [
    "> Refactor the payment handler so retries are idempotent.",
    "",
    "I found the retry loop in src/payments/handler.js. The idempotency key",
    "is generated after the first attempt, so a retry can double charge.",
    "",
    "Plan:",
    "  1. generate the key before the loop",
    "  2. store it on the request context",
    "  3. add a test that replays the same request twice",
    "",
    "This touches a money path. Do you want me to continue? (y/n)",
    "",
    "────────────────────────────────────────────────────────────────────",
    "│ claude-opus-5 │ ctx 41% │ 5h 32% resets 14:00 │ 7d 10% │ $0.42 │   ",
    "────────────────────────────────────────────────────────────────────",
  ].join("\n"),
}

const paneText = {
  "pane-2": [
    `${sgr("1;36", "api refactor")} ${sgr("90", "claude · ~/src/api")}`,
    "",
    `${sgr("32", "✔")} read src/payments/handler.js`,
    `${sgr("32", "✔")} read test/payments.test.js`,
    `${sgr("33", "●")} plan ready, waiting for approval`,
    "",
    `${sgr("1;31", "?")} ${sgr("1", "This touches a money path. Continue?")} ${sgr("2", "(y/n)")}`,
    "",
    `${sgr("38;5;208", "tokens")} 88 210   ${sgr("38;5;39", "ctx")} 41%   ${sgr("38;2;140;194;101", "cost")} $0.42`,
  ].join("\n"),
}

const worktrees = [
  { path: "/home/dev/src/api", label: "api", branch: "main", open_workspace_id: "ws-1" },
  { path: "/home/dev/src/api-wt/retry-idempotency", label: "retry-idempotency", branch: "feat/retry-idempotency", open_workspace_id: "ws-2" },
  { path: "/home/dev/src/docs-site", label: "docs-site", branch: "main" },
  { path: "/home/dev/src/api-wt/old-spike", label: "old-spike", branch: "spike/old", is_prunable: true },
]

const actions = [
  { plugin_id: "git-tools", action_id: "fetch-all", title: "Fetch all remotes", description: "git fetch --all --prune in every worktree" },
  { plugin_id: "git-tools", action_id: "prune-worktrees", title: "Prune stale worktrees" },
  { plugin_id: "notify", action_id: "ping", title: "Ping the desktop", description: "Sends a desktop notification so you can find the window" },
]

let revision = 41
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pane = (target) => panes.find((p) => p.pane_id === target || p.terminal_id === target || (p.agent_session === target && p.agent))
const need = (target) => {
  const p = pane(target)
  if (!p) throw new HerdrError("pane_not_found", `no pane ${target}`)
  return p
}
const workspace = (id) => {
  const w = workspaces.find((x) => x.workspace_id === id)
  if (!w) throw new HerdrError("workspace_not_found", `no workspace ${id}`)
  return w
}
const tab = (id) => {
  const t = tabs.find((x) => x.tab_id === id)
  if (!t) throw new HerdrError("tab_not_found", `no tab ${id}`)
  return t
}
const withFocus = (list, key) => list.map((item) => ({ ...item, focused: item[key] === focus[key] }))

function addPane(tabId, cwd, extra = {}) {
  const t = tab(tabId)
  const p = { pane_id: `pane-${nextId}`, tab_id: t.tab_id, workspace_id: t.workspace_id, terminal_id: `term-${nextId}`, agent: null, agent_session: null, agent_status: null, cwd, revision: 1, terminal_title: "zsh", ...extra }
  nextId += 1
  panes.push(p)
  revision += 1
  return p
}
function addTab(workspaceId, cwd, label) {
  const w = workspace(workspaceId)
  const t = { tab_id: `${w.workspace_id}:t${nextId}`, workspace_id: w.workspace_id, label: label ?? `tab ${nextId}`, number: tabs.filter((x) => x.workspace_id === w.workspace_id).length + 1 }
  nextId += 1
  tabs.push(t)
  const p = addPane(t.tab_id, cwd ?? "~")
  return { tab: t, root_pane: p }
}
function addWorkspace(cwd, label) {
  const w = { workspace_id: `ws-${nextId}`, label: label ?? `workspace ${nextId}`, number: workspaces.length + 1, active_tab_id: null }
  nextId += 1
  workspaces.push(w)
  const made = addTab(w.workspace_id, cwd, "main")
  w.active_tab_id = made.tab.tab_id
  return { workspace: w, ...made }
}
function dropPane(id) {
  const i = panes.findIndex((p) => p.pane_id === id)
  if (i >= 0) panes.splice(i, 1)
  zoomed.delete(id)
  delete transcripts[id]
  delete paneText[id]
  revision += 1
}
function dropTab(id) {
  for (const p of panes.filter((x) => x.tab_id === id)) dropPane(p.pane_id)
  const i = tabs.findIndex((t) => t.tab_id === id)
  if (i >= 0) tabs.splice(i, 1)
}
function dropWorkspace(id) {
  for (const t of tabs.filter((x) => x.workspace_id === id)) dropTab(t.tab_id)
  const i = workspaces.findIndex((w) => w.workspace_id === id)
  if (i >= 0) workspaces.splice(i, 1)
  for (const wt of worktrees) if (wt.open_workspace_id === id) delete wt.open_workspace_id
}
function focusPane(p) {
  focus.pane_id = p.pane_id
  focus.tab_id = p.tab_id
  focus.workspace_id = p.workspace_id
  workspace(p.workspace_id).active_tab_id = p.tab_id
}
const appendText = (id, line) => { paneText[id] = `${paneText[id] ?? ""}\n${line}`; revision += 1 }
const ok = async () => ({})

const client = {
  async status() { return { client: { version: "0.8.2", protocol: 20 }, server: { status: "running", running: true, version: "0.8.2", protocol: 20 } } },
  async snapshot() {
    const agents = withFocus(panes, "pane_id").filter((p) => p.agent).map((p) => ({ ...p, name: p.agent_session }))
    return {
      protocol: 20,
      version: "0.8.2",
      agents,
      workspaces: withFocus(workspaces, "workspace_id").map((w) => ({ ...w, tab_count: tabs.filter((t) => t.workspace_id === w.workspace_id).length, pane_count: panes.filter((p) => p.workspace_id === w.workspace_id).length })),
      tabs: withFocus(tabs, "tab_id").map((t) => ({ ...t, pane_count: panes.filter((p) => p.tab_id === t.tab_id).length })),
      panes: withFocus(panes, "pane_id"),
      layouts: tabs.map((t) => ({ tab_id: t.tab_id, workspace_id: t.workspace_id, zoomed: panes.some((p) => p.tab_id === t.tab_id && zoomed.has(p.pane_id)), focused_pane_id: panes.find((p) => p.tab_id === t.tab_id && zoomed.has(p.pane_id))?.pane_id ?? null })),
      focused_workspace_id: focus.workspace_id,
      focused_tab_id: focus.tab_id,
      focused_pane_id: focus.pane_id,
    }
  },
  async agentRead(target) {
    const p = pane(target)
    const text = transcripts[p?.pane_id] ?? `> Working in ${p?.cwd ?? "?"}\n\n(no recent output)`
    return { text, truncated: false, revision, pane_id: p?.pane_id ?? null }
  },
  async paneRead(paneId) { return { text: paneText[paneId] ?? `${sgr("90", "(empty pane)")}`, truncated: false, revision } },
  async prompt(target, text) {
    const p = need(target)
    p.agent_status = "working"
    p.revision += 1
    transcripts[p.pane_id] = `${transcripts[p.pane_id] ?? ""}\n\n> ${text}\n\nOn it.`
    revision += 1
    return { ...p }
  },
  async sendKey(target, name) {
    const p = need(target)
    if (name === "yes") p.agent_status = "working"
    if (name === "esc") p.agent_status = "idle"
    p.revision += 1
    revision += 1
    return { sent: [name] }
  },
  async worktrees() { return worktrees },
  async actions() { return actions },
  async invokeAction(actionId) {
    await sleep(400)
    return { action: { action_id: actionId }, log: `ran ${actionId} in 3 worktrees` }
  },

  // Full control.
  async kinds() { return { installed: ["claude", "codex"], all: KINDS } },
  async paneCurrent() { return { ...need(focus.pane_id) } },
  async paneGet(id) { return { ...need(id) } },
  async startAgent({ name, kind, pane: target, direction = "right" }) {
    const source = target ? need(target) : need(focus.pane_id)
    const p = addPane(source.tab_id, source.cwd, { split: direction })
    await sleep(600)
    if (name === "stuck") return { pane_id: p.pane_id, agent: null, ready: false, message: "agent did not become ready in time" }
    Object.assign(p, { agent: kind, agent_session: name, agent_status: "idle", tokens: 0 })
    transcripts[p.pane_id] = `> ${kind} started as ${name}\n\nReady.`
    return { pane_id: p.pane_id, agent: { ...p }, ready: true }
  },
  async renameAgent(target, name) { const p = need(target); p.agent_session = name; p.revision += 1; revision += 1; return { agent: { ...p } } },
  async focusAgent(target) { focusPane(need(target)); return { agent: { ...need(target) } } },
  async explainAgent(target) {
    const p = need(target)
    return { text: `Agent ${p.agent_session ?? "(unnamed)"} (${p.agent}) in pane ${p.pane_id} is ${p.agent_status}.\nWorking directory: ${p.cwd}\nLast change: revision ${p.revision}` }
  },
  async waitAgent(target, { until = [] } = {}) {
    const p = need(target)
    await sleep(800)
    if (p.agent_status === "working") p.agent_status = "idle"
    return { ...p, waited_for: until }
  },
  async splitPane(id, { direction = "right", cwd } = {}) { const s = need(id); return { ...addPane(s.tab_id, cwd ?? s.cwd, { split: direction }) } },
  async closePane(id) { need(id); dropPane(id); return {} },
  async zoomPane(id, mode = "toggle") {
    need(id)
    const on = mode === "on" || (mode === "toggle" && !zoomed.has(id))
    if (on) zoomed.add(id)
    else zoomed.delete(id)
    revision += 1
    return { zoomed: on }
  },
  async renamePane(id, label) { const p = need(id); p.terminal_title = label ?? "zsh"; revision += 1; return {} },
  async runInPane(id, command) { need(id); appendText(id, `${sgr("90", "$")} ${command}`); return {} },
  async sendText(id, text) { need(id); appendText(id, text); return {} },
  async paneSendKey(id, name) { need(id); appendText(id, sgr("2", `<${name}>`)); return { sent: [name] } },
  async movePane(id, to = {}) {
    const p = need(id)
    if (to.new_workspace) {
      const made = addWorkspace(p.cwd, to.label)
      dropPane(made.root_pane.pane_id)
      Object.assign(p, { tab_id: made.tab.tab_id, workspace_id: made.workspace.workspace_id })
    } else if (to.new_tab) {
      const made = addTab(to.workspace ?? p.workspace_id, p.cwd, to.label)
      dropPane(made.root_pane.pane_id)
      Object.assign(p, { tab_id: made.tab.tab_id, workspace_id: made.tab.workspace_id })
    } else if (to.tab) {
      const t = tab(to.tab)
      Object.assign(p, { tab_id: t.tab_id, workspace_id: t.workspace_id })
    }
    revision += 1
    return {}
  },
  async swapPanes(a, b) {
    const pa = need(a)
    const pb = need(b)
    const spot = { tab_id: pa.tab_id, workspace_id: pa.workspace_id }
    Object.assign(pa, { tab_id: pb.tab_id, workspace_id: pb.workspace_id })
    Object.assign(pb, spot)
    revision += 1
    return {}
  },
  resizePane: ok,
  async createWorkspace({ cwd, label } = {}) { return addWorkspace(cwd ?? "~", label) },
  async focusWorkspace(id) { const w = workspace(id); focusPane(panes.find((p) => p.tab_id === w.active_tab_id) ?? panes.find((p) => p.workspace_id === id)); return {} },
  async renameWorkspace(id, label) { workspace(id).label = label; revision += 1; return {} },
  async closeWorkspace(id) { workspace(id); dropWorkspace(id); if (focus.workspace_id === id && panes[0]) focusPane(panes[0]); return {} },
  async createTab({ workspace: id, cwd, label } = {}) { return addTab(id ?? focus.workspace_id, cwd, label) },
  async focusTab(id) { focusPane(panes.find((p) => p.tab_id === tab(id).tab_id)); return {} },
  async renameTab(id, label) { tab(id).label = label; revision += 1; return {} },
  async closeTab(id) { tab(id); dropTab(id); if (focus.tab_id === id && panes[0]) focusPane(panes[0]); return {} },
  async createWorktree({ workspace: id, cwd, branch, base, path, label } = {}) {
    await sleep(500)
    const made = addWorkspace(cwd ?? path ?? `/home/dev/src/api-wt/${branch}`, label ?? branch)
    const wt = { path: path ?? `/home/dev/src/api-wt/${branch}`, label: label ?? branch, branch, base: base ?? "main", open_workspace_id: made.workspace.workspace_id, from_workspace: id }
    worktrees.push(wt)
    return { worktree: wt, ...made }
  },
  async openWorktree({ path, branch, label } = {}) {
    const wt = worktrees.find((w) => (path && w.path === path) || (branch && w.branch === branch))
    if (!wt) throw new HerdrError("worktree_not_found", "no such worktree")
    if (!wt.open_workspace_id) wt.open_workspace_id = addWorkspace(wt.path, label ?? wt.label).workspace.workspace_id
    return { worktree: wt }
  },
  async removeWorktree(id, force) {
    const wt = worktrees.find((w) => w.open_workspace_id === id)
    if (!wt) throw new HerdrError("worktree_not_found", `no worktree open in ${id}`)
    if (wt.is_dirty && !force) throw new HerdrError("worktree_dirty", "worktree has changes, use force")
    worktrees.splice(worktrees.indexOf(wt), 1)
    dropWorkspace(id)
    if (focus.workspace_id === id && panes[0]) focusPane(panes[0])
    return {}
  },
  async notify({ title, body }) { console.log(`fixture: notification "${title}"${body ? `: ${body}` : ""}`); return {} },
}

const port = Number(process.env.PORT) || 8788
const server = createServer(createApp({ client, token: "fixture" }))
server.listen(port, "127.0.0.1", () => {
  console.log(`fixture: open http://127.0.0.1:${port}/login and sign in with the token "fixture"`)
})
