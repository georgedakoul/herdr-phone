import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createApp, sourceOf, COOKIE } from "../src/app.js"

const TOKEN = "test-token-123"

/** Its own server per test, so one test's failure count cannot leak into another. */
async function start(alert = null) {
  const server = createServer(createApp({ client: {}, token: TOKEN, alert }))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    login: (token, headers = {}) =>
      fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: `token=${encodeURIComponent(token)}`,
        redirect: "manual",
      }),
  }
}

/** Collects what would have been mailed. */
const collector = () => {
  const sent = []
  return { sent, alert: async (message) => { sent.push(message) } }
}

const from = (address) => ({ "x-forwarded-for": address })

test("sourceOf prefers the forwarded address and adds the tailscale account", () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: "127.0.0.1" } })
  assert.equal(sourceOf(req({})), "127.0.0.1")
  assert.equal(sourceOf(req({ "x-forwarded-for": "100.115.111.91" })), "100.115.111.91")
  assert.equal(sourceOf(req({ "x-forwarded-for": "100.115.111.91, 10.0.0.1" })), "100.115.111.91")
  assert.equal(sourceOf(req({ "x-forwarded-for": "1.2.3.4", "tailscale-user-login": "someone@example.com" })), "1.2.3.4 someone@example.com")
  assert.equal(sourceOf({ headers: {}, socket: {} }), "unknown")
})

test("three wrong tries still answer 401, the next one is refused with Retry-After", async () => {
  const app = await start()
  const at = from("100.0.0.1")
  for (let i = 0; i < 4; i += 1) {
    const res = await app.login("nope", at)
    assert.equal(res.status, 401, `attempt ${i + 1}`)
    assert.equal(res.headers.get("retry-after"), null)
  }
  const refused = await app.login("nope", at)
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get("retry-after"), "2")
  assert.match(await refused.text(), /Too many wrong tries. Try again in 2s\./)

  // The right password is refused too while the wait runs, so a guesser gains nothing by
  // eventually guessing right inside it.
  const correct = await app.login(TOKEN, at)
  assert.equal(correct.status, 429)
  assert.equal(correct.headers.get("set-cookie"), null)
  await app.close()
})

test("the right password after three wrong ones logs in as usual", async () => {
  const app = await start()
  const at = from("100.0.0.2")
  for (let i = 0; i < 3; i += 1) assert.equal((await app.login("nope", at)).status, 401)
  const res = await app.login(TOKEN, at)
  assert.equal(res.status, 303)
  assert.equal(res.headers.get("location"), "/")
  assert.match(res.headers.get("set-cookie"), new RegExp(`^${COOKIE}=${TOKEN}; Path=/;`))

  // The counter was cleared, so the next three wrong ones are free again.
  for (let i = 0; i < 3; i += 1) assert.equal((await app.login("nope", at)).status, 401)
  await app.close()
})

test("one device failing does not slow another down", async () => {
  const app = await start()
  for (let i = 0; i < 4; i += 1) await app.login("nope", from("100.0.0.3"))
  assert.equal((await app.login("nope", from("100.0.0.3"))).status, 429)
  assert.equal((await app.login("nope", from("100.0.0.4"))).status, 401)
  assert.equal((await app.login(TOKEN, from("100.0.0.4"))).status, 303)
  await app.close()
})

test("forging a new address every time still hits the global backstop", async () => {
  const app = await start()
  for (let i = 0; i < 11; i += 1) {
    assert.equal((await app.login("nope", from(`10.1.0.${i}`))).status, 401, `attempt ${i + 1}`)
  }
  const fresh = await app.login("nope", from("10.9.9.9"))
  assert.equal(fresh.status, 429)
  assert.equal(fresh.headers.get("retry-after"), "2")
  await app.close()
})

test("the trip sends exactly one alert, naming the source", async () => {
  const mail = collector()
  const app = await start(mail.alert)
  const at = { ...from("100.0.0.5"), "tailscale-user-login": "someone@example.com", "user-agent": "Safari" }
  for (let i = 0; i < 3; i += 1) await app.login("nope", at)
  assert.deepEqual(mail.sent, [])

  await app.login("nope", at)
  assert.equal(mail.sent.length, 1)
  assert.equal(mail.sent[0].subject, "herdr-phone: too many wrong passwords")
  assert.match(mail.sent[0].body, /4 wrong passwords in a row\./)
  assert.match(mail.sent[0].body, /refused for 2s/)
  assert.match(mail.sent[0].body, /Source: 100\.0\.0\.5 someone@example\.com/)
  assert.match(mail.sent[0].body, /Browser: Safari/)
  assert.match(mail.sent[0].body, /not proof of who it was/)

  // Hammering inside the wait sends nothing more.
  for (let i = 0; i < 5; i += 1) await app.login("nope", at)
  assert.equal(mail.sent.length, 1)
  await app.close()
})

test("forged header values are scrubbed and capped before they reach the alert", async () => {
  const mail = collector()
  const app = await start(mail.alert)
  const at = {
    ...from("100.0.0.9"),
    // Node's parser refuses a raw newline in a header, so this is what a forger can actually
    // send: a tab, and far more characters than an alert should ever carry.
    "user-agent": `Safari\tTime: 1999-01-01T00:00:00.000Z${"x".repeat(500)}`,
  }
  for (let i = 0; i < 4; i += 1) await app.login("nope", at)

  assert.equal(mail.sent.length, 1)
  const lines = mail.sent[0].body.split("\n")
  const browser = lines.find((line) => line.startsWith("Browser: "))
  assert.equal(browser.length, "Browser: ".length + 200)
  assert.match(browser, /^Browser: Safari Time: /)
  // One Time line, the real one, not the one the header tried to add.
  assert.equal(lines.filter((line) => line.startsWith("Time: ")).length, 1)
  await app.close()
})

test("a login that succeeds after a trip sends the second alert", async () => {
  const mail = collector()
  const app = await start(mail.alert)
  const at = from("100.0.0.6")
  for (let i = 0; i < 4; i += 1) await app.login("nope", at)
  assert.equal(mail.sent.length, 1)

  // The first wait is two seconds. Waiting it out is the only honest way to prove the release.
  await new Promise((resolve) => setTimeout(resolve, 2100))
  const res = await app.login(TOKEN, at)
  assert.equal(res.status, 303)
  assert.equal(mail.sent.length, 2)
  assert.equal(mail.sent[1].subject, "herdr-phone: signed in after failed tries")
  assert.match(mail.sent[1].body, /signed in successfully/)

  // Cleared, so a later success is quiet again.
  assert.equal((await app.login(TOKEN, at)).status, 303)
  assert.equal(mail.sent.length, 2)
  await app.close()
})

test("mail that fails is logged and swallowed, the login still answers", async () => {
  const logged = []
  const original = console.error
  console.error = (line) => logged.push(line)
  const app = await start(async () => { throw new Error("smtp is down") })
  try {
    const at = from("100.0.0.7")
    for (let i = 0; i < 4; i += 1) assert.equal((await app.login("nope", at)).status, 401)
    assert.equal((await app.login("nope", at)).status, 429)
    // The rejection is handled in a microtask, so give it a turn before looking.
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(logged, ["herdr-phone: alert not sent: smtp is down"])
  } finally {
    console.error = original
    await app.close()
  }
})

test("with no mailer configured the throttle still works", async () => {
  const app = await start(null)
  const at = from("100.0.0.8")
  for (let i = 0; i < 4; i += 1) await app.login("nope", at)
  assert.equal((await app.login("nope", at)).status, 429)
  await app.close()
})
