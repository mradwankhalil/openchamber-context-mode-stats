/** Settings: locations (discovered + overrides), privacy, data filters, display, and what the numbers mean. */

import type { DiscoveredLocation, LocationKind, StatusPayload } from "../../service/types.ts"
import type { ViewRenderer } from "../app.ts"
import { h, icon, replace } from "../dom.ts"
import { ago, bytes, full } from "../format.ts"
import { DEFAULT_SETTINGS, RANGE_LABELS, SESSION_COLUMNS, normalize } from "../state.ts"
import type { ColumnId, RangeKey, UiSettings } from "../state.ts"
import { GLOSSARY } from "../widgets.ts"

const KIND_LABEL: Record<LocationKind, string> = {
    sessions: "Session event databases",
    stats: "Run stats files",
    content: "Knowledge-base databases",
    opencodeDb: "OpenCode database",
}

const lines = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
    return h("label.field", null, h("span", null, label), control, help ? h("small", null, help) : null)
}

function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, help?: string): HTMLElement {
    const input = h("input", { type: "checkbox" }) as HTMLInputElement
    input.checked = checked
    input.addEventListener("change", () => onChange(input.checked))
    return h("label.toggle", null, input, h("span", null, label), help ? h("small", null, help) : null)
}

function select<T extends string | number>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
    const el = h("select") as HTMLSelectElement
    for (const [v, label] of options) {
        const o = h("option", { value: String(v) }, label) as HTMLOptionElement
        if (v === value) o.selected = true
        el.appendChild(o)
    }
    el.addEventListener("change", () => {
        const picked = options.find(([v]) => String(v) === el.value)
        if (picked) onChange(picked[0])
    })
    return el
}

function textarea(value: string, placeholder: string, onInput: (v: string) => void): HTMLTextAreaElement {
    const t = h("textarea", { rows: 2, placeholder, spellcheck: "false" }) as HTMLTextAreaElement
    t.value = value
    t.addEventListener("input", () => onInput(t.value))
    return t
}

function input(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
    const i = h("input", { type: "text", placeholder, spellcheck: "false" }) as HTMLInputElement
    i.value = value
    i.addEventListener("input", () => onInput(i.value))
    return i
}

function locationTable(locs: DiscoveredLocation[]): HTMLElement {
    const body = h("tbody")
    for (const l of locs) {
        const state = l.used
            ? h("span.badge.ok", null, icon("check", 12), " in use")
            : l.exists ? h("span.badge", null, "empty") : h("span.badge.warn", null, "missing")
        body.appendChild(h("tr", null,
            h("td", { style: "text-align:left;white-space:nowrap" }, KIND_LABEL[l.kind]),
            h("td.path", null, l.path, h("div.row-sub", null, l.origin === "setting" ? "your setting" : l.origin === "data-root" ? "from data root" : l.note ?? "auto-detected")),
            h("td", null, state),
            h("td", null, full(l.files)),
            h("td.col-opt", null, bytes(l.bytes)),
            h("td.col-opt", null, l.newestMs ? ago(l.newestMs) : "–")))
    }
    return h("table.ledger.loc-table", null,
        h("thead", null, h("tr", null, h("th", null, "Store"), h("th", { style: "text-align:left" }, "Path"), h("th", null, "Status"), h("th", null, "Files"), h("th.col-opt", null, "Size"), h("th.col-opt", null, "Updated"))),
        body)
}

