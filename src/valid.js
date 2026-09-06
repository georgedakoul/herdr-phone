/** Shared input handling. Everything the browser sends passes through here first. */

/**
 * Herdr agent targets, pane ids, workspace ids, action ids and plugin ids all fit this.
 * Anything else is refused before it can reach an argument list.
 */
export const ID = /^[A-Za-z0-9_.:-]{1,120}$/

export const isId = (value) => typeof value === "string" && ID.test(value)

/** Throws so a route can let it bubble to the 400 handler instead of branching. */
export class BadRequest extends Error {
  constructor(message) {
    super(message)
    this.name = "BadRequest"
    this.status = 400
  }
}

export function requireId(value, what) {
  if (!isId(value)) throw new BadRequest(`invalid ${what}`)
  return value
}

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c])

export const MAX_BODY = 64 * 1024

/**
 * Reads a request body with a hard cap. An oversized body is refused while it is
 * still arriving, so a large upload cannot be used to fill memory.
 */
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BadRequest("body too large"))
        // Drain instead of destroy, so the 400 still reaches the client.
        chunks.length = 0
        req.removeAllListeners("data")
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on("error", reject)
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

/** A body that is not a JSON object is a client bug, so it is a 400 and never a crash. */
export async function readJson(req, limit = MAX_BODY) {
  const raw = await readBody(req, limit)
  let parsed
  try {
    parsed = JSON.parse(raw || "{}")
  } catch {
    throw new BadRequest("body is not JSON")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequest("body is not a JSON object")
  }
  return parsed
}

/** Form bodies come from the login page, which has to work before any JavaScript runs. */
export async function readForm(req, limit = MAX_BODY) {
  const raw = await readBody(req, limit)
  return Object.fromEntries(new URLSearchParams(raw))
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      out[name] = part.slice(eq + 1).trim()
    }
  }
  return out
}

/** herdr agent names: lower case, start with a letter, at most 32 characters. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/

export function requireName(value, what = "name") {
  if (typeof value !== "string" || !AGENT_NAME.test(value)) throw new BadRequest(`invalid ${what}`)
  return value
}

/** No control characters, so a value can never carry a newline or an escape into herdr. */
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/

/**
 * Free text that lands in a positional slot. herdr reads a leading "-" as an option,
 * so that shape is refused rather than passed on to fail somewhere less clear.
 */
function requirePrintable(value, what, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || !PRINTABLE.test(value)) {
    throw new BadRequest(`invalid ${what}`)
  }
  if (value.startsWith("-")) throw new BadRequest(`${what} cannot start with "-"`)
  return value
}

/** Labels, titles, branch names: short, one line. */
export const requireLabel = (value, what = "label") => requirePrintable(value, what, 120)

/** Paths, refs: longer, still one line. */
export const requirePath = (value, what = "path") => requirePrintable(value, what, 512)

/** Commands and text typed into a pane. Newlines are fine, NUL is not. */
export function requireText(value, what = "text") {
  if (typeof value !== "string" || !value.trim() || value.length > 4000 || value.includes("\0")) {
    throw new BadRequest(`invalid ${what}`)
  }
  if (value.startsWith("-")) throw new BadRequest(`${what} cannot start with "-"`)
  return value
}

export function requireEnum(value, list, what) {
  if (!list.includes(value)) throw new BadRequest(`invalid ${what}`)
  return value
}
