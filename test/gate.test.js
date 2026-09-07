import { test } from "node:test"
import assert from "node:assert/strict"
import { createGate, GLOBAL } from "../src/gate.js"

/** A clock the test moves by hand, so nothing here sleeps. */
const clock = (start = 1_000_000) => {
  const t = { at: start }
  t.now = () => t.at
  t.tick = (ms) => { t.at += ms }
  return t
}

test("the first three failures cost nothing", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  for (let i = 0; i < 3; i += 1) {
    const result = gate.fail("a")
    assert.equal(result.fails, i + 1)
    assert.equal(result.waitMs, 0)
    assert.equal(result.tripped, false)
    assert.deepEqual(gate.check("a"), { ok: true })
  }
})

test("the wait doubles from the fourth failure and stops at the cap", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  for (let i = 0; i < 3; i += 1) gate.fail("a")
  assert.equal(gate.fail("a").waitMs, 2000)
  t.tick(2000)
  assert.equal(gate.fail("a").waitMs, 4000)
  t.tick(4000)
  assert.equal(gate.fail("a").waitMs, 8000)
  let last
  for (let i = 0; i < 20; i += 1) {
    t.tick(10 * 60 * 1000)
    last = gate.fail("a")
  }
  assert.equal(last.waitMs, 5 * 60 * 1000)
})

test("tripped is true once, so the alert is sent once", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  for (let i = 0; i < 3; i += 1) assert.equal(gate.fail("a").tripped, false)
  assert.equal(gate.fail("a").tripped, true)
  t.tick(2000)
  assert.equal(gate.fail("a").tripped, false)
  t.tick(4000)
  assert.equal(gate.fail("a").tripped, false)
})

test("check refuses while the wait runs and reports whole seconds, rounded up", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  for (let i = 0; i < 4; i += 1) gate.fail("a")
  assert.deepEqual(gate.check("a"), { ok: false, retryAfter: 2 })
  t.tick(1)
  assert.deepEqual(gate.check("a"), { ok: false, retryAfter: 2 })
  t.tick(1000)
  assert.deepEqual(gate.check("a"), { ok: false, retryAfter: 1 })
  t.tick(999)
  assert.deepEqual(gate.check("a"), { ok: true })
})

test("a pass clears the record and says whether it had tripped", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  assert.deepEqual(gate.pass("fresh"), { hadTripped: false })
  gate.fail("a")
  assert.deepEqual(gate.pass("a"), { hadTripped: false })
  assert.equal(gate.size, 0)
  for (let i = 0; i < 4; i += 1) gate.fail("b")
  assert.deepEqual(gate.pass("b"), { hadTripped: true })
  assert.deepEqual(gate.check("b"), { ok: true })
  assert.equal(gate.fail("b").fails, 1)
})

test("keys are independent and the global key is just another key", () => {
  const t = clock()
  const gate = createGate({ now: t.now })
  for (let i = 0; i < 4; i += 1) gate.fail("a")
  assert.equal(gate.check("a").ok, false)
  assert.deepEqual(gate.check("b"), { ok: true })
  for (let i = 0; i < 4; i += 1) gate.fail(GLOBAL)
  assert.equal(gate.check(GLOBAL).ok, false)
  assert.equal(GLOBAL.startsWith("\u0000"), true)
})

test("entries are forgotten and the map stays bounded", () => {
  const t = clock()
  const gate = createGate({ now: t.now, forget: 1000, max: 3 })
  gate.fail("old")
  t.tick(1001)
  gate.fail("new")
  assert.equal(gate.size, 1)
  assert.deepEqual(gate.check("old"), { ok: true })

  const bounded = createGate({ now: t.now, max: 3 })
  for (let i = 0; i < 50; i += 1) bounded.fail(`k${i}`)
  assert.equal(bounded.size, 3)
  assert.deepEqual(bounded.check("k0"), { ok: true })
  assert.equal(bounded.fail("k49").fails, 2)
})

test("free and base are configurable and zero free trips on the first failure", () => {
  const t = clock()
  const gate = createGate({ now: t.now, free: 0, base: 500, cap: 1000 })
  const first = gate.fail("a")
  assert.equal(first.waitMs, 500)
  assert.equal(first.tripped, true)
  t.tick(500)
  assert.equal(gate.fail("a").waitMs, 1000)
  t.tick(1000)
  assert.equal(gate.fail("a").waitMs, 1000)
})
