import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { createMailer, mailerFromEnv, clean, cleanBody } from "../src/mail.js"

/**
 * A fake SMTP server. It answers like Gmail does, including a multiline EHLO reply, and keeps
 * every line the client sent so a test can assert on the whole conversation.
 */
function fakeSmtp({ authCode = 235 } = {}) {
  const state = { lines: [], message: [] }
  let inData = false
  const server = net.createServer((socket) => {
    let buffer = ""
    socket.write("220 fake ESMTP\r\n")
    socket.on("data", (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        if (inData) {
          if (line === ".") {
            inData = false
            socket.write("250 queued\r\n")
          } else state.message.push(line)
          continue
        }
        state.lines.push(line)
        if (line.startsWith("EHLO")) socket.write("250-fake greets you\r\n250 AUTH LOGIN\r\n")
        else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n")
        else if (state.lines.at(-2) === "AUTH LOGIN") socket.write("334 UGFzc3dvcmQ6\r\n")
        else if (state.lines.at(-3) === "AUTH LOGIN") socket.write(`${authCode} ${authCode === 235 ? "accepted" : "bad credentials"}\r\n`)
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 ok\r\n")
        else if (line === "DATA") { inData = true; socket.write("354 go ahead\r\n") }
        else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end() }
      }
    })
    socket.on("error", () => {})
  })
  state.listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
  state.close = () => new Promise((resolve) => server.close(resolve))
  return state
}

const mailerFor = (fake, port, extra = {}) =>
  createMailer({
    user: "sender@example.com",
    pass: "app-password-here",
    to: "inbox@example.com",
    connect: () => net.connect({ host: "127.0.0.1", port }),
    ...extra,
  })

test("a send walks the whole SMTP conversation", async () => {
  const fake = fakeSmtp()
  const port = await fake.listen()
  await mailerFor(fake, port)({ subject: "herdr-phone: too many wrong passwords", body: "four failures\nfrom iphone" })
  await fake.close()

  assert.equal(fake.lines[0], "EHLO localhost")
  assert.equal(fake.lines[1], "AUTH LOGIN")
  assert.equal(Buffer.from(fake.lines[2], "base64").toString(), "sender@example.com")
  assert.equal(Buffer.from(fake.lines[3], "base64").toString(), "app-password-here")
  assert.equal(fake.lines[4], "MAIL FROM:<sender@example.com>")
  assert.equal(fake.lines[5], "RCPT TO:<inbox@example.com>")
  assert.equal(fake.lines[6], "DATA")
  assert.equal(fake.lines[7], "QUIT")

  assert.ok(fake.message.includes("Subject: herdr-phone: too many wrong passwords"))
  assert.ok(fake.message.includes("To: <inbox@example.com>"))
  assert.ok(fake.message.includes("Content-Type: text/plain; charset=utf-8"))
  assert.ok(fake.message.includes("four failures"))
  assert.ok(fake.message.includes("from iphone"))
})

test("a forged newline cannot add a mail header, and a lone dot cannot end the message early", async () => {
  const fake = fakeSmtp()
  const port = await fake.listen()
  await mailerFor(fake, port)({
    subject: "trip\r\nBcc: thief@example.com",
    body: "device: laptop\r\nX-Injected: yes\n.\n.hidden",
  })
  await fake.close()

  assert.ok(fake.message.includes("Subject: trip Bcc: thief@example.com"))
  assert.equal(fake.message.filter((line) => line.startsWith("Bcc:")).length, 0)

  // Everything before the first empty line is a header. The forged line has to land after it.
  const bodyStarts = fake.message.indexOf("") + 1
  assert.ok(bodyStarts > 0)
  assert.equal(fake.message.slice(0, bodyStarts).filter((line) => line.startsWith("X-Injected:")).length, 0)
  assert.ok(fake.message.slice(bodyStarts).includes("X-Injected: yes"), "the forged header survives as body text, not as a header")
  assert.ok(fake.message.includes(".."), "a lone dot line is stuffed")
  assert.ok(fake.message.includes("..hidden"))
  // The server saw the message end, so the stuffing kept the conversation in step.
  assert.equal(fake.lines.at(-1), "QUIT")
})

test("a refused login rejects instead of hanging", async () => {
  const fake = fakeSmtp({ authCode: 535 })
  const port = await fake.listen()
  await assert.rejects(mailerFor(fake, port)({ subject: "x", body: "y" }), (error) => {
    assert.match(error.message, /SMTP wanted 235/)
    assert.ok(!error.message.includes("app-password-here"), "the password never reaches an error message")
    return true
  })
  await fake.close()
})

test("a server that never answers gives up on the timeout", async () => {
  const server = net.createServer(() => {})
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
  const send = createMailer({
    user: "sender@example.com",
    pass: "pw",
    timeout: 50,
    connect: () => net.connect({ host: "127.0.0.1", port }),
  })
  await assert.rejects(send({ subject: "x", body: "y" }), /timed out/)
  await new Promise((resolve) => server.close(resolve))
})

test("no account or no password means no mailer at all", () => {
  assert.equal(createMailer({ user: "a@b.co" }), null)
  assert.equal(createMailer({ pass: "x" }), null)
  assert.equal(createMailer({}), null)
  assert.equal(mailerFromEnv({}), null)
  assert.equal(mailerFromEnv({ HERDR_PHONE_SMTP_USER: "a@b.co" }), null)
})

test("configuration that is present but wrong says so", () => {
  const env = { HERDR_PHONE_SMTP_USER: "not-an-address", HERDR_PHONE_SMTP_PASS: "x" }
  assert.throws(() => mailerFromEnv(env), /SMTP user is not an email address/)
  assert.throws(() => mailerFromEnv({ ...env, HERDR_PHONE_SMTP_USER: "a@b.co", HERDR_PHONE_ALERT_TO: "nope" }), /alert address is not an email address/)
  assert.throws(() => mailerFromEnv({ ...env, HERDR_PHONE_SMTP_USER: "a@b.co", HERDR_PHONE_SMTP_PORT: "smtp" }), /not a port number/)
})

test("the alert address defaults to the sending account", async () => {
  const fake = fakeSmtp()
  const port = await fake.listen()
  await createMailer({ user: "solo@example.com", pass: "pw", connect: () => net.connect({ host: "127.0.0.1", port }) })({ subject: "s", body: "b" })
  await fake.close()
  assert.equal(fake.lines[5], "RCPT TO:<solo@example.com>")
})

test("clean strips control characters, collapses runs and caps the length", () => {
  assert.equal(clean("a\r\nb\tc"), "a b c")
  assert.equal(clean("  spaced   out  "), "spaced out")
  assert.equal(clean("x".repeat(500)).length, 200)
  assert.equal(clean(null), "")
  assert.equal(clean(0), "0")
})

test("cleanBody keeps lines but nothing else", () => {
  assert.equal(cleanBody("one\r\ntwo\nthree"), "one\r\ntwo\r\nthree")
  assert.equal(cleanBody("a\u0000b"), "a b")
  assert.equal(cleanBody("x".repeat(500)).length, 200)
  assert.equal(cleanBody(""), "")
})
