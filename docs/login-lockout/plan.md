# Plan: login throttle and alert mail

Implements `docs/login-lockout/spec.md` R34 to R46. Branch `login-lockout`, base `df4de08` on
`main`.

## Files

New:

- `src/gate.js` (about 70 lines). `createGate(options)` returns `{ check, fail, pass }`. Pure
  logic, no I/O, injectable `now` so tests do not sleep. R34, R35, R36, R39.
- `src/mail.js` (about 130 lines). `createMailer(config)` returns `send({ subject, body })` or
  `null` when unconfigured, plus `mailerFromEnv(env)` and an exported `clean(value)` for the
  sanitiser so it can be tested on its own. Injectable `connect` so tests drive a fake server.
  R43, R44, R45.
- `test/gate.test.js`, `test/mail.test.js`.

Changed:

- `src/app.js`. `createApp` takes an optional `alert`, builds a gate, and the `POST /login`
  branch gains the check, the fail path and the pass path. R37, R38, R40, R41, R42.
- `src/index.js`. Builds the mailer from env, prints one line saying whether alerts are on,
  passes `alert` into `createApp`.
- `test/lockout.test.js` (new). Cases for the 429 and the alert calls. See Departures.
- `README.md`. The new environment variables and what the throttle does.
- `docs/main/spec.md`. A dated changelog line.

## Order

1. `src/gate.js` and `test/gate.test.js`. Self-contained, so it can be proven before anything
   is wired.
2. `src/mail.js` and `test/mail.test.js`, with a real `node:net` server standing in for Gmail
   through the injected `connect`.
3. Wire `src/app.js`: gate construction, the login branch, `sourceOf`, the alert calls.
4. Wire `src/index.js`: `mailerFromEnv`, the startup line, the `alert` argument.
5. Tests in `test/lockout.test.js` for the refusal and the alerts.
6. README and the `docs/main/spec.md` changelog line.
7. `npm test`, then restart the running server.

## Design detail

`createGate({ free, base, cap, forget, max, now })`. State is `Map<key, { fails, until,
tripped, seen }>`.

- `check(key)` returns `{ ok: true }` when there is no entry or `now() >= until`, else
  `{ ok: false, retryAfter }` in whole seconds, rounded up so a caller never retries early.
- `fail(key)` increments, sets `until = now() + min(cap, base * 2 ** (fails - free - 1))` once
  `fails > free`, and returns `{ fails, waitMs, tripped }` where `tripped` is true only on the
  attempt that first sets `until`, which is what makes R40's one-alert rule hold.
- `pass(key)` deletes the entry and returns `{ hadTripped }` for R41.
- Every write prunes entries whose `seen` is older than `forget`, then, if the map still
  exceeds `max`, deletes oldest-first. Map iteration order is insertion order and entries are
  re-inserted on update, so oldest-first is just taking from the front. R39.

`sourceOf(req)` in `app.js`: first comma-separated entry of `x-forwarded-for`, trimmed, else
`req.socket.remoteAddress`, else `"unknown"`, joined with `tailscale-user-login` when present.
Used as the gate key and, sanitised, as the alert label.

The login branch becomes: build `key`, then `gate.check(key)` and `gate.check(GLOBAL)`. If
either refuses, answer 429 with `Retry-After` set to the larger of the two and do not compare
the token. Otherwise compare. On failure, `fail` both keys and fire the alert when the
per-source result says `tripped`. On success, `pass` both and fire the second alert when
`hadTripped`.

`send(res, ...)` already sets headers per response, so `Retry-After` goes in the third argument
of `html()` with no change to the helper.

`clean(value)` strips anything below 0x20 plus 0x7f, collapses runs of whitespace, and slices
to 200. The body is assembled from cleaned fields, then every line starting with `.` gets a
second dot before the message goes out.

## Risks

- **Gmail refuses the app password or requires a different auth flow.** Mitigation: the fake
  server proves the protocol but not Gmail's acceptance. If George has not set the variables
  when this ships, the report says the SMTP path is untested against the real server, and the
  app runs with alerts off.
- **The global counter locks George out during an attack.** Ten free attempts and the same
  five minute cap mean the worst case is a five minute wait, which R35 already accepts. Without
  it, a forged `x-forwarded-for` per request would defeat the throttle entirely.
- **A slow SMTP session piling up on repeated alerts.** R40 means one alert per trip per
  source, and the ten second socket timeout bounds each one. No queue is needed at this
  volume.
- **`Retry-After` leaks that the wait exists.** Accepted. It is a documented HTTP response and
  hiding it would not slow a guesser down.

## Rejected

- **A hard lockout for N minutes.** Any tailnet peer could then lock George out on purpose.
- **`await`ing the send inside the handler.** Makes login latency depend on Gmail.
- **`nodemailer`.** Would be the first dependency in the repo. The needed subset of SMTP is
  about 60 lines.
- **Sleeping the request for the wait.** Holds sockets open, which is a cheaper attack than
  the one being prevented.
- **Persisting counters to disk.** New file, new failure mode, and a restart is George's own
  action.

## Proof criteria

1. `npm test` passes with every existing test still green and the new files included, output
   pasted.
2. A test asserts the fourth wrong password in a row answers 401 and sets the wait, and that
   the attempt after it answers 429 with a `Retry-After` header.
3. A test asserts the correct password after three wrong ones still answers 303 with the
   cookie.
4. A test asserts exactly one alert for repeated failures past the trip.
5. A test drives `createMailer` against a local `node:net` server and asserts the transcript
   contains `AUTH LOGIN`, the base64 credentials, `RCPT TO`, `DATA` and a terminating `.`, and
   that a subject carrying `\r\nBcc:` arrives with no CRLF in it.
6. The server restarts and `GET /login` over the tailnet URL still renders.

## Departures

- The app-level tests went into a new `test/lockout.test.js` instead of `test/app.test.js`.
  `app.test.js` shares one long-lived server across all its cases, so gate state would leak
  from one test into the next. Each case in `lockout.test.js` starts its own server.
- Proof criterion 2 was reworded. With three free attempts the fourth wrong password is still
  compared, answers 401 and sets the wait, so the 429 lands on the fifth attempt. The original
  wording was off by one against the code and against R34.
