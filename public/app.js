/* One page, six views, one poll timer that only fetches for the view on screen. */
(() => {
  "use strict"

  const POLL_MS = 2000
  const $ = (id) => document.getElementById(id)
  const body = document.body
  const phone = matchMedia("(max-width: 640px)")

  const state = {
    view: "home", agent: null, paneId: null, agentTitle: "", inFlight: false,
    agentsRevision: "", layoutRevision: "", transcript: null, reflowed: null, openWorkspaces: null,
  }

  const el = {
    title: $("title"), back: $("back"), net: $("net"), menu: $("menu"), menuRow: $("menu-row"), plus: $("plus"), notify: $("notify"),
    agents: $("agents"), agentsEmpty: $("agents-empty"),
    transcript: $("transcript"), promptForm: $("prompt-form"), promptText: $("prompt-text"), promptSend: $("prompt-send"),
    terminal: $("terminal"),
    layout: $("layout"), layoutEmpty: $("layout-empty"),
    worktrees: $("worktrees"), worktreesEmpty: $("worktrees-empty"),
    actions: $("actions"), actionsEmpty: $("actions-empty"), actionResult: $("action-result"),
    dlg: $("dlg"), dlgForm: $("dlg-form"), dlgTitle: $("dlg-title"), dlgBody: $("dlg-body"),
  }

  const TITLES = { home: "Agents", agent: "", terminal: "Terminal", layout: "Layout", worktrees: "Worktrees", actions: "Actions" }
  const PLUS = { home: "New agent", layout: "New workspace or tab", worktrees: "New worktree" }
  const POLLED = new Set(["home", "agent", "terminal", "layout"])
  const KEYS = ["esc", "enter", "up", "down", "yes", "no"]
  const WAIT_STATES = ["idle", "done", "blocked", "working", "unknown"]
  const POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"]
  const SOUNDS = ["none", "done", "request"]
  const NAME_PATTERN = "[a-z][a-z0-9_\\-]{0,31}"

  async function api(path, options) {
    const res = await fetch(path, { credentials: "same-origin", ...options })
    if (res.status === 401) {
      location.href = "/login"
      throw new Error("signed out")
    }
    let data = {}
    try { data = await res.json() } catch { data = {} }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`)
    return data
  }

  const postJson = (path, payload) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })

  const enc = encodeURIComponent

  function setNet(message, isError) {
    el.net.textContent = message || ""
    el.net.classList.toggle("error", Boolean(isError))
  }

  function setMenu(open) {
    el.menuRow.hidden = !open
    el.menu.setAttribute("aria-expanded", String(open))
  }

  function show(view, options = {}) {
    state.view = view
    body.dataset.view = view
    if (view === "agent" && options.title) state.agentTitle = options.title
    el.title.textContent = view === "agent" ? state.agentTitle || state.agent || "Agent" : TITLES[view]
    el.back.hidden = view !== "agent" && view !== "terminal"
    el.plus.hidden = !PLUS[view]
    if (PLUS[view]) el.plus.setAttribute("aria-label", PLUS[view])
    for (const tab of document.querySelectorAll("[data-goto]")) {
      const current = tab.dataset.goto === view || (tab.dataset.goto === "home" && (view === "agent" || view === "terminal"))
      if (current) tab.setAttribute("aria-current", "page")
      else tab.removeAttribute("aria-current")
    }
    setMenu(false)
    setNet("")
    refresh()
  }

  /** Phones capitalise and autocorrect by default, which mangles commands, flags and paths. */
  function noAutocorrect(input) {
    input.setAttribute("autocapitalize", "off")
    input.setAttribute("autocorrect", "off")
    input.spellcheck = false
  }

  const text = (tag, content, className) => {
    const node = document.createElement(tag)
    node.textContent = content
    if (className) node.className = className
    return node
  }

  function button(label, onClick, className) {
    const node = text("button", label, className)
    node.type = "button"
    node.addEventListener("click", onClick)
    return node
  }

  // agent_session is an object ({agent, kind, source, value}), never a display name, so it
  // must never reach the DOM. Only a non-empty string is a label.
  const named = (value) => (typeof value === "string" && value.trim() ? value.trim() : "")
  const paneName = (pane) => named(pane.terminal_title_stripped) || named(pane.terminal_title) || named(pane.agent)

  function agentName(agent) {
    return named(agent.name) || paneName(agent) || agent.pane_id || agent.terminal_id
  }

  // herdr addresses an agent by its pane id (w1:p3); the terminal id is agent_not_found.
  function targetOf(agent) {
    return agent.pane_id || agent.terminal_id
  }

  function openAgent(agent) {
    state.agent = targetOf(agent)
    state.paneId = agent.pane_id || null
    state.transcript = null
    el.transcript.replaceChildren()
    show("agent", { title: agentName(agent) })
  }

  // ---- dialogs: one native <dialog> reused for every form and action sheet ----

  let resolveDialog = null
  el.dlg.addEventListener("close", () => {
    // close() fires this event asynchronously, so a sheet that opens a form in its own
    // handler sees this land after showModal. That stale event must not cancel the form.
    if (el.dlg.open) return
    const resolve = resolveDialog
    resolveDialog = null
    if (resolve) resolve(null)
  })
  el.dlg.addEventListener("click", (event) => { if (event.target === el.dlg) el.dlg.close() })
  el.dlgForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const resolve = resolveDialog
    resolveDialog = null
    const values = {}
    for (const [key, value] of new FormData(el.dlgForm)) if (value !== "") values[key] = value
    if (values.kind_other) { values.kind = values.kind_other; delete values.kind_other }
    el.dlg.close()
    if (resolve) resolve(values)
  })

  function openDialog(title, build) {
    return new Promise((resolve) => {
      resolveDialog = resolve
      el.dlgTitle.textContent = title
      el.dlgBody.replaceChildren()
      build((value) => {
        resolveDialog = null
        el.dlg.close()
        resolve(value)
      })
      el.dlg.showModal()
    })
  }

  /** A list of tappable choices. Resolves to the chosen value, or null on cancel. */
  function openSheet(title, items, note) {
    return openDialog(title, (finish) => {
      if (note) el.dlgBody.append(text("pre", note, "note"))
      const list = document.createElement("div")
      list.className = "sheet"
      for (const item of items) list.append(button(item.label, () => finish(item.value), item.danger ? "danger" : ""))
      list.append(button("Cancel", () => finish(null), "quiet"))
      el.dlgBody.append(list)
    })
  }

  const optionOf = (option) => (typeof option === "string" ? { value: option, label: option } : option)

  /** A short form. Resolves to the values (empty fields dropped), or null on cancel. */
  function openForm(title, fields, submitLabel = "OK") {
    return openDialog(title, (finish) => {
      for (const field of fields) {
        const wrap = document.createElement("label")
        wrap.className = "field"
        wrap.append(text("span", field.label, "field-label"))
        let input
        if (field.type === "select") {
          input = document.createElement("select")
          for (const option of field.options.map(optionOf)) {
            const node = new Option(option.label, option.value, false, option.value === field.value)
            input.append(node)
          }
        } else if (field.type === "choice") {
          // Installed kinds as buttons, anything else in the allowlist by name.
          wrap.className = "field choice"
          const row = document.createElement("div")
          row.className = "chips"
          field.options.forEach((option, index) => {
            const radio = document.createElement("label")
            radio.className = "chip choice-chip"
            const node = Object.assign(document.createElement("input"), { type: "radio", name: field.name, value: option, checked: index === 0 })
            radio.append(node, text("span", option))
            row.append(radio)
          })
          wrap.append(row)
          input = document.createElement("input")
          input.name = `${field.name}_other`
          input.placeholder = "or type another kind"
          input.setAttribute("list", "kinds-all")
          const list = document.createElement("datalist")
          list.id = "kinds-all"
          for (const kind of field.other) list.append(new Option(kind))
          wrap.append(list)
        } else if (field.type === "textarea") {
          input = document.createElement("textarea")
          input.rows = 3
          noAutocorrect(input)
        } else {
          input = document.createElement("input")
          input.type = field.type || "text"
          if (field.pattern) input.pattern = field.pattern
          if (field.min !== undefined) input.min = field.min
          if (field.max !== undefined) input.max = field.max
          if (field.step !== undefined) input.step = field.step
          if (field.inputmode) input.inputMode = field.inputmode
        }
        if (field.type !== "choice") input.name = field.name
        if (field.value !== undefined && field.type !== "select") input.value = field.value
        if (field.placeholder) input.placeholder = field.placeholder
        if (field.required) input.required = true
        if (field.maxlength) input.maxLength = field.maxlength
        wrap.append(input)
        if (field.hint) wrap.append(text("span", field.hint, "hint"))
        el.dlgBody.append(wrap)
      }
      const row = document.createElement("div")
      row.className = "buttons"
      const submit = text("button", submitLabel)
      submit.type = "submit"
      row.append(button("Cancel", () => finish(null), "quiet"), submit)
      el.dlgBody.append(row)
      const first = el.dlgBody.querySelector("input:not([type=radio]), select, textarea")
      if (first) setTimeout(() => first.focus(), 50)
    })
  }

  /** Posts, reports on the net line, and makes the polled views redraw. */
  async function act(path, payload, doneMessage, control) {
    if (control) control.disabled = true
    try {
      const result = await postJson(path, payload || {})
      setNet(doneMessage || "done")
      state.agentsRevision = ""
      state.layoutRevision = ""
      refresh()
      return result
    } catch (error) {
      setNet(error.message, true)
      return null
    } finally {
      if (control) control.disabled = false
    }
  }

  // ---- forms behind the plus button and the menu ----

  const paneLabel = (pane) => [pane.pane_id, paneName(pane), pane.focused ? "focused" : ""].filter(Boolean).join(" · ")

  async function newAgent() {
    let kinds, layout
    try {
      ;[kinds, layout] = await Promise.all([api("/api/kinds"), api("/api/layout")])
    } catch (error) {
      setNet(error.message, true)
      return
    }
    const installed = kinds.installed.length ? kinds.installed : ["claude"]
    const values = await openForm("New agent", [
      { name: "name", label: "Name", required: true, pattern: NAME_PATTERN, placeholder: "lowercase, digits, - and _", maxlength: 32 },
      { name: "kind", label: "Kind", type: "choice", options: installed, other: kinds.all.filter((k) => !installed.includes(k)) },
      { name: "pane", label: "Split from pane", type: "select", options: layout.panes.map((p) => ({ value: p.pane_id, label: paneLabel(p) })), value: layout.focused_pane_id },
      { name: "direction", label: "Direction", type: "select", options: ["right", "down"] },
    ], "Start")
    if (!values) return
    setNet(`starting ${values.name}, up to two minutes…`)
    el.plus.disabled = true
    try {
      const result = await postJson("/api/agents/start", values)
      state.agentsRevision = ""
      // Open it either way: a not-ready agent is usually blocked on a question only its screen shows.
      openAgent({ name: values.name, pane_id: result.pane_id, ...(result.agent || {}) })
      // show() clears the status line, so say the awkward part after it.
      if (!result.ready) setNet(`${values.name} is not ready yet, it may be waiting on a prompt`, true)
    } catch (error) {
      setNet(error.message, true)
    } finally {
      el.plus.disabled = false
    }
  }

  async function newWorkspace(cwd) {
    const values = await openForm("New workspace", [
      { name: "cwd", label: "Directory", placeholder: "leave empty for the default", value: cwd },
      { name: "label", label: "Label", maxlength: 120 },
    ], "Create")
    if (values) await act("/api/workspaces", values, "workspace created", el.plus)
  }

  async function newTab(workspaceId) {
    let layout
    try { layout = await api("/api/layout") } catch (error) { setNet(error.message, true); return }
    const values = await openForm("New tab", [
      { name: "workspace", label: "Workspace", type: "select", options: layout.workspaces.map((w) => ({ value: w.workspace_id, label: w.label || w.workspace_id })), value: workspaceId || layout.focused_workspace_id },
      { name: "cwd", label: "Directory", placeholder: "leave empty for the default" },
      { name: "label", label: "Label", maxlength: 120 },
    ], "Create")
    if (values) await act("/api/tabs", values, "tab created", el.plus)
  }

  async function newWorktree() {
    let layout
    try { layout = await api("/api/layout") } catch (error) { setNet(error.message, true); return }
    const values = await openForm("New worktree", [
      { name: "branch", label: "Branch", required: true, placeholder: "feat/thing", maxlength: 512 },
      { name: "base", label: "Base ref", placeholder: "main (optional)", maxlength: 512 },
      { name: "workspace", label: "From workspace", type: "select", options: [{ value: "", label: "use the directory below" }, ...layout.workspaces.map((w) => ({ value: w.workspace_id, label: w.label || w.workspace_id }))], value: layout.focused_workspace_id },
      { name: "cwd", label: "Repository directory", placeholder: "only if no workspace is chosen" },
      { name: "path", label: "Worktree path", placeholder: "optional" },
      { name: "label", label: "Label", maxlength: 120 },
    ], "Create")
    if (!values) return
    const result = await act("/api/worktrees", values, "worktree created", el.plus)
    if (result) FETCH.worktrees()
  }

  async function sendNotification() {
    const values = await openForm("Desktop notification", [
      { name: "title", label: "Title", required: true, maxlength: 120 },
      { name: "body", label: "Body", type: "textarea" },
      { name: "position", label: "Position", type: "select", options: POSITIONS },
      { name: "sound", label: "Sound", type: "select", options: SOUNDS },
    ], "Show")
    if (values) await act("/api/notify", values, "notification sent")
  }

  // ---- action sheets ----

  async function askText(title, label, options = {}) {
    const values = await openForm(title, [{ name: "value", label, required: true, ...options }], options.submit || "OK")
    return values ? values.value : null
  }

  async function paneActions(pane, layout) {
    const id = pane.pane_id
    const others = (layout ? layout.panes : []).filter((p) => p.pane_id !== id)
    const otherTabs = (layout ? layout.tabs : []).filter((t) => t.tab_id !== pane.tab_id)
    const items = []
    if (pane.agent) items.push({ label: `Open agent ${paneName(pane)}`, value: "open" })
    items.push(
      { label: "Split right", value: "split-right" },
      { label: "Split down", value: "split-down" },
      { label: pane.zoomed ? "Unzoom" : "Zoom", value: "zoom" },
      { label: "Rename", value: "rename" },
      { label: "Clear name", value: "clear" },
      { label: "Run a command", value: "run" },
      { label: "Send text", value: "text" },
      { label: "Send a key", value: "key" },
      { label: "Move to a new tab", value: "new-tab" },
      { label: "Move to a new workspace", value: "new-workspace" },
    )
    if (otherTabs.length) items.push({ label: "Move to another tab", value: "move-tab" })
    if (others.length) items.push({ label: "Swap with another pane", value: "swap" })
    items.push({ label: "Resize", value: "resize" }, { label: "Close pane", value: "close", danger: true })
    const choice = await openSheet(`Pane ${id}`, items)
    if (!choice) return
    const post = (action, payload, message) => act(`/api/pane/${enc(id)}/${action}`, payload, message)
    switch (choice) {
      case "open": return openAgent(pane)
      case "split-right": return post("split", { direction: "right" }, "split right")
      case "split-down": return post("split", { direction: "down" }, "split down")
      case "zoom": return post("zoom", { mode: "toggle" }, "zoom toggled")
      case "rename": {
        const label = await askText("Rename pane", "Label", { maxlength: 120, value: pane.terminal_title_stripped || "" })
        return label && post("rename", { label }, "renamed")
      }
      case "clear": return post("rename", { clear: true }, "name cleared")
      case "run": {
        const command = await askText("Run in pane", "Command", { placeholder: "runs in the pane's shell", submit: "Run" })
        return command && post("run", { command }, "command sent")
      }
      case "text": {
        const value = await askText("Send text", "Text", { type: "textarea", submit: "Send" })
        return value && post("text", { text: value }, "text sent")
      }
      case "key": {
        const key = await openSheet("Send a key", KEYS.map((k) => ({ label: k, value: k })))
        return key && post("keys", { key }, `sent ${key}`)
      }
      case "new-tab": return post("move", { new_tab: true }, "moved to a new tab")
      case "new-workspace": return post("move", { new_workspace: true }, "moved to a new workspace")
      case "move-tab": {
        const tab = await openSheet("Move to tab", otherTabs.map((t) => ({ label: `${t.label || t.tab_id} (${t.workspace_id})`, value: t.tab_id })))
        return tab && post("move", { tab }, "moved")
      }
      case "swap": {
        const other = await openSheet("Swap with", others.map((p) => ({ label: paneLabel(p), value: p.pane_id })))
        return other && post("swap", { with: other }, "swapped")
      }
      case "resize": {
        const values = await openForm("Resize pane", [
          { name: "direction", label: "Grow towards", type: "select", options: ["left", "right", "up", "down"] },
          { name: "amount", label: "Amount (0 to 1)", type: "number", value: "0.1", min: "0.01", max: "1", step: "0.01", inputmode: "decimal" },
        ], "Resize")
        return values && post("resize", { direction: values.direction, amount: Number(values.amount) }, "resized")
      }
      case "close": return post("close", {}, "pane closed")
    }
  }

  async function tabActions(tab) {
    const choice = await openSheet(`Tab ${tab.label || tab.tab_id}`, [
      { label: "Focus", value: "focus" },
      { label: "Rename", value: "rename" },
      { label: "Close tab", value: "close", danger: true },
    ])
    if (!choice) return
    const post = (action, payload, message) => act(`/api/tab/${enc(tab.tab_id)}/${action}`, payload, message)
    if (choice === "focus") return post("focus", {}, "tab focused")
    if (choice === "close") return post("close", {}, "tab closed")
    const label = await askText("Rename tab", "Label", { maxlength: 120, value: tab.label || "" })
    return label && post("rename", { label }, "renamed")
  }

  async function workspaceActions(ws) {
    const choice = await openSheet(`Workspace ${ws.label || ws.workspace_id}`, [
      { label: "Focus", value: "focus" },
      { label: "Rename", value: "rename" },
      { label: "New tab here", value: "tab" },
      { label: "Close workspace", value: "close", danger: true },
    ])
    if (!choice) return
    const post = (action, payload, message) => act(`/api/workspace/${enc(ws.workspace_id)}/${action}`, payload, message)
    if (choice === "focus") return post("focus", {}, "workspace focused")
    if (choice === "close") return post("close", {}, "workspace closed")
    if (choice === "tab") return newTab(ws.workspace_id)
    const label = await askText("Rename workspace", "Label", { maxlength: 120, value: ws.label || "" })
    return label && post("rename", { label }, "renamed")
  }

  async function agentMore() {
    if (!state.agent) return
    const target = state.agent
    const paneId = state.paneId
    const choice = await openSheet(state.agentTitle || target, [
      { label: "Rename", value: "rename" },
      { label: "Clear name", value: "clear" },
      { label: "Focus on the desktop", value: "focus" },
      { label: "Explain", value: "explain" },
      { label: "Wait for a state", value: "wait" },
      { label: "Zoom", value: "zoom" },
      { label: "Run a command in the pane", value: "run" },
      { label: "Send text to the pane", value: "text" },
      { label: "Close the pane", value: "close", danger: true },
    ])
    if (!choice) return
    const agentPost = (action, payload, message) => act(`/api/agent/${enc(target)}/${action}`, payload, message, el.agentMore)
    const panePost = (action, payload, message) => {
      if (!paneId) { setNet("no pane id for this agent yet", true); return null }
      return act(`/api/pane/${enc(paneId)}/${action}`, payload, message, el.agentMore)
    }
    switch (choice) {
      case "rename": {
        const name = await askText("Rename agent", "Name", { pattern: NAME_PATTERN, maxlength: 32, placeholder: "lowercase, digits, - and _" })
        if (name && (await agentPost("rename", { name }, "renamed"))) { state.agentTitle = name; el.title.textContent = name }
        return
      }
      case "clear": return agentPost("rename", { clear: true }, "name cleared")
      case "focus": return agentPost("focus", {}, "focused on the desktop")
      case "explain": {
        try {
          const result = await api(`/api/agent/${enc(target)}/explain`)
          await openSheet("Explain", [], result.text || "(nothing to say)")
        } catch (error) {
          setNet(error.message, true)
        }
        return
      }
      case "wait": {
        const until = await openSheet("Wait until", [{ label: "Any change (default)", value: "any" }, ...WAIT_STATES.map((s) => ({ label: s, value: s }))])
        if (!until) return
        setNet("waiting, up to two minutes…")
        const result = await agentPost("wait", until === "any" ? {} : { until: [until] }, "wait finished")
        if (result && result.agent && result.agent.agent_status) setNet(`now ${result.agent.agent_status}`)
        return
      }
      case "zoom": return panePost("zoom", { mode: "toggle" }, "zoom toggled")
      case "run": {
        const command = await askText("Run in pane", "Command", { submit: "Run" })
        return command && panePost("run", { command }, "command sent")
      }
      case "text": {
        const value = await askText("Send text", "Text", { type: "textarea", submit: "Send" })
        return value && panePost("text", { text: value }, "text sent")
      }
      case "close": {
        const sure = await openSheet("Close this pane?", [{ label: "Close pane", value: "yes", danger: true }])
        if (sure && (await panePost("close", {}, "pane closed"))) show("home")
      }
    }
  }

  // ---- renderers ----

  function renderAgents(data) {
    const agents = data.agents || []
    // Skip the DOM work when nothing changed, which keeps scroll and taps stable.
    const revision = JSON.stringify(agents.map((a) => [targetOf(a), agentName(a), a.agent_status, a.revision, a.tokens]))
    if (revision === state.agentsRevision) return
    state.agentsRevision = revision
    el.agents.replaceChildren()
    el.agentsEmpty.hidden = agents.length > 0
    for (const agent of agents) {
      const li = document.createElement("li")
      const card = document.createElement("button")
      card.type = "button"
      card.className = `card status-${agent.agent_status || "unknown"}`
      card.append(text("span", agentName(agent), "name"), text("span", agent.agent_status || "unknown", "status"))
      const meta = []
      if (agent.pane_id) meta.push(agent.pane_id)
      if (agent.cwd) meta.push(agent.cwd)
      if (agent.tokens) meta.push(typeof agent.tokens === "object" ? JSON.stringify(agent.tokens) : `${agent.tokens} tokens`)
      if (meta.length) card.append(text("span", meta.join(" · "), "meta"))
      card.addEventListener("click", () => openAgent(agent))
      li.append(card)
      el.agents.append(li)
    }
  }

  const BOX_ONLY = /^[─-╿\s]+$/
  const BAR_WRAPPED = /^\s*│(.*)│\s*$/
  const CELL_SPLIT = /\s*[|│]\s*/

  /** Phone-only reshaping of terminal text: rules, chips for status lines, bars gone. */
  function reflow(value) {
    const nodes = []
    for (const raw of value.split("\n")) {
      let line = raw.replace(/\s+$/, "")
      if (line && BOX_ONLY.test(line)) {
        nodes.push(Object.assign(document.createElement("hr"), { className: "rule" }))
        continue
      }
      const wrapped = line.match(BAR_WRAPPED)
      if (wrapped) line = wrapped[1].trim()
      const cells = line.split(CELL_SPLIT).map((c) => c.trim()).filter(Boolean)
      if (cells.length >= 3) {
        const row = document.createElement("div")
        row.className = "chips"
        for (const cell of cells) row.append(text("span", cell, "chip"))
        nodes.push(row)
        continue
      }
      nodes.push(text("div", line, "line"))
    }
    return nodes
  }

  function renderTranscript(data) {
    const value = data.text || ""
    const atBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 40
    if (value !== state.transcript || state.reflowed !== phone.matches) {
      state.transcript = value
      state.reflowed = phone.matches
      if (phone.matches) el.transcript.replaceChildren(...reflow(value))
      else el.transcript.textContent = value
      if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight
    }
    if (data.pane_id) state.paneId = data.pane_id
  }

  function renderTerminal(data) {
    // The server escaped every character and only emits span style attributes.
    if (el.terminal.innerHTML !== data.html) el.terminal.innerHTML = data.html || ""
  }

  function renderLayout(data) {
    const revision = JSON.stringify(data)
    if (revision === state.layoutRevision) return
    state.layoutRevision = revision
    const workspaces = data.workspaces || []
    el.layout.replaceChildren()
    el.layoutEmpty.hidden = workspaces.length > 0
    const zoomed = new Set(data.zoomed || [])
    for (const ws of workspaces) {
      const details = document.createElement("details")
      details.className = `ws${ws.focused ? " focused" : ""}`
      details.open = state.openWorkspaces ? state.openWorkspaces.has(ws.workspace_id) : ws.focused || workspaces.length === 1
      details.addEventListener("toggle", () => {
        if (!state.openWorkspaces) state.openWorkspaces = new Set(workspaces.filter((w) => w.focused || workspaces.length === 1).map((w) => w.workspace_id))
        if (details.open) state.openWorkspaces.add(ws.workspace_id)
        else state.openWorkspaces.delete(ws.workspace_id)
      })
      const summary = document.createElement("summary")
      summary.append(text("span", ws.label || ws.workspace_id, "name"), text("span", [ws.workspace_id, ws.focused ? "focused" : "", ws.agent_status].filter(Boolean).join(" · "), "status"))
      summary.append(button("⋯", (event) => { event.preventDefault(); workspaceActions(ws) }, "more"))
      details.append(summary)
      for (const tab of (data.tabs || []).filter((t) => t.workspace_id === ws.workspace_id)) {
        const tabRow = document.createElement("div")
        tabRow.className = `node tab${tab.focused ? " focused" : ""}`
        tabRow.append(text("span", tab.label || tab.tab_id, "name"), text("span", [tab.tab_id, tab.focused ? "focused" : "", tab.agent_status].filter(Boolean).join(" · "), "status"))
        tabRow.append(button("⋯", () => tabActions(tab), "more"))
        details.append(tabRow)
        for (const pane of (data.panes || []).filter((p) => p.tab_id === tab.tab_id)) {
          const isZoomed = zoomed.has(pane.pane_id)
          const row = button("", () => paneActions({ ...pane, zoomed: isZoomed }, data), `node pane status-${pane.agent_status || "none"}${pane.focused ? " focused" : ""}`)
          const label = paneName(pane) || pane.pane_id
          row.append(text("span", label, "name"))
          const bits = label === pane.pane_id ? [] : [pane.pane_id]
          if (pane.agent) bits.push(`${pane.agent} ${pane.agent_status || ""}`.trim())
          if (pane.focused) bits.push("focused")
          if (isZoomed) bits.push("zoomed")
          row.append(text("span", bits.join(" · "), "status"))
          if (pane.cwd) row.append(text("span", pane.cwd, "meta"))
          details.append(row)
        }
      }
      el.layout.append(details)
    }
  }

  function renderWorktrees(data) {
    const list = data.worktrees || []
    el.worktrees.replaceChildren()
    el.worktreesEmpty.hidden = list.length > 0
    for (const wt of list) {
      const li = document.createElement("li")
      li.className = "card static"
      li.append(text("span", wt.label || wt.path, "name"))
      const bits = []
      if (wt.branch) bits.push(wt.branch)
      if (wt.is_detached) bits.push("detached")
      if (wt.open_workspace_id) bits.push(`open in ${wt.open_workspace_id}`)
      if (wt.is_prunable) bits.push("prunable")
      if (bits.length) li.append(text("span", bits.join(" · "), "status"))
      if (wt.path && wt.path !== wt.label) li.append(text("span", wt.path, "meta"))
      const row = document.createElement("div")
      row.className = "row"
      const after = (promise) => promise.then((result) => { if (result) FETCH.worktrees() })
      if (wt.open_workspace_id) {
        const id = wt.open_workspace_id
        row.append(button("Focus", (event) => act(`/api/workspace/${enc(id)}/focus`, {}, "workspace focused", event.currentTarget)))
        row.append(button("Remove", async (event) => {
          const target = event.currentTarget
          const how = await openSheet(`Remove ${wt.label || wt.branch || wt.path}?`, [
            { label: "Remove", value: "plain", danger: true },
            { label: "Force remove (drops changes)", value: "force", danger: true },
          ])
          if (how) after(act("/api/worktrees/remove", { workspace: id, force: how === "force" }, "worktree removed", target))
        }, "danger"))
      } else if (wt.path || wt.branch) {
        row.append(button("Open", (event) => after(act("/api/worktrees/open", wt.path ? { path: wt.path } : { branch: wt.branch }, "worktree opened", event.currentTarget))))
      }
      if (row.childElementCount) li.append(row)
      el.worktrees.append(li)
    }
  }

  function renderActions(data) {
    const list = data.actions || []
    el.actions.replaceChildren()
    el.actionsEmpty.hidden = list.length > 0
    for (const action of list) {
      const li = document.createElement("li")
      const card = document.createElement("button")
      card.type = "button"
      card.className = "card"
      card.append(text("span", action.title || action.action_id, "name"), text("span", action.plugin_id, "status"))
      if (action.description) card.append(text("span", action.description, "meta"))
      card.addEventListener("click", async () => {
        card.disabled = true
        el.actionResult.textContent = `Running ${action.title || action.action_id}…`
        el.actionResult.className = "result"
        try {
          const result = await postJson("/api/actions/invoke", { action_id: action.action_id, plugin_id: action.plugin_id })
          el.actionResult.textContent = `Done: ${action.title || action.action_id}${result.log ? `\n${result.log}` : ""}`
          el.actionResult.className = "result ok"
        } catch (error) {
          el.actionResult.textContent = `Failed: ${error.message}`
          el.actionResult.className = "result error"
        } finally {
          card.disabled = false
        }
      })
      li.append(card)
      el.actions.append(li)
    }
  }

  const FETCH = {
    home: () => api("/api/agents").then(renderAgents),
    agent: () => (state.agent ? api(`/api/agent/${enc(state.agent)}`).then(renderTranscript) : Promise.resolve()),
    terminal: () => (state.paneId ? api(`/api/pane/${enc(state.paneId)}`).then(renderTerminal) : Promise.resolve()),
    layout: () => api("/api/layout").then(renderLayout),
    worktrees: () => api("/api/worktrees").then(renderWorktrees),
    actions: () => api("/api/actions").then(renderActions),
  }

  async function refresh() {
    if (state.inFlight || document.hidden) return
    state.inFlight = true
    try {
      await FETCH[state.view]()
      if (el.net.classList.contains("error")) setNet("")
    } catch (error) {
      setNet(error.message, true)
    } finally {
      state.inFlight = false
    }
  }

  // Worktrees and actions do not change by themselves, so they load on entry and after a write.
  setInterval(() => { if (POLLED.has(state.view)) refresh() }, POLL_MS)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh() })
  phone.addEventListener("change", () => { if (state.view === "agent") refresh() })

  el.menu.addEventListener("click", () => setMenu(el.menuRow.hidden))
  el.back.addEventListener("click", () => show(state.view === "terminal" ? "agent" : "home"))
  for (const tab of document.querySelectorAll("[data-goto]")) tab.addEventListener("click", () => show(tab.dataset.goto))
  el.notify.addEventListener("click", () => { setMenu(false); sendNotification() })

  el.plus.addEventListener("click", async () => {
    if (state.view === "home") return newAgent()
    if (state.view === "worktrees") return newWorktree()
    if (state.view === "layout") {
      const choice = await openSheet("New", [{ label: "Workspace", value: "workspace" }, { label: "Tab", value: "tab" }])
      if (choice === "workspace") return newWorkspace()
      if (choice === "tab") return newTab()
    }
  })

  /** Grow the prompt box with the text instead of leaving a two-line slot with a scrollbar in it. */
  function grow() {
    el.promptText.style.height = "auto"
    el.promptText.style.height = `${Math.min(el.promptText.scrollHeight, Math.round(innerHeight / 3))}px`
  }
  el.promptText.addEventListener("input", grow)

  // Enter sends. isComposing keeps an IME's own enter from firing it mid-word.
  el.promptText.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    el.promptForm.requestSubmit()
  })

  el.promptForm.addEventListener("submit", async (event) => {
    event.preventDefault()
    const value = el.promptText.value.trim()
    if (!value || !state.agent) return
    el.promptSend.disabled = true
    try {
      await postJson(`/api/agent/${enc(state.agent)}/prompt`, { text: value })
      el.promptText.value = ""
      grow()
      setNet("sent")
    } catch (error) {
      setNet(error.message, true)
    } finally {
      el.promptSend.disabled = false
    }
  })

  show("home")
})()
