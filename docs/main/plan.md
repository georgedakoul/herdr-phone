# Plan: herdr-phone

Implements `docs/main/spec.md` R1 to R21.

## Shape

One process. `src/index.js` reads the environment, runs the protocol preflight, builds the app
and listens. `src/app.js` is a plain `(req, res)` handler with no server of its own, so tests
and the fixture can mount it. `src/herdr.js` is the only place that knows Herdr exists.

```
src/index.js      env, preflight, listen, token banner
src/app.js        router, cookie auth, JSON helpers, static files
src/herdr.js      call(args) -> parsed result, plus one function per API call the UI needs
src/ansi.js       SGR and escape sequences to safe HTML
src/valid.js      target/pane id pattern, body parsing, escapeHtml
public/index.html app shell, one page, four tabs
public/app.js     fetch + render, 2 second poll
public/style.css  phone-first layout, safe area insets
public/manifest.webmanifest, public/icon.svg
test/*.test.js    node --test
test/fixture-server.js  the real app against a canned client
deploy/herdr-phone.service
README.md, LICENSE
```

## Order of work

1. `src/valid.js` and `src/ansi.js` with their tests. Pure functions, no I/O, so they are done
   and proven before anything can depend on them being right.
2. `src/herdr.js`: `createClient({ bin, run })` where `run` defaults to `execFile`. It returns
   `{ call, status, snapshot, agentRead, agentPrompt, sendKeys, paneRead, worktrees, actions,
   invokeAction }`. `call` parses stdout as JSON, throws on an `error` body regardless of exit
   code (R3), throws a clear error when stdout is not JSON, and unwraps `result`. Tests inject a
   fake `run`.
3. `src/app.js`: the router. Routes are
   `GET /` (shell, auth), `GET /login`, `POST /login`, `POST /logout`,
   `GET /api/agents`, `GET /api/agent/:target`, `POST /api/agent/:target/prompt`,
   `POST /api/agent/:target/keys`, `GET /api/pane/:id`, `GET /api/worktrees`,
   `GET /api/actions`, `POST /api/actions/invoke`, plus the static files.
   Auth is a single check at the top of the handler; the allowlist of unauthenticated paths is
   the login page, the login POST, the stylesheet and the manifest.
4. `src/index.js`: preflight against `herdr status --json`, token resolution and banner, bind
   warning, listen.
5. The front end. One HTML page, tabs switch a `data-view` attribute, one poll timer that only
   fetches for the visible view.
6. `test/fixture-server.js` and the browser proof.
7. README, LICENSE, deploy unit.
8. `two-axis-review` against the first commit, then fix what is real.

## Risks

- **The exact CLI stdout envelope for a success is unverified.** No Herdr server can be started
  here. The error envelope was observed directly. The schema documents the success envelope as
  `{id, result}` with a `type` discriminator on the result. Mitigation: `call` accepts either the
  full envelope or a bare result object with a `type` field, and every accessor tolerates a
  missing optional field rather than throwing. The live check is the first thing to run on the
  desktop.
- **Poll cost.** Four calls per poll would spawn four processes every 2 seconds. Mitigation: the
  poll fetches only the visible view, one Herdr call each, and the browser skips a poll while the
  previous one is in flight or the page is hidden.
- **A wrong ANSI parser prints escape codes into the page or, worse, unescaped HTML.**
  Mitigation: escape first, then wrap in spans, and drop any sequence that is not a recognised
  SGR. A test feeds it a string containing `<script>` inside a coloured run.
- **Token in a URL.** Tempting for a phone bookmark, and it would leak through history and any
  proxy log. Rejected: login is a form POST that sets the cookie once, and iOS keeps the cookie
  for a home screen app.

## Rejected options

- **Raw socket instead of the CLI.** The framing is not documented in the bundled schema and
  cannot be tested here. The CLI is the supported surface, ships on every platform Herdr does,
  and costs one process per call, which is nothing at a 2 second poll.
- **`events.subscribe` with a websocket.** Real-time and elegant, and it doubles the moving
  parts for a single-user phone app. Polling at 2 seconds is indistinguishable on a phone.
- **xterm.js for the terminal view.** A dependency, a build step and 300 KB for what 60 lines of
  SGR handling covers, since this view is read-only.
- **Optional auth for localhost.** Rejected under C1. There is no configuration that turns auth
  off.

## Proof criteria

On this laptop, all of it runnable with no Herdr server:

1. `npm test` passes with every test green, and the count is printed.
2. `node --check` on every file under `src/` and `public/`.
3. `npm run fixture` serves, and browser screenshots at 390x844 show the home screen with a
   blocked agent sorted first, the agent view with the transcript and the key buttons, and the
   terminal view with colour.
4. `grep -ri` for the originating user, host and tailnet strings across the tree returns
   nothing (R17).
5. `node -e` check that `package.json` has no `dependencies` key (R1).

On the desktop, once it is back online, the R24 proof from the upstream plan:

6. `herdr status --json` reports protocol 20, the app starts, and the iPhone opens the home
   screen over `tailscale serve` and lists the same agents `herdr agent list` prints.
7. A prompt typed on the phone appears in the pane on the laptop.
8. A clean clone starts with only the environment variables the README names.

Laptop stand-in, 2026-09-06, against a live Herdr 0.8.2 server that George started himself:
criterion 6 holds apart from the phone and `tailscale serve`. The app started with `HERDR_BIN`
pointing at the installed binary, the browser at 390x844 listed the same two idle Claude Code
panes that `herdr agent list` prints, opened one and showed its transcript, and the terminal
view rendered the pane with colour (39 styled spans). Send-keys landed: an `esc` posted to an
idle pane answered `{"ok":true,"sent":["esc"]}`. Criterion 7 passed later the same day, with
George's go, in a throwaway workspace the app created with `--no-focus`: the app started a Claude
agent there, posted "Reply with exactly the word PONG and nothing else.", the wait route came back
idle, the read route returned the pane with the prompt and `● PONG` under it, and the workspace was
closed through the app. His own panes were not touched. Criterion 8 still waits for the desktop.

## Departures

- 2026-09-06, step 2: the client methods are named `prompt` and `sendKey`, not
  `agentPrompt` and `sendKeys`. One key per call is all the phone sends.
- 2026-09-06, step 4: prompt text and key names are also validated in the HTTP routes,
  not only in the client, so a canned client in tests cannot let a bad body through (R15).
- 2026-09-06, step 5: the entry point was proved on Windows through a Node preload that
  replaces `child_process.execFile`, because Windows cannot run a script as a fake `herdr`
  binary and no WSL distro was available. The four preflight branches, the cookie login and
  the non-loopback warning were all exercised that way.
- 2026-09-06, step 6: `npm test` runs `test/*.test.js` only. Node's default pattern also
  matched `test/fixture-server.js`, which listens forever and hung the run.
- 2026-09-06, step 7: the three proof screenshots live in `docs/main/screenshots/` and the
  README links them.
- 2026-09-06, laptop stand-in: against a real Herdr 0.8.2 server the `<target>` for
  `agent read`, `agent prompt` and `agent send-keys` is the pane id (`w1:p3`), and the
  terminal id answers `agent_not_found`. The phone now targets the pane id. `agent read`
  and `pane read` print the pane text itself rather than a JSON envelope, so the client
  treats their stdout as text and only parses a one-line error envelope. Real agents carry
  no `name` or `tokens`; the card shows the stripped terminal title and the pane id instead.
