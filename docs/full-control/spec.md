# Spec: full control from the phone

Intent: `intent.md` at commit `ec16550`.

## Flagged concerns

- **C1. Out of scope in `docs/main/spec.md`** forbids "creating agents or panes, closing them,
  splitting layouts ... any write to Herdr beyond prompt, keys and plugin action invoke". The
  intent reverses that. Resolution: George's D1, everything on the live session is in, and
  the main spec gets a changelog line pointing here.
- **C2. `pane run` and `pane send-text` are arbitrary command execution.** The token already
  types into an agent with permissions bypassed, so nothing new is exposed, but the README
  warning gets one more sentence. Resolution: keep, document.
- **C3. Machine admin can kill the server the phone talks through** (`server stop`,
  `session stop`, `update`, `channel set`, `integration install`, config). Resolution: D1,
  excluded, and the client has no method for any of them.
- **C4. `agent wait` and `agent start` block for up to the CLI timeout.** An HTTP request that
  hangs for minutes is a bad phone experience and holds a Node socket. Resolution: cap both at
  120 s server side, pass `--timeout` to the CLI, and the UI disables the button meanwhile.
- **C5. Herdr positional text that starts with `-` is read as an option** by some subcommands.
  Resolution: names, labels, branches, refs, paths and commands that start with `-` are
  refused with a 400. Prompt text stays exempt as before (proven on 0.8.2).

## Requirements

Everything in `docs/main/spec.md` R1 to R21 still holds. New:

- **R22.** Top bar: a three-line menu button opens a horizontal row of Agents, Layout,
  Worktrees, Actions, Notify and Sign out under the bar. Picking one closes the row. The
  bottom tab bar is gone.
- **R23.** A plus button in the top bar, shown on Agents (new agent), Layout (new workspace
  or tab) and Worktrees (new worktree). Elsewhere it is hidden.
- **R24.** New agent: name (`[a-z][a-z0-9_-]{0,31}`), kind, target pane (default the
  focused pane), direction (right, default, or down). The server runs `pane split <pane>
  --direction <d> --cwd <pane cwd> --no-focus`, reads `result.pane.pane_id`, then
  `agent start <name> --kind <kind> --pane <new> --timeout <ms>`. On `agent_not_ready` the
  pane exists and the response says so; the agent list will pick it up.
- **R25.** Kind picker: `GET /api/kinds` returns the kinds whose integration `herdr
  integration status` reports as installed (`antigravity-cli` maps to `agy`), plus the full
  allowlist. The picker shows installed kinds as buttons and a text field for any other kind
  in the allowlist. A kind outside the allowlist is a 400.
- **R26.** Worktrees: create (`branch`, optional `base`, `path`, `label`, `workspace`
  or `cwd`), open (`path` or `branch`), focus the open workspace, remove (with `force`). Each
  card shows the buttons that apply: open when closed, focus and remove when open.
- **R27.** Layout view: workspaces with their tabs and panes from `api snapshot`, each with
  focus state, agent status and label. Per node actions: workspace focus, rename, close;
  tab focus, rename, close; pane split right or down, zoom toggle, rename or clear, run a
  command, send text, send a key, close, move to a new tab or a new workspace, swap with
  another pane, resize. Creating a workspace (`cwd`, `label`) or a tab (`workspace`, `cwd`,
  `label`) comes from the plus button.
- **R28.** Agent view gains a "more" sheet: rename or clear name, focus, explain (the
  text `agent explain` prints), wait (until idle, done, blocked, working, unknown, or the
  default set, capped at 120 s), zoom, run a command in the pane, send text, close the pane.
- **R29.** Notifications: `POST /api/notify` runs `notification show <title> [--body]
  [--position] [--sound]`. Reachable from the menu row as a small form.
- **R30.** Every write is a POST with a JSON body. Ids match `ID`, names match the agent
  name pattern, labels and titles are 1 to 120 printable characters, paths, branches and refs
  are 1 to 512 printable characters, commands and text are 1 to 4000 characters with no NUL,
  enums are checked against a fixed list, and nothing that starts with `-` reaches a
  positional slot (C5). Each CLI call is one `execFile` argv, never a shell.
- **R31.** Phone reflow of the transcript, on viewports up to 640 px wide only: lines made
  only of box-drawing characters become a thin rule, a line whose text is split by `|` into
  three or more cells is shown as wrapping chips (this is the Claude Code status line with
  model and usage limits), a line wrapped in `│ ... │` loses the bars, and trailing spaces
  are dropped. Wider viewports keep the raw text.
- **R32.** Tests cover every new client method's argv, every new route's happy path and its
  400s, the kinds parser, and the agent start flow including `agent_not_ready`. The fixture
  implements every new method so the UI can be driven without a server.
- **R33.** README lists the new abilities and the C2 sentence. No path, host or name from
  any machine (R17 still applies, the grep still runs).

## Design

`src/valid.js` gains `requireName`, `requireLabel`, `requirePath`, `requireText`,
`requireEnum`. `src/herdr.js` gains one method per CLI call, grouped by workspace, tab, pane,
agent, worktree, notification, plus `kinds()` which parses the plain text of `integration
status`. `src/app.js` gains the routes; the matcher keeps a single `:target` segment.
`public/index.html` gets the menu row, the plus button, the layout view and native `<dialog>`
elements for forms and action sheets. `public/app.js` renders the layout tree and the sheets
and does the reflow. `public/style.css` gets the menu, chips, rule and dialog styles. Nothing
about auth, polling or the existing views changes.

## Out of scope

Machine admin (C3). `pane input`, `report-*`, `release-agent`, `report-metadata`, which are
for integrations, not people. `agent attach`, which is a terminal. Multi-select or drag
layout editing. Session management.

## Changelog

- 2026-09-06: created. Approved by George's go to finish the whole thing.
