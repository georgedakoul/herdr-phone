/* One page, five views, one poll timer that only fetches for the view on screen. */
(() => {
  "use strict"

  const POLL_MS = 2000
  const $ = (id) => document.getElementById(id)
  const body = document.body

  const state = { view: "home", agent: null, paneId: null, inFlight: false, agentsRevision: "" }

  const el = {
    title: $("title"), back: $("back"), net: $("net"),
    agents: $("agents"), agentsEmpty: $("agents-empty"),
    transcript: $("transcript"), promptForm: $("prompt-form"), promptText: $("prompt-text"), promptSend: $("prompt-send"),
    terminal: $("terminal"), openTerminal: $("open-terminal"),
    worktrees: $("worktrees"), worktreesEmpty: $("worktrees-empty"),
    actions: $("actions"), actionsEmpty: $("actions-empty"), actionResult: $("action-result"),
  }

  const TITLES = { home: "Agents", agent: "", terminal: "Terminal", worktrees: "Worktrees", actions: "Actions" }

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

  function setNet(message, isError) {
    el.net.textContent = message || ""
    el.net.classList.toggle("error", Boolean(isError))
  }

  function show(view, options = {}) {
    state.view = view
    body.dataset.view = view
    el.title.textContent = view === "agent" ? options.title || state.agent || "Agent" : TITLES[view]
    el.back.hidden = view === "home" || view === "worktrees" || view === "actions"
    for (const tab of document.querySelectorAll("[data-goto]")) {
      const current = tab.dataset.goto === view || (tab.dataset.goto === "home" && (view === "agent" || view === "terminal"))
      if (current) tab.setAttribute("aria-current", "page")
      else tab.removeAttribute("aria-current")
    }
    setNet("")
    refresh()
  }

  const text = (tag, content, className) => {
    const node = document.createElement(tag)
    node.textContent = content
    if (className) node.className = className
    return node
  }

  function agentName(agent) {
    return agent.name || agent.display_agent || agent.title || agent.terminal_title_stripped || agent.agent || agent.terminal_id
  }

  // herdr addresses an agent by its pane id (w1:p3); the terminal id is agent_not_found.
  function targetOf(agent) {
    return agent.pane_id || agent.terminal_id
  }

  function renderAgents(data) {
    const agents = data.agents || []
    // Skip the DOM work when nothing changed, which keeps scroll and taps stable.
    const revision = JSON.stringify(agents.map((a) => [targetOf(a), a.agent_status, a.revision, a.tokens]))
    if (revision === state.agentsRevision) return
    state.agentsRevision = revision
    el.agents.replaceChildren()
    el.agentsEmpty.hidden = agents.length > 0
    for (const agent of agents) {
      const li = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"
      button.className = `card status-${agent.agent_status || "unknown"}`
      button.append(text("span", agentName(agent), "name"), text("span", agent.agent_status || "unknown", "status"))
      const meta = []
      if (agent.pane_id) meta.push(agent.pane_id)
      if (agent.cwd) meta.push(agent.cwd)
      if (agent.tokens) meta.push(typeof agent.tokens === "object" ? JSON.stringify(agent.tokens) : `${agent.tokens} tokens`)
      if (meta.length) button.append(text("span", meta.join(" · "), "meta"))
      button.addEventListener("click", () => {
        state.agent = targetOf(agent)
        state.paneId = agent.pane_id || null
        el.transcript.textContent = ""
        show("agent", { title: agentName(agent) })
      })
      li.append(button)
      el.agents.append(li)
    }
  }

  function renderTranscript(data) {
    const atBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 40
    if (el.transcript.textContent !== data.text) {
      el.transcript.textContent = data.text || ""
      if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight
    }
    if (data.pane_id) state.paneId = data.pane_id
  }

  function renderTerminal(data) {
    // The server escaped every character and only emits span style attributes.
    if (el.terminal.innerHTML !== data.html) el.terminal.innerHTML = data.html || ""
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
      if (wt.open_workspace_id) bits.push("open")
      if (wt.is_prunable) bits.push("prunable")
      if (bits.length) li.append(text("span", bits.join(" · "), "status"))
      if (wt.path && wt.path !== wt.label) li.append(text("span", wt.path, "meta"))
      el.worktrees.append(li)
    }
  }

  function renderActions(data) {
    const list = data.actions || []
    el.actions.replaceChildren()
    el.actionsEmpty.hidden = list.length > 0
    for (const action of list) {
      const li = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"
      button.className = "card"
      button.append(text("span", action.title || action.action_id, "name"), text("span", action.plugin_id, "status"))
      if (action.description) button.append(text("span", action.description, "meta"))
      button.addEventListener("click", async () => {
        button.disabled = true
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
          button.disabled = false
        }
      })
      li.append(button)
      el.actions.append(li)
    }
  }

  const FETCH = {
    home: () => api("/api/agents").then(renderAgents),
    agent: () => (state.agent ? api(`/api/agent/${encodeURIComponent(state.agent)}`).then(renderTranscript) : Promise.resolve()),
    terminal: () => (state.paneId ? api(`/api/pane/${encodeURIComponent(state.paneId)}`).then(renderTerminal) : Promise.resolve()),
    worktrees: () => api("/api/worktrees").then(renderWorktrees),
    actions: () => api("/api/actions").then(renderActions),
  }

  async function refresh() {
    if (state.inFlight || document.hidden) return
    state.inFlight = true
    try {
      await FETCH[state.view]()
      setNet("")
    } catch (error) {
      setNet(error.message, true)
    } finally {
      state.inFlight = false
    }
  }

  // Worktrees and actions do not change by themselves, so they load on entry only.
  setInterval(() => {
    if (state.view === "home" || state.view === "agent" || state.view === "terminal") refresh()
  }, POLL_MS)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh() })

  el.back.addEventListener("click", () => show(state.view === "terminal" ? "agent" : "home"))
  for (const tab of document.querySelectorAll("[data-goto]")) tab.addEventListener("click", () => show(tab.dataset.goto))

  el.openTerminal.addEventListener("click", () => {
    if (!state.paneId) { setNet("no pane id for this agent yet", true); return }
    el.terminal.innerHTML = ""
    show("terminal")
  })

  el.promptForm.addEventListener("submit", async (event) => {
    event.preventDefault()
    const value = el.promptText.value.trim()
    if (!value || !state.agent) return
    el.promptSend.disabled = true
    try {
      await postJson(`/api/agent/${encodeURIComponent(state.agent)}/prompt`, { text: value })
      el.promptText.value = ""
      setNet("sent")
    } catch (error) {
      setNet(error.message, true)
    } finally {
      el.promptSend.disabled = false
    }
  })

  for (const button of document.querySelectorAll("[data-key]")) {
    button.addEventListener("click", async () => {
      if (!state.agent) return
      button.disabled = true
      try {
        await postJson(`/api/agent/${encodeURIComponent(state.agent)}/keys`, { key: button.dataset.key })
        setNet(`sent ${button.dataset.key}`)
      } catch (error) {
        setNet(error.message, true)
      } finally {
        button.disabled = false
      }
    })
  }

  show("home")
})()
