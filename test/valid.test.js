import { test } from "node:test"
import assert from "node:assert/strict"
import { Readable } from "node:stream"
import { isId, requireId, BadRequest, escapeHtml, readBody, readJson, readForm, parseCookies, MAX_BODY } from "../src/valid.js"

const stream = (text) => Readable.from([Buffer.from(text)])

test("isId accepts herdr shaped ids and rejects everything else", () => {
  for (const ok of ["a", "pane:3", "agent_1.two-3", "A".repeat(120)]) assert.equal(isId(ok), true, ok)
  for (const bad of ["", " ", "a b", "a/b", "$(rm)", "a;b", "A".repeat(121), 3, null, undefined, "é"]) {
    assert.equal(isId(bad), false, String(bad))
  }
})

test("requireId throws a 400 with the field name", () => {
  assert.equal(requireId("x1", "agent"), "x1")
  assert.throws(() => requireId("../x", "pane id"), (e) => e instanceof BadRequest && e.status === 400 && e.message === "invalid pane id")
})

test("escapeHtml covers the five characters and tolerates null", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;")
  assert.equal(escapeHtml(null), "")
  assert.equal(escapeHtml(0), "0")
})

test("readBody returns the text and refuses an oversized body", async () => {
  assert.equal(await readBody(stream("hello")), "hello")
  assert.equal(await readBody(stream("")), "")
  const big = Readable.from([Buffer.alloc(10), Buffer.alloc(10)])
  big.destroy = () => big
  await assert.rejects(readBody(big, 15), (e) => e instanceof BadRequest && e.message === "body too large")
  assert.equal(MAX_BODY, 65536)
})

test("readJson accepts an object and rejects other shapes as 400", async () => {
  assert.deepEqual(await readJson(stream('{"text":"hi"}')), { text: "hi" })
  assert.deepEqual(await readJson(stream("")), {})
  await assert.rejects(readJson(stream("not json")), (e) => e.status === 400 && e.message === "body is not JSON")
  await assert.rejects(readJson(stream("[1]")), (e) => e.status === 400 && e.message === "body is not a JSON object")
  await assert.rejects(readJson(stream("null")), (e) => e.status === 400)
  await assert.rejects(readJson(stream('"s"')), (e) => e.status === 400)
})

test("readForm decodes urlencoded pairs", async () => {
  assert.deepEqual(await readForm(stream("token=a%20b&x=1")), { token: "a b", x: "1" })
})

test("parseCookies splits pairs and survives bad encoding", () => {
  assert.deepEqual(parseCookies("a=1; b=x%20y; =skip; c"), { a: "1", b: "x y" })
  assert.deepEqual(parseCookies("bad=%E0%A4%A"), { bad: "%E0%A4%A" })
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies("dup=1; dup=2"), { dup: "2" })
})