export const renderSettings: ViewRenderer = async (app, el, isStale) => {
    const status = await app.api<StatusPayload>("/v1/status")
    if (isStale()) return
    const draft: UiSettings = structuredClone(app.settings)
    const loc = draft.service.locations
    const d = draft.display
    let dirty = false
    const saveBtn = h("button.btn.primary", { type: "button", disabled: true }, "Save settings")
    const resetBtn = h("button.btn", { type: "button" }, "Reset to defaults")
    const mark = () => {
        dirty = true
        saveBtn.disabled = false
    }
    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true
        await app.saveSettings(normalize(draft))
        dirty = false
        app.toast("Settings saved", "success")
        app.refresh()
    })
    resetBtn.addEventListener("click", async () => {
        await app.saveSettings(structuredClone(DEFAULT_SETTINGS))
        app.toast("Settings reset to defaults", "success")
        app.refresh()
    })

    const disc = status.discovery
    const columns = h("div.chips", { role: "group", "aria-label": "Ledger columns" })
    for (const c of SESSION_COLUMNS) {
        const on = d.columns.includes(c.id)
        const chip = h("button.chip", { type: "button", "aria-pressed": String(on), style: "--tone:var(--accent)" }, h("i"), c.label)
        chip.addEventListener("click", () => {
            const set = new Set<ColumnId>(d.columns)
            if (set.has(c.id)) set.delete(c.id)
            else set.add(c.id)
            d.columns = SESSION_COLUMNS.map((x) => x.id).filter((id) => set.has(id))
            chip.setAttribute("aria-pressed", String(set.has(c.id)))
            mark()
        })
        columns.appendChild(chip)
    }

    replace(el, h("div.settings", null,
        h("section.set-section", null,
            h("h2", null, "Locations"),
            h("p", null, "Every store is found automatically from your home folder. If something is missing, point at it here: one folder per line. A setting replaces auto-detection for that store; leave it empty to keep auto-detection. The service never writes to any of these."),
            locationTable(disc.locations),
            !disc.sqlite.available ? h("div.explain", null, h("h3", null, "SQLite is unavailable"), h("p", null, `This OpenChamber runtime (Node ${disc.node}) has no node:sqlite: ${disc.sqlite.error ?? ""}. Session and knowledge-base data need it; run stats still work.`)) : null,
            h("div.set-grid", null,
                field("context-mode data folder", input(loc.dataRoot, "auto — e.g. ~/.config/opencode", (v) => { loc.dataRoot = v; mark() }), "The folder that contains context-mode/ (same as CONTEXT_MODE_DATA_DIR). Sets all three context-mode stores at once."),
                field("OpenCode database", input(loc.opencodeDb, "auto — e.g. ~/.local/share/opencode/opencode.db", (v) => { loc.opencodeDb = v; mark() }), "Adds session titles, models, agents and subagent links. Optional."),
                field("Session event databases", textarea(loc.sessionDirs.join("\n"), "auto — folders holding <hash>.db", (v) => { loc.sessionDirs = lines(v); mark() }), "Written by context-mode's OpenCode plugin. Usually %APPDATA%\\opencode\\context-mode\\sessions on Windows."),
                field("Run stats files", textarea(loc.statsDirs.join("\n"), "auto — folders holding stats-pid-*.json", (v) => { loc.statsDirs = lines(v); mark() }), "Written by context-mode's MCP server. Usually ~/.config/opencode/context-mode/sessions."),
                field("Knowledge-base databases", textarea(loc.contentDirs.join("\n"), "auto — folders holding content/<hash>.db", (v) => { loc.contentDirs = lines(v); mark() }), "context-mode's FTS5 stores."),
            )),
        h("section.set-section", null,
            h("h2", null, "Privacy"),
            h("p", null, "Everything stays on this machine; the service only reads. These switches control what the panel shows, for example while sharing your screen. The eye button in the header toggles event text too."),
            h("div.set-grid", null,
                toggle("Show event text", draft.service.privacy.showContent, (v) => { draft.service.privacy.showContent = v; mark() }, "Prompts, errors, decisions, shell commands. Off shows counts only."),
                toggle("Shorten file paths", draft.service.privacy.redactPaths, (v) => { draft.service.privacy.redactPaths = v; mark() }, "Show only the last segment of file paths."))),
        h("section.set-section", null,
            h("h2", null, "Data"),
            h("div.set-grid", null,
                toggle("Hide test sessions", draft.service.filters.hideSynthetic, (v) => { draft.service.filters.hideSynthetic = v; mark() }, "Sessions whose id is not an OpenCode id (ses_…), such as context-mode's own test runs."),
                toggle("Include subagent sessions", d.subagents, (v) => { d.subagents = v; mark() }, "Subagents are separate OpenCode sessions with a parent."),
                field("Exclude projects matching", input(draft.service.filters.excludeProjects, "regular expression, e.g. /Temp/|/tmp/", (v) => { draft.service.filters.excludeProjects = v; mark() }), "Matched against the project folder with forward slashes, case-insensitive."),
                toggle("Show context-mode's estimate", d.showEstimates, (v) => { d.showEstimates = v; mark() }, "Its “tokens saved” figure, always hatched and labelled est."))),
        h("section.set-section", null,
            h("h2", null, "Display"),
            h("div.set-grid", null,
                field("Text size", select(d.scale, [[14, "Small (14 px)"], [15, "Default (15 px)"], [16, "Large (16 px)"], [17, "Larger (17 px)"], [18, "Largest (18 px)"]], (v) => { d.scale = v; mark() })),
                field("Refresh", select(d.refreshSec, [[0, "Manual only"], [3, "Every 3 seconds"], [5, "Every 5 seconds"], [10, "Every 10 seconds"], [30, "Every 30 seconds"], [60, "Every minute"]], (v) => { d.refreshSec = v; mark() })),
                field("Opens on", select(d.defaultView, [["sessions", "Sessions"], ["insights", "Insights"], ["runs", "Runs"], ["knowledge", "Knowledge"]], (v) => { d.defaultView = v; mark() })),
                field("Default range", select(d.defaultRange, (["today", "7d", "30d", "90d", "all"] as RangeKey[]).map((k) => [k, RANGE_LABELS[k]] as [RangeKey, string]), (v) => { d.defaultRange = v; mark() })),
                field("Items in ranked lists", select(d.topN, [[5, "5"], [8, "8"], [10, "10"], [15, "15"], [20, "20"], [30, "30"], [50, "50"]], (v) => { d.topN = v; mark() }), "Projects, files, errors, tools, skills, references, runs per session…"),
                field("Rows per page", select(d.pageSize, [[20, "20"], [40, "40"], [80, "80"], [150, "150"]], (v) => { d.pageSize = v; mark() }), "Sessions, runs and knowledge sources."),
                field("Timeline page", select(d.timelineSize, [[60, "60 events"], [120, "120 events"], [250, "250 events"], [500, "500 events"]], (v) => { d.timelineSize = v; mark() }), "Events loaded at a time in a session's timeline."),
                field("Session columns", columns, "The ledger always shows the session; a narrow panel keeps the first column and a one-line summary."))),
        h("section.set-section", null,
            h("h2", null, "About the numbers"),
            h("p", null, `Indexed ${full(status.totals.sessions)} sessions and ${full(status.totals.events)} events from ${full(status.progress.total)} databases; ${full(status.totals.runs)} runs; ${full(status.totals.knowledgeSources)} knowledge sources. Node ${disc.node}.`),
            h("dl.glossary", null, ...Object.entries(GLOSSARY).map(([k, v]) => h("div", null, h("dt", null, k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())), h("dd", null, v))))),
        h("div.save-bar", null, resetBtn, saveBtn),
    ))
    void dirty
}
