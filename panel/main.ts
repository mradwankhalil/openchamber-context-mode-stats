/**
 * Context Mode for OpenChamber — panel controller.
 *
 * <!-- DIRECTION
 * THESIS: one query, many ledgers. Every number answers to the visible filter
 *   bar (range, project, search) and every estimate is visibly marked; refuses
 *   the KPI-card dashboard.
 * OWN-WORLD: OpenChamber's own theme tokens; sentence-like statement rows of
 *   tabular figures, hairline-ruled ledgers, one accent for selection and live
 *   state, hatched amber for anything context-mode estimates.
 * STORY: see what is in scope, read the statement, sort the ledger, open a
 *   session to see its context curve and everything context-mode captured.
 * FIRST VIEWPORT: header with live run chip; view tabs; sticky filter bar;
 *   the statement and daily activity; the sessions ledger starts below.
 * FORM: filter-bar explorer (7th of 7 structures), seed c8e73cd2.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the
 *   finish review, the verdict, and DESIGN.md.
 * -->
 *
 * One page serves three host surfaces: the rail panel, the full-screen page
 * (`surface: "page"`), and the chat's Work Status section (`surface: "status"`).
 * The page is a view over the extension's local service; it never reads files.
 */

import { connectHost } from "@openchamber/sdk"
import type { HostReadyContext, JsonValue } from "@openchamber/sdk"
import { applyHostReady, mountSelect, mountTabs } from "@openchamber/sdk/ui"
import type { OverviewPayload, StatusPayload } from "../service/types.ts"
import { createApi, friendly } from "./api.ts"
import type { App, ViewRenderer } from "./app.ts"
import { hideTip } from "./charts.ts"
import { h, icon, iconButton, replace } from "./dom.ts"
import { bytes, duration, full } from "./format.ts"
import { DEFAULT_SETTINGS, RANGE_LABELS, RANGE_SHORT, initialView, normalize } from "./state.ts"
import type { RangeKey, UiSettings, View, ViewState } from "./state.ts"
import { renderDetail } from "./views/detail.ts"
import { renderInsights } from "./views/insights.ts"
import { renderKnowledge } from "./views/knowledge.ts"
import { renderRuns } from "./views/runs.ts"
import { renderSessions } from "./views/sessions.ts"
import { renderSettings } from "./views/settings.ts"
import { renderStatus } from "./views/status.ts"

const STORAGE_KEY = "settings:v1"
const host = connectHost()
const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("Missing #root")

let settings: UiSettings = structuredClone(DEFAULT_SETTINGS)
let view: ViewState = initialView(settings)
let status: StatusPayload | null = null
let mounted = false
let surface: HostReadyContext["surface"] = "panel"
let renderSeq = 0
let rendering = false
let pollTimer: number | null = null
let lastRenderAt = 0
const current = { sessionId: null as string | null, directory: null as string | null }

const api = createApi(host, () => settings.service)

const app: App = {
    host,
    api,
    get settings() { return settings },
    get view() { return view },
    get status() { return status },
    current,
    go(patch, opts) {
        const viewChanged = patch.view !== undefined && patch.view !== view.view
        view = { ...view, ...patch }
        if (viewChanged && patch.sessionId === undefined) view.sessionId = null
        if (patch.range !== undefined || patch.project !== undefined || patch.q !== undefined) {
            view.offset = 0
            view.runsOffset = 0
            view.kbOffset = 0
        }
        syncChrome()
        void render({ keepScroll: opts?.keepScroll ?? false })
    },
    async saveSettings(next) {
        settings = normalize(next)
        applyScale()
        try {
            await host.storage.set(STORAGE_KEY, settings as unknown as JsonValue)
        } catch (error) {
            app.toast(`Could not save settings: ${friendly(error).message}`, "error")
        }
        schedulePoll()
        syncChrome()
    },
    refresh() {
        void render({ keepScroll: true })
    },
    copy(text, what) {
        host.writeClipboard(text).then(() => app.toast(`${what} copied`, "success"), (e) => app.toast(friendly(e).message, "error"))
    },
    toast(message, kind = "info") {
        void host.toast({ kind, message }).catch(() => undefined)
    },
}

