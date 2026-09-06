/**
 * The only module that knows Herdr exists. Everything goes through the herdr CLI,
 * which prints the same JSON envelope the bundled API schema documents.
 */
import { execFile } from "node:child_process"
import { requireId, requireName, requireLabel, requirePath, requireText, requireEnum, BadRequest } from "./valid.js"

/** The protocol this client was written against. Override only on purpose. */
export const PINNED_PROTOCOL = 20

const DEFAULT_TIMEOUT_MS = 20_000

export class HerdrError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "HerdrError"
    this.code = code
    this.status = code === "server_not_running" ? 503 : 502
  }
}

/** Never uses a shell, so an argument can never turn into a command. */
export function runCli(bin, args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ error: error ?? null, stdout: stdout ?? "", stderr: stderr ?? "" }),
    )
  })
}

/** herdr sometimes prints a note above the payload, so the JSON is found rather than assumed. */
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim()
  if (!text) throw new HerdrError("empty_response", "herdr printed nothing")
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split("\n")
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (!line.startsWith("{")) continue
      try {
        return JSON.parse(line)
      } catch {
        continue
      }
    }
  }
  throw new HerdrError("bad_response", `herdr printed something that is not JSON: ${text.slice(0, 200)}`)
}

/**
 * Reads success from the body, never from the exit code. With no server running the
 * CLI prints an error envelope and still exits 0, so an exit-code check would call
 * that a success.
 */
export function parseEnvelope(stdout) {
  const body = parseJsonOutput(stdout)
  if (body && typeof body === "object" && body.error) {
    const { code, message } = body.error
    throw new HerdrError(code || "herdr_error", message || "herdr returned an error")
  }
  if (body && typeof body === "object" && body.result) return body.result
  // A bare result object carries the same discriminator, so accept it either way.
  if (body && typeof body === "object" && typeof body.type === "string") return body
  throw new HerdrError("bad_response", "herdr returned a response with no result")
}

/**
 * agent read and pane read print the pane text itself, not a JSON envelope. A bad
 * target still comes back as a one-line error envelope, so that case is kept.
 */
export function parseReadOutput(stdout) {
  const raw = String(stdout ?? "")
  const trimmed = raw.trim()
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    try {
      const body = JSON.parse(trimmed)
      if (body && typeof body === "object" && (body.error || body.result)) {
        const result = parseEnvelope(trimmed)
        return result.read ?? { text: "", truncated: false, revision: null }
      }
    } catch (e) {
      if (e instanceof HerdrError) throw e
    }
  }
  return { text: raw.replace(/\r\n/g, "\n"), truncated: false, revision: null }
}

/** The keys the phone offers. A confirmation prompt wants the letter and then enter. */
export const KEY_MAP = {
  esc: ["esc"],
  enter: ["enter"],
  up: ["up"],
  down: ["down"],
  yes: ["y", "enter"],
  no: ["n", "enter"],
}

/** Every agent kind herdr 0.8.2 knows. The phone offers only these, installed ones first. */
export const KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode",
  "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "maki",
]

/** Integration names that differ from the agent kind they install. */
const INTEGRATION_KIND = { "antigravity-cli": "agy" }

/**
 * integration status prints one line per integration, "claude: current (v8) (path)" or
 * "codex: not installed (path)". Anything that is not "not installed" counts as installed.
 */
export function parseIntegrationStatus(text) {
  const installed = []
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*([a-z][a-z0-9-]*):\s*(.*)$/i.exec(line)
    if (!m || /^not installed/i.test(m[2])) continue
    const kind = INTEGRATION_KIND[m[1]] ?? m[1]
    if (KINDS.includes(kind) && !installed.includes(kind)) installed.push(kind)
  }
  return installed
}

export const DIRECTIONS = ["right", "down"]
export const RESIZE_DIRECTIONS = ["left", "right", "up", "down"]
export const ZOOM_MODES = ["toggle", "on", "off"]
export const WAIT_STATES = ["idle", "working", "blocked", "done", "unknown"]
export const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"]
export const SOUNDS = ["none", "done", "request"]

/** Longest a start or wait may block. Long enough for a slow agent, short enough for a phone. */
export const MAX_WAIT_MS = 120_000
const clampWait = (ms) => Math.max(1000, Math.min(MAX_WAIT_MS, Number(ms) || MAX_WAIT_MS))

