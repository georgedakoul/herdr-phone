# Plan: full control from the phone

Spec: `spec.md` at the commit that adds it.

## Files that change

- `src/valid.js`: five validators and the agent name and kind patterns.
- `src/herdr.js`: kinds parser, agent start flow, and one method per CLI call.
- `src/app.js`: routes for kinds, layout, agents/start, agent more, pane, workspace, tab,
  worktree write, notify.
- `public/index.html`: menu row, plus button, layout view, dialogs.
- `public/app.js`: menu, plus button, layout tree, sheets, forms, reflow.
- `public/style.css`: menu, dialog, chips, rule, tree.
- `test/valid.test.js`, `test/herdr.test.js`, `test/app.test.js`: new cases.
- `test/fixture-server.js`: every new method canned.
- `README.md`: abilities list and the C2 sentence.
- `docs/main/spec.md`: changelog line pointing at this spec.

## Order of work

1. Validators with tests. Proof: `npm test` green.
2. Client methods with argv tests, including `startAgent` split-then-start and the
   `agent_not_ready` pass-through, and `kinds()` on a canned `integration status` text.
3. Routes with tests: happy path calls the right client method with the right arguments,
   bad bodies are 400.
4. Fixture methods.
5. Front end: menu and plus button, then the new agent and new worktree forms, then the
   layout view and sheets, then the agent more sheet, then the reflow.
6. Browser proof on the fixture at 390x844, then against the live server: start a Claude
   agent in a throwaway workspace, rename it, zoom, close the pane, close the workspace.
7. README and the main spec changelog.
8. `two-axis-review` against `ec16550` with `spec.md` as the source.

## Risks

- Real CLI shapes for `workspace create`, `tab create`, `pane split`, `worktree create` are
  documented in the skill file but not yet seen. Contained by step 6 on the live server,
  which is where they get corrected.
- `agent start` blocks until the agent is ready or 120 s pass. Contained by the timeout
  argument and a disabled button while the request runs.
- The layout tree can get long on a busy session. Contained by collapsing workspaces that
  are not focused.
- Testing on the live server touches George's Herdr UI. Contained by using a fresh
  workspace with `--no-focus` and closing it afterwards, never touching his two panes.

## Rejected options

- Nested views for workspace, tab and pane instead of one tree. Three more views and three
  more back buttons for the same information.
- A generic "run any herdr subcommand" route. It would make validation impossible and
  reintroduce the machine admin group by the back door.
- Hand-rolled modal divs. `<dialog>` is native and handles focus and escape.

## Proof criteria

1. `npm test` green, count printed, higher than 50.
2. `node --check` on every file under `src/`, `public/`, `test/`.
3. Fixture screenshots at 390x844: menu row open, new agent form, layout tree, worktree
   card with buttons, transcript with a chip row on a narrow viewport.
4. Live server: a Claude agent started from the phone UI appears in `herdr agent list`
   with the given name in a new pane; rename, zoom, close pane and close workspace each
   answer ok and the layout view reflects it within one poll.
5. `grep -ri` for the originating user, host and tailnet strings across the tree returns
   nothing.
6. `package.json` still has no `dependencies` key.

## Departures

None yet.