// ------------------------------------------------------------------ chrome

let refs: {
    liveChip: HTMLElement
    privacyBtn: HTMLButtonElement
    refreshBtn: HTMLButtonElement
    settingsBtn: HTMLButtonElement
    tabs: ReturnType<typeof mountTabs>
    filterbar: HTMLElement
    rangeSeg: HTMLElement
    dateRange: HTMLElement
    fromInput: HTMLInputElement
    toInput: HTMLInputElement
    project: ReturnType<typeof mountSelect>
    search: HTMLInputElement
    notice: HTMLElement
    progress: HTMLElement
    main: HTMLElement
} | null = null

let projectOptions: { id: string; label: string; hint?: string }[] = [{ id: "", label: "All projects" }]

function applyScale(): void {
    document.documentElement.style.fontSize = `${settings.display.scale}px`
}

function mountPanel(): void {
    const brand = h("div.brand", null, h("img", { src: "../icon.svg", alt: "" }), h("h1", null, "Context Mode"))
    const liveChip = h("span.live-chip", { title: "context-mode MCP server" }, h("span.dot"), "Connecting…")
    const privacyBtn = iconButton("eye", "Hide event text", () => {
        const next = structuredClone(settings)
        next.service.privacy.showContent = !settings.service.privacy.showContent
        void app.saveSettings(next).then(() => app.refresh())
    })
    const refreshBtn = iconButton("refresh", "Refresh now", () => app.refresh())
    const settingsBtn = iconButton("settings", "Settings", () => app.go({ view: view.view === "settings" ? settings.display.defaultView : "settings" }))
    const topbar = h("header.topbar", null, brand, liveChip, h("div.actions", null, privacyBtn, refreshBtn, settingsBtn))

    const navEl = h("nav.nav", { "aria-label": "Views" })
    const tabs = mountTabs(navEl, {
        items: [
            { id: "sessions", label: "Sessions" },
            { id: "insights", label: "Insights" },
            { id: "runs", label: "Runs" },
            { id: "knowledge", label: "Knowledge" },
        ],
        activeId: view.view === "settings" ? "" : view.view,
        onChange: (id) => app.go({ view: id as View, sessionId: null }),
    })

    const rangeSeg = h("div.seg", { role: "group", "aria-label": "Date range" })
    for (const key of ["today", "7d", "30d", "90d", "all", "custom"] as RangeKey[]) {
        const b = h("button", { type: "button", "data-range": key, title: RANGE_LABELS[key] }, RANGE_SHORT[key])
        b.addEventListener("click", () => app.go({ range: key }))
        rangeSeg.appendChild(b)
    }
    const fromInput = h("input.date-input", { type: "date", "aria-label": "From" }) as HTMLInputElement
    const toInput = h("input.date-input", { type: "date", "aria-label": "To" }) as HTMLInputElement
    fromInput.addEventListener("change", () => fromInput.value && app.go({ customFrom: fromInput.value }))
    toInput.addEventListener("change", () => toInput.value && app.go({ customTo: toInput.value }))
    const dateRange = h("span.daterange", null, fromInput, "to", toInput)
    const projectHost = h("div.filter-project")
    const project = mountSelect(projectHost, {
        value: view.project,
        options: projectOptions,
        searchable: true,
        searchPlaceholder: "Find a project",
        placeholder: "All projects",
        onChange: (id) => {
            project.update({ value: id })
            app.go({ project: id })
        },
    })
    const search = h("input.text-input", { type: "search", placeholder: "Search sessions, ids, models", "aria-label": "Search" }) as HTMLInputElement
    let searchTimer: number | undefined
    search.addEventListener("input", () => {
        window.clearTimeout(searchTimer)
        searchTimer = window.setTimeout(() => app.go({ q: search.value }, { keepScroll: true }), 260)
    })
    const filterbar = h("div.filterbar", null, rangeSeg, dateRange, projectHost, h("div.search", null, icon("search", 16), search))
    const notice = h("div.notice")
    const progress = h("div")
    const main = h("main.view", { "aria-live": "polite" }, h("p.boot", null, "Loading…"))
    replace(root!, h("div.app", null, topbar, navEl, filterbar, notice, progress, main))
    refs = { liveChip, privacyBtn, refreshBtn, settingsBtn, tabs, filterbar, rangeSeg, dateRange, fromInput, toInput, project, search, notice, progress, main }
    syncChrome()
}

