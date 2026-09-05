#!/usr/bin/env node
/** Reads the environment, checks Herdr, prints the token once, listens. */
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { createClient, checkProtocol, PINNED_PROTOCOL } from "./herdr.js"
import { createApp } from "./app.js"

const env = process.env
const bin = env.HERDR_BIN || "herdr"
const host = env.HOST || "127.0.0.1"
const port = Number.parseInt(env.PORT || "8787", 10)
const expected = env.HERDR_PROTOCOL ? Number.parseInt(env.HERDR_PROTOCOL, 10) : PINNED_PROTOCOL

const fail = (message) => {
  console.error(`herdr-phone: ${message}`)
  process.exit(1)
}

if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be a port number, got "${env.PORT}"`)
if (!Number.isInteger(expected)) fail(`HERDR_PROTOCOL must be a number, got "${env.HERDR_PROTOCOL}"`)

const client = createClient({ bin })

let status
try {
  status = await client.status()
} catch (error) {
  fail(error.message)
}
const check = checkProtocol(status, expected)
if (!check.ok) fail(check.message)

const generated = !env.HERDR_PHONE_TOKEN
const token = env.HERDR_PHONE_TOKEN || randomBytes(24).toString("base64url")

const server = createServer(createApp({ client, token }))
server.on("error", (error) => fail(error.code === "EADDRINUSE" ? `${host}:${port} is already in use` : error.message))
server.listen(port, host, () => {
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost"
  console.log(`herdr-phone: ${check.message}`)
  if (!loopback) {
    console.warn(`herdr-phone: WARNING listening on ${host}, which is not loopback. Anyone who reaches this port and has the token can type into your agents.`)
  }
  console.log(`herdr-phone: open http://${host}:${port}/login`)
  if (generated) console.log(`herdr-phone: token (generated for this run, not saved anywhere): ${token}`)
})

const stop = () => server.close(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
