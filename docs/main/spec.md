# Spec: herdr-phone

Derived from `docs/main/intent.md`. Upstream requirement: `fedora-box/docs/main/spec.md` R24.

## Concerns

- **C1. This is a remote code execution surface.** The app can type into an agent pane, and on
  the originating box that pane runs Claude Code with permissions bypassed. Anyone who reaches
  the port can run anything as the user. The global rules "treat all external input as
  untrusted" and "secrets come from env vars" both apply. Resolution: authentication is
  mandatory and cannot be switched off, the server binds `127.0.0.1` unless the operator
  overrides it on purpose, and the token never appears in a committed file.
- **C2. Public repo, private machine.** The intent asks for a repo other people use. Nothing in
  it may carry a path, hostname, tailnet name, agent name or token from the originating box.
  Resolution: every machine-specific value is an environment variable with a portable default,
  and the socket path is left to Herdr itself.
- **C3. No runtime dependencies.** Ponytail, plus "one process, no build step" from the intent.
  A terminal renderer is the usual reason to reach for a package. Resolution: hand-written SGR
  parser, roughly 60 lines, covering the colour codes a TUI actually emits.
- **C4. Cannot be proven against a live server from the laptop.** The originating desktop is
  offline and starting a Herdr server on the laptop is forbidden. Resolution: the Herdr client
  is one injectable function, the tests drive it with response shapes taken from the bundled API
  schema (protocol 20), and a fixture server boots the real HTTP app against canned data so the
  UI is exercised in a real browser. The live-socket leg is proof criteria for the desktop, not
  for the laptop, and is written down as such.
- **C5. Global "do not create files nobody asked for" versus a public repo.** A README and a
  LICENSE are normally out of scope. Here the intent asks for a repo strangers can clone and
  start, so both are in scope and nothing else is.

## Requirements

- **R1.** One Node process, no runtime dependencies, no build step. `node src/index.js` is the
  whole start command. Node 22 or newer, standard library only. Testable: `package.json` has no
  `dependencies` key and the repo has no lockfile.
- **R2.** The app talks to Herdr by running the `herdr` CLI, which prints the same JSON envelope
  the bundled API schema documents. The binary comes from `HERDR_BIN`, default `herdr` on
  `PATH`. Every call goes through one function so it can be replaced in tests.
- **R3.** Success is read from the JSON body, never from the exit code. `herdr` prints
  `{"id":...,"error":{"code","message"}}` and exits 0 when no server is running, so an
  exit-code check would report success on a dead server. A body carrying `error` becomes a
  thrown error carrying `code` and `message`.
- **R4.** On startup the app runs `herdr status --json` and refuses to serve unless the server is
  running and `server.protocol` equals the pinned protocol (20). The failure message names the
  expected protocol, the found protocol and the herdr version, and the process exits non-zero.
  `HERDR_PROTOCOL=<n>` lets an operator accept a different protocol deliberately.
- **R5.** Authentication is mandatory. The token is `HERDR_PHONE_TOKEN` if set, otherwise the app
  generates one with `crypto.randomBytes(24)` and prints it once at startup with the URL to
  open. A generated token is never written to disk. Comparison is `crypto.timingSafeEqual` over
  hashes, so tokens of different lengths compare in constant time too.
- **R6.** A successful login sets an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie holding the
  token. Every API route and the app shell require the cookie and return 401 without it. The
  login page is the only unauthenticated route. `Secure` is set when the request arrived over
  HTTPS or through a proxy that says so, so it works both behind `tailscale serve` and on plain
  localhost.
- **R7.** The server binds `127.0.0.1` on port 8787 by default. `HOST` and `PORT` override.
  Binding anything other than a loopback address prints a one-line warning naming the address,
  so exposing it is always a deliberate act.
- **R8.** Home screen: every agent from `herdr api snapshot`, showing name, status, working
  folder and token count when Herdr reports one. Blocked agents sort first and are visually
  distinct. The list refreshes on a 2 second poll without losing scroll position.
- **R9.** Agent view: the transcript from `herdr agent read <target> --source recent --format
  text`, newest at the bottom, refreshing on the same poll. A prompt box submits with `herdr
  agent prompt <target> <text>` and clears on success.
- **R10.** Key buttons: esc, enter, yes, no, up and down, sent with `herdr agent send-keys
  <target> <key>`. "yes" and "no" send the letter followed by enter, because that is what a TUI
  confirmation expects.
- **R11.** Raw terminal view: `herdr pane read <pane_id> --format ansi --source visible`
  rendered to HTML with colours, bold and dim preserved. Every value that reaches HTML is
  escaped first. Unknown escape sequences are dropped, never printed.
- **R12.** Worktrees view: `herdr worktree list`, showing the label, the branch, and whether the
  worktree is open in a workspace.
- **R13.** Actions view: `herdr plugin action list` with a run button per action calling `herdr
  plugin action invoke <action_id> --plugin <plugin_id>`, and the outcome reported in the UI as
  success or the error message from the body.
- **R14.** Installable on the iPhone home screen: a web manifest with name, icons and `display:
  standalone`, plus `apple-mobile-web-app-capable`. Layout is single column, touch targets are
  at least 44 pixels, and it respects the safe area insets so nothing sits under the home
  indicator.
- **R15.** Every route that changes something is a POST carrying the same-origin cookie.
  Combined with `SameSite=Strict` that covers CSRF. Request bodies are capped at 64 KB and
  parsed defensively: a body that is not the expected shape returns 400, not a stack trace.
- **R16.** Agent targets and pane ids arriving from the client are passed as separate `execFile`
  arguments, never through a shell, and are rejected before the call unless they match
  `^[A-Za-z0-9_.:-]{1,120}$`. Prompt text is exempt from the pattern because it is free text,
  and is still passed as a single argument with no shell.
- **R17.** No path, hostname, tailnet name, agent name or token from any particular machine
  appears anywhere in the repo. Testable: grep the tree for the originating user, host and
  tailnet strings and find nothing.
- **R18.** Tests run with `node --test` and cover the client envelope handling (success, error
  body with exit 0, unparseable output), the ANSI to HTML parser, the argument validator, the
  auth middleware (no cookie, wrong token, right token) and the protocol preflight. All pass.
- **R19.** A fixture server (`test/fixture-server.js`) boots the real HTTP app with a canned
  Herdr client, so the UI opens in a browser with no Herdr server anywhere. Proof on the laptop
  is browser screenshots at iPhone dimensions of the home screen, the agent view and the
  terminal view.
- **R20.** README covers what it is, what it needs, how to start it, the environment variables,
  how to expose it with `tailscale serve`, and the security warning from C1 in plain words. MIT
  LICENSE at the root.
- **R21.** A systemd user unit template ships in `deploy/`, using `%h` and environment variables
  only, so it installs unchanged on any Linux box.

## Out of scope

Creating agents or panes, closing them, splitting layouts, editing files, git operations, push
notifications, multi-user accounts, and any write to Herdr beyond prompt, keys and plugin action
invoke. Read plus reply is the whole product.

## Changelog

- 2026-09-05. First version.