function syncChrome(): void {
    if (!refs) return
    refs.tabs.update({ activeId: view.view === "settings" ? "" : view.view })
    refs.filterbar.hidden = view.view === "settings"
    refs.settingsBtn.setAttribute("aria-pressed", String(view.view === "settings"))
    refs.rangeSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === view.range)))
    refs.dateRange.hidden = view.range !== "custom"
    refs.fromInput.value = view.customFrom
    refs.toInput.value = view.customTo
    refs.project.update({ value: view.project, options: projectOptions })
    if (refs.search.value !== view.q && document.activeElement !== refs.search) refs.search.value = view.q
    const shown = settings.service.privacy.showContent
    replace(refs.privacyBtn, icon(shown ? "eye" : "eyeOff"))
    refs.privacyBtn.setAttribute("aria-label", shown ? "Hide event text" : "Show event text")
    refs.privacyBtn.title = shown ? "Event text is shown — click to hide it" : "Event text is hidden — click to show it"
    refs.privacyBtn.setAttribute("aria-pressed", String(!shown))
    // The ledger header sticks below the filter bar.
    root!.style.setProperty("--sticky-top", view.view === "settings" ? "0px" : `${refs.filterbar.offsetHeight}px`)
}

function paintStatus(): void {
    if (!refs) return
    const s = status
    const lives = s?.liveRuns ?? []
    if (lives.length) {
        const calls = lives.reduce((a, r) => a + r.calls, 0)
        const returned = lives.reduce((a, r) => a + r.bytesReturned, 0)
        const up = Math.max(...lives.map((r) => r.uptimeMs))
        replace(refs.liveChip, h("span.dot.on"), h("b", null, lives.length > 1 ? `${lives.length} servers live` : "Live"), ` · ${full(calls)} calls · ${bytes(returned)} returned · up ${duration(up)}`)
        refs.liveChip.title = lives.map((r) => `context-mode server started ${new Date(r.startedAt).toLocaleTimeString()} (parent pid ${r.pid}): ${r.calls} calls`).join("\n") + "\nCounters reset when OpenCode restarts."
    } else {
        replace(refs.liveChip, h("span.dot"), s ? "No live context-mode server" : "Connecting…")
    }
    const p = s?.progress
    if (p && p.phase === "scanning") {
        const pctDone = p.total ? Math.round((p.done / p.total) * 100) : 0
        replace(refs.progress, h("div.progress", null,
            h("span", null, `Indexing context-mode history: ${full(p.done)} of ${full(p.total)} session databases. Numbers fill in as it goes.`),
            h("div.progress-track", null, h("div.progress-fill", { style: `--p:${(pctDone / 100).toFixed(3)}` }))))
    } else replace(refs.progress)
}

// ----------------------------------------------------------------- render

const VIEWS: Record<Exclude<View, "sessions">, ViewRenderer> = {
    insights: renderInsights,
    runs: renderRuns,
    knowledge: renderKnowledge,
    settings: renderSettings,
}

