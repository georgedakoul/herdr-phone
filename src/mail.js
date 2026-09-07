/**
 * Just enough SMTP to send one short alert, written against node:tls so the repo keeps its
 * empty dependency list. Implicit TLS on 465, AUTH LOGIN, one message, QUIT.
 *
 * Everything that reaches the message is scrubbed first. The device and account names in an
 * alert come from request headers, which a process on this machine can forge, so an
 * unfiltered newline there would let it write its own mail headers.
 */
import { connect as tlsConnect } from "node:tls"

const ADDRESS = /^[^\s<>@,;:\\"]+@[^\s<>@,;:\\"]+\.[^\s<>@,;:\\"]+$/

/** Control characters out, whitespace runs collapsed, hard length cap. */
export const clean = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)

/** Same, but newlines survive because a body is allowed to have lines. */
export const cleanBody = (value) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split("\n")
    .map((line) => line.trim().slice(0, 200))
    .join("\r\n")

/** A line of its own that is a single dot would end the message early, so it gets a second one. */
const dotStuff = (text) => text.split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n")

const address = (value, what) => {
  const trimmed = String(value ?? "").trim()
  if (!ADDRESS.test(trimmed)) throw new Error(`${what} is not an email address`)
  return trimmed
}

const defaultConnect = ({ host, port }) => tlsConnect({ host, port, servername: host })

/**
 * Wraps a socket in "write a line, wait for a reply". Replies can span several lines, the
 * last one having a space after the code instead of a dash.
 */
function session(socket, timeout) {
  let buffer = ""
  let collected = []
  const replies = []
  let pending = null
  let failure = null

  const settle = () => {
    if (!pending) return
    if (replies.length) {
      const { resolve } = pending
      pending = null
      resolve(replies.shift())
    } else if (failure) {
      const { reject } = pending
      pending = null
      reject(failure)
    }
  }

  const die = (error) => {
    failure = failure ?? error
    settle()
    socket.destroy()
  }

  socket.setEncoding("utf8")
  socket.setTimeout(timeout, () => die(new Error("SMTP timed out")))
  socket.on("error", (error) => die(new Error(`SMTP socket: ${error.message}`)))
  socket.on("close", () => die(new Error("SMTP connection closed early")))
  socket.on("data", (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      collected.push(line)
      if (/^\d{3}(?: |$)/.test(line)) {
        replies.push({ code: Number.parseInt(line.slice(0, 3), 10), text: collected.join(" ") })
        collected = []
      }
    }
    settle()
  })

  const read = () => new Promise((resolve, reject) => { pending = { resolve, reject }; settle() })

  return {
    /** Only the server's own words go into the error, never anything we sent. */
    async expect(code) {
      const reply = await read()
      if (reply.code !== code) throw new Error(`SMTP wanted ${code}, got ${reply.text}`)
      return reply
    },
    write(text) {
      socket.write(text)
    },
    say(line) {
      socket.write(`${line}\r\n`)
    },
    end() {
      socket.end()
    },
  }
}

/**
 * Returns a send function, or null when there is nothing to send with. Throws only on
 * configuration that is present but wrong, so index.js can say why alerts are off.
 */
export function createMailer({ host = "smtp.gmail.com", port = 465, user, pass, to, timeout = 10_000, connect = defaultConnect } = {}) {
  if (!user || !pass) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP port is not a port number")
  const from = address(user, "SMTP user")
  const recipient = address(to || user, "alert address")

  return async function send({ subject, body }) {
    const smtp = session(connect({ host, port }), timeout)
    try {
      await smtp.expect(220)
      smtp.say("EHLO localhost")
      await smtp.expect(250)
      smtp.say("AUTH LOGIN")
      await smtp.expect(334)
      smtp.say(Buffer.from(from, "utf8").toString("base64"))
      await smtp.expect(334)
      smtp.say(Buffer.from(String(pass), "utf8").toString("base64"))
      await smtp.expect(235)
      smtp.say(`MAIL FROM:<${from}>`)
      await smtp.expect(250)
      smtp.say(`RCPT TO:<${recipient}>`)
      await smtp.expect(250)
      smtp.say("DATA")
      await smtp.expect(354)
      const headers = [
        `From: <${from}>`,
        `To: <${recipient}>`,
        `Subject: ${clean(subject)}`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ].join("\r\n")
      smtp.write(`${headers}\r\n\r\n${dotStuff(cleanBody(body))}\r\n.\r\n`)
      await smtp.expect(250)
      smtp.say("QUIT")
    } finally {
      smtp.end()
    }
  }
}

/** Alerts are off unless both the account and its app password are in the environment. */
export const mailerFromEnv = (env = process.env, connect) =>
  createMailer({
    host: env.HERDR_PHONE_SMTP_HOST || undefined,
    port: env.HERDR_PHONE_SMTP_PORT ? Number.parseInt(env.HERDR_PHONE_SMTP_PORT, 10) : undefined,
    user: env.HERDR_PHONE_SMTP_USER,
    pass: env.HERDR_PHONE_SMTP_PASS,
    to: env.HERDR_PHONE_ALERT_TO,
    connect,
  })
