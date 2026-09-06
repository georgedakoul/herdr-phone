# Intent: full control from the phone

**Problem.** The first version is read plus reply: list the agents, open one, send a prompt,
press a key, look at the raw pane. That is enough to answer a blocked agent, but when I am
away from the desktop I still cannot start anything. If a task needs a fresh agent, or a
worktree for a branch, I have to wait until I am back at a keyboard. The sign out button also
sits in the bottom tab bar next to the views, where it is easy to hit by mistake and does not
belong.

**Outcome.** Everything I can do in the Herdr terminal I can do from the phone:

- The top bar has a three-line menu button. It opens a horizontal row with Agents, Worktrees,
  Actions and Sign out. The bottom tab bar goes away.
- On the Agents page a plus button next to the menu spins up a new agent: pick the kind
  (Claude by default), give it a name, and it appears in the list as a new pane in the
  current workspace and directory.
- On the Worktrees page the same plus button creates a worktree: branch name, base ref,
  label. Each worktree card can be opened, focused, or removed.
- The rest of what Herdr can do on a live session is reachable too: workspaces and tabs
  (create, rename, focus, close), panes (split, close, zoom, rename, run a command, send
  text), agents (rename, focus, wait, explain), notifications.

**Who and what it touches.** Me from my phone, and anyone who clones the repo. The Node
app in `src/` and `public/`, its tests and fixture, the README, and the `docs/main/spec.md`
out-of-scope list, which currently forbids every write beyond prompt, keys and actions and
has to be amended.

**Constraints.** Still one process, no dependencies, no build step, token required. Still
`execFile` with a fixed argv per command, never a shell, and every id, name, path and kind is
validated before it reaches the CLI. Nothing that can kill the server the phone talks
through: no `server stop`, `session stop`, `session delete`, `update`, `channel set`,
`integration install`, or config edits. The repo still carries no path, name or token from
my machine.

**Decided 2026-09-06.** Scope is everything that acts on the live session, machine admin
excluded (D1). A new agent goes in a sibling split of the workspace's focused pane, in that
pane's directory (D2). The kind picker shows only kinds whose integration is installed on
the box, with a free text field for the rest (D3). Also in: the Claude Code status line
(model, 5h and 7d usage) is unreadable in the transcript on a phone because the pane is
wider than the screen, so the transcript reflows on narrow screens only (D4).

**Open questions.** None.
