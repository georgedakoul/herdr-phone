/**
 * Turns a terminal snapshot into HTML. Only SGR (colour and weight) is honoured,
 * every other escape sequence is dropped, and all text is escaped before it is
 * wrapped, so nothing a program prints can inject markup.
 */
import { escapeHtml } from "./valid.js"

export const DEFAULT_FG = "#d7dae0"
export const DEFAULT_BG = "#11131a"

const BASIC = ["#2b2f3a", "#e05561", "#8cc265", "#d9c169", "#4aa5f0", "#c162de", "#42b3c2", "#c5c8cf"]
const BRIGHT = ["#5c6370", "#ff6b74", "#a5e075", "#f0d67a", "#67b8ff", "#d38aea", "#5ecfdd", "#f5f7fa"]
const CUBE = [0, 95, 135, 175, 215, 255]

const hex2 = (v) => Math.max(0, Math.min(255, Math.trunc(v))).toString(16).padStart(2, "0")
const rgb = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

export function xterm256(n) {
  if (n < 8) return BASIC[n]
  if (n < 16) return BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    return rgb(CUBE[Math.floor(i / 36) % 6], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6])
  }
  if (n < 256) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  return null
}

const fresh = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false })

/** Reads 38/48 extended colour arguments and returns the colour plus how many params it ate. */
function extended(params, at) {
  const mode = params[at + 1]
  if (mode === 5) return { colour: xterm256(params[at + 2] ?? 0), used: 2 }
  if (mode === 2) return { colour: rgb(params[at + 2] ?? 0, params[at + 3] ?? 0, params[at + 4] ?? 0), used: 4 }
  // An unknown mode leaves the rest of the parameter list unreadable, so it is all discarded.
  return { colour: null, used: params.length }
}

export function applySgr(state, raw) {
  // An empty parameter is 0, which is what a bare ESC[m means.
  const params = (raw === "" ? "0" : raw).split(";").map((p) => (p === "" ? 0 : Number.parseInt(p, 10)))
  let next = { ...state }
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]
    if (!Number.isFinite(p)) continue
    if (p === 0) next = fresh()
    else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 22) { next.bold = false; next.dim = false }
    else if (p === 23) next.italic = false
    else if (p === 24) next.underline = false
    else if (p === 27) next.inverse = false
    else if (p >= 30 && p <= 37) next.fg = BASIC[p - 30]
    else if (p === 38) { const e = extended(params, i); next.fg = e.colour; i += e.used }
    else if (p === 39) next.fg = null
    else if (p >= 40 && p <= 47) next.bg = BASIC[p - 40]
    else if (p === 48) { const e = extended(params, i); next.bg = e.colour; i += e.used }
    else if (p === 49) next.bg = null
    else if (p >= 90 && p <= 97) next.fg = BRIGHT[p - 90]
    else if (p >= 100 && p <= 107) next.bg = BRIGHT[p - 100]
  }
  return next
}

export function styleOf(state) {
  let fg = state.fg
  let bg = state.bg
  if (state.inverse) {
    fg = state.bg ?? DEFAULT_BG
    bg = state.fg ?? DEFAULT_FG
  }
  const css = []
  if (fg) css.push(`color:${fg}`)
  if (bg) css.push(`background-color:${bg}`)
  if (state.bold) css.push("font-weight:600")
  if (state.dim) css.push("opacity:.65")
  if (state.italic) css.push("font-style:italic")
  if (state.underline) css.push("text-decoration:underline")
  return css.join(";")
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

const isFinalByte = (code) => code >= 0x40 && code <= 0x7e

export function ansiToHtml(input) {
  const text = String(input ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "")
  let out = ""
  let state = fresh()
  let buffered = ""
  const flush = () => {
    if (!buffered) return
    const css = styleOf(state)
    out += css ? `<span style="${css}">${escapeHtml(buffered)}</span>` : escapeHtml(buffered)
    buffered = ""
  }

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ESC) {
      buffered += text[i]
      continue
    }
    const kind = text[i + 1]
    if (kind === "[") {
      let j = i + 2
      while (j < text.length && !isFinalByte(text.charCodeAt(j))) j += 1
      if (j >= text.length) { i = text.length; break }
      if (text[j] === "m" && !text.slice(i + 2, j).includes("?")) {
        flush()
        state = applySgr(state, text.slice(i + 2, j))
      }
      i = j
    } else if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      // String sequences (window title, device control) run until BEL or ESC backslash.
      let j = i + 2
      while (j < text.length && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === "\\")) j += 1
      i = j < text.length && text[j] === ESC ? j + 1 : j
    } else if (kind !== undefined && kind.charCodeAt(0) >= 0x20 && kind.charCodeAt(0) <= 0x2f) {
      // Escapes with intermediate bytes, such as charset selection ESC ( B, end at a final byte.
      let j = i + 2
      while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j += 1
      i = j
    } else {
      // Two byte escapes, and a trailing lone ESC.
      i += kind === undefined ? 0 : 1
    }
  }
  flush()
  return out
}