async function render(opts: { keepScroll: boolean } = { keepScroll: true }): Promise<void> {
    const seq = ++renderSeq
    const isStale = () => seq !== renderSeq
    rendering = true
    hideTip()
    if (refs) refs.refreshBtn.classList.add("spin")
    try {
        if (surface === "status") {
            await renderStatus(app, root!, isStale)
            if (!isStale()) void host.setHeight(Math.ceil(root!.scrollHeight)).catch(() => undefined)
            return
        }
        const main = refs!.main
        const scroll = document.scrollingElement?.scrollTop ?? 0
        status = await api<StatusPayload>("/v1/status")
        if (isStale()) return
        paintStatus()
        const renderer: ViewRenderer = view.view === "sessions" ? (view.sessionId ? renderDetail : renderSessions) : VIEWS[view.view]
        await renderer(app, main, isStale)
        if (isStale()) return
        replace(refs!.notice)
        if (opts.keepScroll && document.scrollingElement) document.scrollingElement.scrollTop = scroll
        else if (!opts.keepScroll) window.scrollTo({ top: 0 })
        syncChrome()
        lastRenderAt = Date.now()
    } catch (error) {
        if (isStale()) return
        const f = friendly(error)
        const target = surface === "status" ? root! : refs!.notice
        replace(target, h("div.explain", null,
            h("h3", null, f.code === "NOT_FOUND" ? "Session not found" : "Could not load context-mode data"),
            h("p", null, f.message),
            f.code === "NOT_FOUND" ? null : h("p.muted", null, `Code: ${f.code}`)))
        if (f.code === "NOT_FOUND" && view.sessionId) {
            view.sessionId = null
        }
        if (surface === "status") void host.setHeight(Math.ceil(root!.scrollHeight)).catch(() => undefined)
    } finally {
        if (!isStale()) {
            rendering = false
            refs?.refreshBtn.classList.remove("spin")
        }
    }
}

async function loadProjects(): Promise<void> {
    try {
        const o = await api<OverviewPayload>("/v1/overview", { filter: { subagents: true }, topN: 100 })
        projectOptions = [{ id: "", label: "All projects" }, ...o.projectsTop
            .slice()
            .sort((a, b) => b.lastEventAt - a.lastEventAt)
            .map((p) => ({ id: p.dir, label: p.name, hint: `${p.sessions}` }))]
        if (view.project && !projectOptions.some((p) => p.id === view.project)) projectOptions.push({ id: view.project, label: view.project })
        syncChrome()
    } catch {
        // the filter keeps its previous options
    }
}

function schedulePoll(): void {
    if (pollTimer !== null) window.clearInterval(pollTimer)
    pollTimer = null
    const sec = settings.display.refreshSec
    if (!sec) return
    pollTimer = window.setInterval(() => {
        if (document.hidden || rendering) return
        if (surface !== "status" && view.view === "settings") return
        if (Date.now() - lastRenderAt < sec * 1000 - 200) return
        void render({ keepScroll: true })
    }, Math.max(1000, sec * 1000))
}

// ------------------------------------------------------------------- boot

/** Deep link for development and tests: `index.html#view=runs&session=ses_…&range=30d`. The host never sets it. */
function hashView(): Partial<ViewState> {
    const p = new URLSearchParams(location.hash.slice(1))
    const out: Partial<ViewState> = {}
    const v = p.get("view")
    if (v && ["sessions", "insights", "runs", "knowledge", "settings"].includes(v)) out.view = v as View
    const r = p.get("range")
    if (r && r in RANGE_LABELS) out.range = r as RangeKey
    const s = p.get("session")
    if (s) {
        out.view = "sessions"
        out.sessionId = s
    }
    return out
}

host.onSession((session) => {
    const id = session?.id ?? null
    if (id === current.sessionId) return
    current.sessionId = id
    if (mounted) void render({ keepScroll: true })
})

host.onDirectory((directory) => {
    if (directory === current.directory) return
    current.directory = directory
    if (mounted && surface === "status") void render({ keepScroll: true })
})

host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement)
    applyScale()
    if (mounted) return
    mounted = true
    surface = ctx.surface
    current.sessionId = ctx.session?.id ?? null
    current.directory = ctx.directory
    document.documentElement.dataset.surface = surface
    void (async () => {
        try {
            const stored = await host.storage.get(STORAGE_KEY)
            if (stored !== undefined) settings = normalize(stored)
        } catch {
            // defaults
        }
        applyScale()
        view = { ...initialView(settings), ...hashView() }
        if (surface !== "status") {
            mountPanel()
            void loadProjects()
            window.setInterval(() => { if (!document.hidden) void loadProjects() }, 60_000)
        }
        await render({ keepScroll: false })
        schedulePoll()
    })()
})

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && mounted && Date.now() - lastRenderAt > 2000) void render({ keepScroll: true })
})