export function createClient({ bin = "herdr", run = runCli, timeout } = {}) {
  const exec = async (args, options = {}) => {
    const { error, stdout, stderr } = await run(bin, args, { timeout, ...options })
    if (error && !String(stdout ?? "").trim()) {
      const why =
        error.code === "ENOENT"
          ? `could not run "${bin}", is herdr installed and on PATH`
          : String(stderr ?? "").trim() || error.message
      throw new HerdrError("cli_failed", why)
    }
    return { stdout }
  }

  const call = async (args, options) => parseEnvelope((await exec(args, options)).stdout)

  /** A rename takes a name, or null to clear it. herdr spells that --clear for agents and panes alike. */
  const rename = (group, id, value, check) =>
    call(value === null ? [group, "rename", id, "--clear"] : [group, "rename", id, check(value)])

  return {
    bin,

    /** Not an API envelope: herdr status --json prints client and server blocks. */
    async status() {
      const { stdout } = await exec(["status", "--json"])
      return parseJsonOutput(stdout)
    },

    async snapshot() {
      const result = await call(["api", "snapshot"])
      return result.snapshot ?? {}
    },

    async agentRead(target, { source = "recent", lines } = {}) {
      requireId(target, "agent")
      const args = ["agent", "read", target, "--source", source, "--format", "text"]
      if (lines) args.push("--lines", String(Math.max(1, Math.min(5000, Number(lines) || 0))))
      return parseReadOutput((await exec(args)).stdout)
    },

    async paneRead(paneId, { source = "visible", lines } = {}) {
      requireId(paneId, "pane id")
      const args = ["pane", "read", paneId, "--source", source, "--format", "ansi"]
      if (lines) args.push("--lines", String(Math.max(1, Math.min(5000, Number(lines) || 0))))
      return parseReadOutput((await exec(args)).stdout)
    },

    async prompt(target, text) {
      requireId(target, "agent")
      if (typeof text !== "string" || !text.trim()) throw new BadRequest("prompt text is empty")
      // Free text, so it is not pattern checked. It is one argument and there is no shell.
      // herdr 0.8.2 takes TEXT positionally even when it starts with "-", and does not
      // treat "--" as an option separator, so nothing is inserted before it.
      const result = await call(["agent", "prompt", target, text])
      return result.agent ?? {}
    },

    async sendKey(target, name) {
      requireId(target, "agent")
      if (!Object.hasOwn(KEY_MAP, name)) throw new BadRequest(`unknown key "${name}"`)
      const keys = KEY_MAP[name]
      await call(["agent", "send-keys", target, ...keys])
      return { sent: keys }
    },

    async worktrees() {
      const result = await call(["worktree", "list"])
      return result.worktrees ?? []
    },

    async actions() {
      const result = await call(["plugin", "action", "list"])
      return result.actions ?? []
    },

    async invokeAction(actionId, pluginId) {
      requireId(actionId, "action id")
      const args = ["plugin", "action", "invoke", actionId]
      if (pluginId) args.push("--plugin", requireId(pluginId, "plugin id"))
      const result = await call(args)
      return { action: result.action ?? {}, log: result.log ?? null }
    },

    /** Kinds whose integration is installed on this box, plus the full list for the text field. */
    async kinds() {
      const { stdout } = await exec(["integration", "status"])
      return { installed: parseIntegrationStatus(stdout), all: KINDS }
    },

    async paneCurrent() {
      const result = await call(["pane", "current"])
      return result.pane ?? {}
    },

    async paneGet(paneId) {
      const result = await call(["pane", "get", requireId(paneId, "pane id")])
      return result.pane ?? {}
    },

    /**
     * The herdr recipe for a new agent: split the chosen pane in its own directory without
     * stealing focus, then start the agent in the new pane. A start that times out still
     * leaves the pane behind, so that case comes back as ready:false rather than an error.
     */
    async startAgent({ name, kind, pane, direction = "right", cwd, timeout: waitMs } = {}) {
      requireName(name, "agent name")
      requireEnum(kind, KINDS, "kind")
      requireEnum(direction, DIRECTIONS, "direction")
      const source = pane ? await this.paneGet(pane) : await this.paneCurrent()
      if (!source.pane_id) throw new HerdrError("no_pane", "no pane to split")
      const dir = cwd ? requirePath(cwd, "cwd") : source.cwd
      const split = await this.splitPane(source.pane_id, { direction, cwd: dir })
      const ms = clampWait(waitMs)
      try {
        const args = ["agent", "start", name, "--kind", kind, "--pane", split.pane_id, "--timeout", String(ms)]
        const result = await call(args, { timeout: ms + 5000 })
        return { pane_id: split.pane_id, agent: result.agent ?? {}, ready: true }
      } catch (error) {
        if (error instanceof HerdrError && error.code === "agent_not_ready") {
          return { pane_id: split.pane_id, agent: null, ready: false, message: error.message }
        }
        throw error
      }
    },

    async renameAgent(target, name) {
      return rename("agent", requireId(target, "agent"), name, (v) => requireName(v, "agent name"))
    },

    async focusAgent(target) { return call(["agent", "focus", requireId(target, "agent")]) },

    /** Plain text, the same thing a terminal user reads. */
    async explainAgent(target) {
      const { stdout } = await exec(["agent", "explain", requireId(target, "agent")])
      return { text: String(stdout ?? "").replace(/\r\n/g, "\n").trim() }
    },

    async waitAgent(target, { until = [], timeout: waitMs } = {}) {
      requireId(target, "agent")
      const ms = clampWait(waitMs)
      const args = ["agent", "wait", target]
      for (const state of Array.isArray(until) ? until : [until]) {
        args.push("--until", requireEnum(state, WAIT_STATES, "state"))
      }
      args.push("--timeout", String(ms))
      const result = await call(args, { timeout: ms + 5000 })
      return result.agent ?? result
    },

    async splitPane(paneId, { direction = "right", cwd } = {}) {
      requireId(paneId, "pane id")
      const args = ["pane", "split", paneId, "--direction", requireEnum(direction, DIRECTIONS, "direction")]
      if (cwd) args.push("--cwd", requirePath(cwd, "cwd"))
      args.push("--no-focus")
      const result = await call(args)
      const created = result.pane ?? {}
      if (!created.pane_id) throw new HerdrError("bad_response", "pane split returned no pane id")
      return created
    },

    async closePane(paneId) { return call(["pane", "close", requireId(paneId, "pane id")]) },

    async zoomPane(paneId, mode = "toggle") {
      return call(["pane", "zoom", requireId(paneId, "pane id"), `--${requireEnum(mode, ZOOM_MODES, "zoom mode")}`])
    },

    async renamePane(paneId, label) {
      return rename("pane", requireId(paneId, "pane id"), label, (v) => requireLabel(v, "label"))
    },

    async runInPane(paneId, command) {
      return call(["pane", "run", requireId(paneId, "pane id"), requireText(command, "command")])
    },

    async sendText(paneId, text) { return call(["pane", "send-text", requireId(paneId, "pane id"), requireText(text, "text")]) },

    async paneSendKey(paneId, name) {
      requireId(paneId, "pane id")
      if (!Object.hasOwn(KEY_MAP, name)) throw new BadRequest(`unknown key "${name}"`)
      await call(["pane", "send-keys", paneId, ...KEY_MAP[name]])
      return { sent: KEY_MAP[name] }
    },

    /** One of three destinations: an existing tab, a new tab, or a new workspace. */
    async movePane(paneId, to = {}) {
      const args = ["pane", "move", requireId(paneId, "pane id")]
      if (to.new_workspace) {
        args.push("--new-workspace")
        if (to.label) args.push("--label", requireLabel(to.label))
      } else if (to.new_tab) {
        args.push("--new-tab")
        if (to.workspace) args.push("--workspace", requireId(to.workspace, "workspace id"))
        if (to.label) args.push("--label", requireLabel(to.label))
      } else if (to.tab) {
        args.push("--tab", requireId(to.tab, "tab id"), "--split", requireEnum(to.split ?? "right", DIRECTIONS, "direction"))
        if (to.target_pane) args.push("--target-pane", requireId(to.target_pane, "pane id"))
        args.push("--no-focus")
      } else {
        throw new BadRequest("move needs tab, new_tab or new_workspace")
      }
      return call(args)
    },

    async swapPanes(source, target) {
      return call(["pane", "swap", "--source-pane", requireId(source, "pane id"), "--target-pane", requireId(target, "pane id")])
    },

    async resizePane(paneId, direction, amount) {
      const args = ["pane", "resize", "--pane", requireId(paneId, "pane id")]
      args.push("--direction", requireEnum(direction, RESIZE_DIRECTIONS, "direction"))
      if (amount !== undefined && amount !== null && amount !== "") {
        const n = Number(amount)
        if (!Number.isFinite(n) || n <= 0 || n > 1) throw new BadRequest("invalid amount")
        args.push("--amount", String(n))
      }
      return call(args)
    },

    async createWorkspace({ cwd, label } = {}) {
      const args = ["workspace", "create"]
      if (cwd) args.push("--cwd", requirePath(cwd, "cwd"))
      if (label) args.push("--label", requireLabel(label))
      args.push("--no-focus")
      return call(args)
    },
    async focusWorkspace(id) { return call(["workspace", "focus", requireId(id, "workspace id")]) },
    async renameWorkspace(id, label) { return call(["workspace", "rename", requireId(id, "workspace id"), requireLabel(label)]) },
    async closeWorkspace(id) { return call(["workspace", "close", requireId(id, "workspace id")]) },

    async createTab({ workspace, cwd, label } = {}) {
      const args = ["tab", "create"]
      if (workspace) args.push("--workspace", requireId(workspace, "workspace id"))
      if (cwd) args.push("--cwd", requirePath(cwd, "cwd"))
      if (label) args.push("--label", requireLabel(label))
      args.push("--no-focus")
      return call(args)
    },
    async focusTab(id) { return call(["tab", "focus", requireId(id, "tab id")]) },
    async renameTab(id, label) { return call(["tab", "rename", requireId(id, "tab id"), requireLabel(label)]) },
    async closeTab(id) { return call(["tab", "close", requireId(id, "tab id")]) },

    async createWorktree({ workspace, cwd, branch, base, path, label } = {}) {
      const args = ["worktree", "create"]
      if (workspace) args.push("--workspace", requireId(workspace, "workspace id"))
      else if (cwd) args.push("--cwd", requirePath(cwd, "cwd"))
      args.push("--branch", requirePath(branch, "branch"))
      if (base) args.push("--base", requirePath(base, "base"))
      if (path) args.push("--path", requirePath(path))
      if (label) args.push("--label", requireLabel(label))
      args.push("--no-focus")
      return call(args)
    },

    async openWorktree({ path, branch, label } = {}) {
      const args = ["worktree", "open"]
      if (path) args.push("--path", requirePath(path))
      else if (branch) args.push("--branch", requirePath(branch, "branch"))
      else throw new BadRequest("open needs path or branch")
      if (label) args.push("--label", requireLabel(label))
      args.push("--no-focus")
      return call(args)
    },

    async removeWorktree(workspace, force) {
      const args = ["worktree", "remove", "--workspace", requireId(workspace, "workspace id")]
      if (force) args.push("--force")
      return call(args)
    },

    async notify({ title, body, position, sound } = {}) {
      const args = ["notification", "show", requireLabel(title, "title")]
      if (body) args.push("--body", requireText(body, "body"))
      if (position) args.push("--position", requireEnum(position, POSITIONS, "position"))
      if (sound) args.push("--sound", requireEnum(sound, SOUNDS, "sound"))
      return call(args)
    },
  }
}

/**
 * Startup gate. Refuses to serve against a server that is not running or speaks a
 * protocol this client was not written for.
 */
export function checkProtocol(status, expected = PINNED_PROTOCOL) {
  const server = status?.server ?? {}
  const client = status?.client ?? {}
  if (!server.running) {
    return { ok: false, message: `no herdr server is running (socket ${server.socket || "unknown"}). Start herdr first.` }
  }
  if (server.protocol !== expected) {
    return {
      ok: false,
      message:
        `herdr speaks protocol ${server.protocol} and this app was written for ${expected} ` +
        `(herdr ${server.version || client.version || "unknown"}). ` +
        `Update herdr-phone, or set HERDR_PROTOCOL=${server.protocol} to try anyway.`,
    }
  }
  return { ok: true, message: `herdr ${server.version || "unknown"}, protocol ${server.protocol}` }
}
