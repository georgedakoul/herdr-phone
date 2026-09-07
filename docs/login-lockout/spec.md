# Spec: login throttle and alert mail

Derived from `docs/login-lockout/intent.md`. Numbers George left to me are decided here and
marked as such.

## Flagged concerns

- **A Gmail app password is a bigger secret than the login token.** It grants full read and
  send access to the mailbox, so leaking it is worse than leaking the thing it protects. It
  gets its own app password, generated for herdr-phone alone, and lives only in an environment
  variable. Conflicts with nothing, but it is the reason R45 keeps the value out of every log
  line and every error message.
- **The alert names a device and an account taken from request headers.** Those headers are set
  by `tailscale serve` and stripped from incoming requests, but a process on the laptop talking
  to `127.0.0.1:8787` directly can set them to anything, including CRLF that would forge extra
  mail headers. R44 sanitises them, and R37 keeps a global counter that no header can dodge.
- **A throttle is a denial of service against its owner if it is a hard lock.** Anything on the
  tailnet can fail on purpose. R35's cap is what stops that from being useful.
- **Sending mail is a network call in an app that currently makes none.** R42 keeps it off the
  request path entirely, so a hung SMTP session cannot slow a login down.

## Requirements

- **R34.** `POST /login` counts failures per source. The first three failures in a row cost
  nothing, matching a phone keyboard typo. *(Decided: three, because two is easy to hit on a
  soft keyboard and four gives a guesser a free extra try.)*
- **R35.** From the fourth failure on, the source is refused for a wait that doubles: 2s, 4s,
  8s, 16s and so on, capped at 300s. *(Decided: cap of five minutes. A guesser is reduced to
  twelve tries an hour, which kills brute force, and George is never shut out for longer than
  a coffee.)* While the wait is running, `POST /login` does not compare the password at all.
- **R36.** A correct password clears the source's counter and its wait immediately, and the
  login proceeds exactly as it does today.
- **R37.** Counters are keyed on the source: the first entry of `x-forwarded-for`, plus
  `tailscale-user-login` when present, else the socket address. A second counter, keyed on
  nothing, counts every failure the app sees regardless of source, with ten free attempts and
  the same doubling and cap. Either counter being in its wait refuses the request.
- **R38.** A refused request answers `429` with a `Retry-After` header in seconds and the login
  page saying how long is left. It never sleeps and never holds the socket open to burn the
  wait, because that would let an attacker exhaust connections instead.
- **R39.** Counters live in memory and are forgotten thirty minutes after the last failure. The
  map is pruned on write and holds at most 500 sources, oldest dropped first, so forged
  identities cannot grow it without bound.
- **R40.** When a source's wait first trips, one alert is sent: subject naming herdr-phone,
  body giving the failure count, the wait, the claimed device and account, and the time. No
  further alert for that source until its counter is cleared or forgotten, so a guesser
  hammering away produces one mail and not a thousand.
- **R41.** When a source that had tripped later logs in successfully, a second alert is sent
  saying so. *(Decided: yes. This is the one that matters, because it says someone got in
  rather than that someone failed, and R34's free attempts keep George's own typos from ever
  reaching it.)*
- **R42.** Alerts are sent after the response has gone out, never awaited by the handler. A
  send that fails or times out is logged to stderr and swallowed. A login never gets slower or
  fails because of mail.
- **R43.** Mail goes over SMTP to `smtp.gmail.com:465` on implicit TLS, written against
  `node:tls`, with `AUTH LOGIN`. No dependency is added. The socket has a ten second timeout
  and is destroyed on failure.
- **R44.** Every value that reaches the message is sanitised: control characters including CR
  and LF are stripped, each field is capped at 200 characters, and body lines beginning with a
  dot are escaped, so neither a forged header nor a long field can inject SMTP commands or mail
  headers.
- **R45.** Configuration is environment only: `HERDR_PHONE_SMTP_USER`,
  `HERDR_PHONE_SMTP_PASS`, `HERDR_PHONE_ALERT_TO` (defaults to the user), and optional
  `HERDR_PHONE_SMTP_HOST` and `HERDR_PHONE_SMTP_PORT`. No address, account or password appears
  in the repository, in a log line, or in an error message. With user or password unset, the
  app starts normally, prints that alerts are off, and the throttle still works.
- **R46.** Tests cover: the free attempts, the doubling, the cap, the clear on success, the
  forgetting, the map bound, the one-alert-per-trip rule, the success-after-trip alert, the
  429 shape with `Retry-After`, sanitisation of a CRLF injection attempt, dot-stuffing, and a
  full SMTP conversation against a fake server. `npm test` stays green.

## Out of scope

- Persisting counters across a restart. Only George restarts the process.
- Blocking an address permanently, or any allowlist. The cap in R35 is the whole policy.
- Alerting on anything other than login: no alert for prompts sent, panes closed or actions
  run.
- Changing the cookie, its lifetime, or how the token itself is compared.

## Changelog

- 2026-09-07: after review, R44's sanitisation was found to be applied in `src/mail.js` but not
  to the fields `src/app.js` puts into an alert body. Fixed, and a test added. No requirement
  changed. Two places where the build departs from a literal reading of R36 and R41 are
  recorded in the plan's Departures rather than being written in here, because they are
  George's call.
- 2026-09-07: created. George's answers to the intent's open questions were "follow your
  instinct to follow the best safety method", so R34, R35 and R41 are decided here with the
  reasoning inline.
