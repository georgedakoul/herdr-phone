/**
 * The only module that knows Herdr exists. Everything goes through the herdr CLI,
 * which prints the same JSON envelope the bundled API schema documents.
 */
import { execFile } from "node:child_process"
import { requireId, BadRequest } from "./valid.js"

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

export function createClient({ bin = "herdr", run = runCli, timeout } = {}) {
  const exec = async (args) => {
    const { error, stdout, stderr } = await run(bin, args, { timeout })
    if (error && !String(stdout ?? "").trim()) {
      const why =
        error.code === "ENOENT"
          ? `could not run "${bin}", is herdr installed and on PATH`
          : String(stderr ?? "").trim() || error.message
      throw new HerdrError("cli_failed", why)
    }
    return { stdout }
  }

  const call = async (args) => parseEnvelope((await exec(args)).stdout)

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
