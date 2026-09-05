import { test } from "node:test"
import assert from "node:assert/strict"
import { ansiToHtml, applySgr, styleOf, xterm256, DEFAULT_FG, DEFAULT_BG } from "../src/ansi.js"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const sgr = (p) => `${ESC}[${p}m`

test("plain text is escaped and not wrapped", () => {
  assert.equal(ansiToHtml("a < b & c"), "a &lt; b &amp; c")
  assert.equal(ansiToHtml(""), "")
  assert.equal(ansiToHtml(null), "")
})

test("markup inside a coloured run is escaped", () => {
  const out = ansiToHtml(`${sgr(31)}<script>alert(1)</script>${sgr(0)} after`)
  assert.equal(out, `<span style="color:#e05561">&lt;script&gt;alert(1)&lt;/script&gt;</span> after`)
  assert.ok(!out.includes("<script>"))
})

test("bold, dim, italic, underline and reset", () => {
  assert.equal(ansiToHtml(`${sgr("1;2;3;4")}x${sgr(0)}y`), `<span style="font-weight:600;opacity:.65;font-style:italic;text-decoration:underline">x</span>y`)
  assert.equal(ansiToHtml(`${sgr(1)}a${sgr(22)}b`), `<span style="font-weight:600">a</span>b`)
  assert.equal(ansiToHtml(`${ESC}[mplain`), "plain")
})

test("256 colour and truecolour foreground and background", () => {
  assert.equal(ansiToHtml(`${sgr("38;5;196")}r`), `<span style="color:#ff0000">r</span>`)
  assert.equal(ansiToHtml(`${sgr("48;2;1;2;3")}b`), `<span style="background-color:#010203">b</span>`)
  assert.equal(ansiToHtml(`${sgr("38;5;300")}n`), "n")
  assert.equal(ansiToHtml(`${sgr("38;9;1")}odd`), "odd")
})

test("bright colours and inverse", () => {
  assert.equal(ansiToHtml(`${sgr(92)}g`), `<span style="color:#a5e075">g</span>`)
  assert.equal(ansiToHtml(`${sgr(104)}b`), `<span style="background-color:#67b8ff">b</span>`)
  assert.equal(ansiToHtml(`${sgr(7)}i`), `<span style="color:${DEFAULT_BG};background-color:${DEFAULT_FG}">i</span>`)
  assert.equal(ansiToHtml(`${sgr("31;7")}i${sgr(27)}n`), `<span style="color:${DEFAULT_BG};background-color:#e05561">i</span><span style="color:#e05561">n</span>`)
})

test("non SGR sequences are dropped, never printed", () => {
  assert.equal(ansiToHtml(`${ESC}[2Ja${ESC}[10;20Hb${ESC}[?25lc${ESC}[Kd`), "abcd")
  assert.equal(ansiToHtml(`${ESC}]0;window title${BEL}x`), "x")
  assert.equal(ansiToHtml(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`), "link")
  assert.equal(ansiToHtml(`${ESC}(Bx${ESC}=y`), "xy")
  assert.equal(ansiToHtml(`${ESC}P1$rq${ESC}\\z`), "z")
  assert.equal(ansiToHtml(`${ESC}[?1049h${sgr(31)}x`), `<span style="color:#e05561">x</span>`)
})

test("a truncated sequence at the end does not leak", () => {
  assert.equal(ansiToHtml(`ok${ESC}[31`), "ok")
  assert.equal(ansiToHtml(`ok${ESC}`), "ok")
  assert.equal(ansiToHtml(`ok${ESC}]title with no end`), "ok")
})

test("line endings are normalised", () => {
  assert.equal(ansiToHtml("a\r\nb\rc"), "a\nbc")
})

test("xterm256 palette maths", () => {
  assert.equal(xterm256(0), "#2b2f3a")
  assert.equal(xterm256(15), "#f5f7fa")
  assert.equal(xterm256(16), "#000000")
  assert.equal(xterm256(231), "#ffffff")
  assert.equal(xterm256(232), "#080808")
  assert.equal(xterm256(255), "#eeeeee")
  assert.equal(xterm256(256), null)
})

test("applySgr and styleOf are pure", () => {
  const start = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }
  const next = applySgr(start, "31;1")
  assert.equal(start.fg, null)
  assert.equal(next.fg, "#e05561")
  assert.equal(styleOf(next), "color:#e05561;font-weight:600")
  assert.equal(styleOf(start), "")
  assert.equal(applySgr(next, "").fg, null)
  assert.equal(applySgr(next, "x;39").fg, null)
})
