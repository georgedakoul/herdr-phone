#!/usr/bin/env node
// Serves the real app over a canned herdr client so the UI can be looked at
// and screenshotted without a herdr session. Token is always "fixture".
import { createServer } from "node:http"
import { createApp } from "../src/app.js"

const ESC = String.fromCharCode(27)
const sgr = (codes, text) => `${ESC}[${codes}m${text}${ESC}[0m`

const agents = [
  { terminal_id: "term-1", agent_status: "idle", name: "docs", agent: "claude", cwd: "~/src/docs-site", pane_id: "pane-1", tokens: 12400, revision: 3 },
  { terminal_id: "term-2", agent_status: "blocked", name: "api refactor", agent: "claude", cwd: "~/src/api", pane_id: "pane-2", tokens: 88210, revision: 41 },
  { terminal_id: "term-3", agent_status: "working", name: "tests", agent: "codex", cwd: "~/src/api", pane_id: "pane-3", tokens: 3020, revision: 7 },
  { terminal_id: "term-4", agent_status: "done", name: "changelog", agent: "claude", cwd: "~/src/docs-site", pane_id: "pane-4", tokens: 640, revision: 2 },
]

const transcripts = {
  "term-2": [
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
  ].join("\n"),
}

const panes = {
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
const client = {
  async status() { return { client: { version: "0.8.2", protocol: 20 }, server: { status: "running", running: true, version: "0.8.2", protocol: 20 } } },
  async snapshot() { return { protocol: 20, agents, workspaces: [{ workspace_id: "ws-1", name: "api" }, { workspace_id: "ws-2", name: "retry" }] } },
  async agentRead(target) {
    const agent = agents.find((a) => a.terminal_id === target)
    const text = transcripts[target] ?? `> Working in ${agent?.cwd ?? "?"}\n\n(no recent output)`
    return { text, truncated: false, revision, pane_id: agent?.pane_id ?? null }
  },
  async paneRead(paneId) { return { text: panes[paneId] ?? `${sgr("90", "(empty pane)")}`, truncated: false, revision } },
  async prompt(target, text) {
    const agent = agents.find((a) => a.terminal_id === target)
    if (agent) { agent.agent_status = "working"; agent.revision += 1 }
    transcripts[target] = `${transcripts[target] ?? ""}\n\n> ${text}\n\nOn it.`
    revision += 1
    return { ...agent }
  },
  async sendKey(target, name) {
    const agent = agents.find((a) => a.terminal_id === target)
    if (agent && name === "yes") { agent.agent_status = "working"; agent.revision += 1 }
    if (agent && name === "esc") { agent.agent_status = "idle"; agent.revision += 1 }
    revision += 1
    return { sent: [name] }
  },
  async worktrees() { return worktrees },
  async actions() { return actions },
  async invokeAction(actionId) {
    await new Promise((r) => setTimeout(r, 400))
    return { action: { action_id: actionId }, log: `ran ${actionId} in 3 worktrees` }
  },
}

const port = Number(process.env.PORT) || 8788
const server = createServer(createApp({ client, token: "fixture" }))
server.listen(port, "127.0.0.1", () => {
  console.log(`fixture: open http://127.0.0.1:${port}/login and sign in with the token "fixture"`)
})
