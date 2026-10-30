/** Sessions: a statement of the filtered set, daily activity, and the sortable ledger. */

import type { DayBucket, OverviewPayload, SessionRow, SessionsPayload } from "../../service/types.ts"
import type { App, ViewRenderer } from "../app.ts"
import { dailyColumns } from "../charts.ts"
import type { ColumnDatum } from "../charts.ts"
import { h, icon, replace } from "../dom.ts"
import { ago, bytes, count, duration, full, pct, plural, shortId, usd } from "../format.ts"
import { SESSION_COLUMNS, filterOf } from "../state.ts"
import type { ColumnId } from "../state.ts"
import { card, info, pager, section, statement } from "../widgets.ts"

type Metric = "tokens" | "steps" | "prompts" | "events" | "errors" | "calls"
let metric: Metric = "tokens"

const METRICS: { id: Metric; label: string; value: (d: DayBucket) => number }[] = [
    { id: "tokens", label: "Tokens read", value: (d) => d.tokensIn + d.cacheRead + d.cacheWrite },
    { id: "steps", label: "Model steps", value: (d) => d.steps },
    { id: "prompts", label: "Prompts", value: (d) => d.prompts },
    { id: "events", label: "Events", value: (d) => d.events },
    { id: "errors", label: "Errors", value: (d) => d.errors },
    { id: "calls", label: "context-mode calls", value: (d) => d.toolCalls },
]

export const promptTokens = (r: { usage: { tokensIn: number; cacheRead: number; cacheWrite: number } }) => r.usage.tokensIn + r.usage.cacheRead + r.usage.cacheWrite

export function summaryStatement(o: OverviewPayload, showEstimates: boolean): HTMLElement {
    const read = o.usage.tokensIn + o.usage.cacheRead + o.usage.cacheWrite
    const t = o.tally
    return statement([
        ["Activity", [
            { value: full(o.sessions), label: o.subagentSessions ? `sessions (${full(o.subagentSessions)} subagents)` : "sessions", glossary: "sessions" },
            { value: full(o.projects), label: o.projects === 1 ? "project" : "projects" },
            { value: full(t.prompts), label: "prompts", glossary: "prompts" },
            { value: full(o.usage.steps), label: "model steps", glossary: "steps" },
        ]],
        ["Context", [
            { value: count(read), label: "tokens read", glossary: "tokensRead" },
            { value: count(o.usage.tokensOut), label: "generated", glossary: "tokensOut" },
            read > 0 && { value: pct(o.usage.cacheRead, read), label: "from cache", glossary: "cacheHit" },
            o.usage.peakContext > 0 && { value: count(o.usage.peakContext), label: "peak context", glossary: "peak" },
            o.usage.costUsd > 0 && { value: usd(o.usage.costUsd), label: "reported cost" },
        ]],
        ["Signals", [
            { value: full(t.errors), label: t.errorsResolved ? `errors · ${full(t.errorsResolved)} resolved` : "errors", tone: t.errors ? "bad" : undefined, glossary: "errors" },
            { value: full(t.retries), label: "retry loops", glossary: "retries" },
            { value: full(t.decisions + t.blockers + t.constraints), label: "decisions & constraints", glossary: "decisions" },
            { value: full(t.compactions), label: "compactions", glossary: "compactions" },
        ]],
        ["context-mode", [
            { value: full(o.runs.calls), label: `tool calls in ${plural(o.runs.runs, "run")}`, glossary: "calls" },
            { value: bytes(o.runs.bytesReturned), label: "returned to context", glossary: "returned" },
            { value: bytes(o.runs.bytesIndexed), label: "indexed", glossary: "indexed" },
            showEstimates && o.runs.estTokensSaved > 0 && { value: count(o.runs.estTokensSaved), label: "tokens “saved”", tone: "est", glossary: "estSaved" },
        ]],
    ])
}

function activityChart(app: App, o: OverviewPayload, holder: HTMLElement): void {
    const m = METRICS.find((x) => x.id === metric) ?? METRICS[0]
    const data: ColumnDatum[] = o.daily.map((d) => ({
        day: d.day,
        value: m.value(d),
        detail: [
            ["sessions", full(d.sessions)],
            ["prompts", full(d.prompts)],
            ["model steps", full(d.steps)],
            ["tokens read", count(d.tokensIn + d.cacheRead + d.cacheWrite)],
            ["generated", count(d.tokensOut)],
            ["events", full(d.events)],
            ["errors", full(d.errors)],
            ["context-mode calls", full(d.toolCalls)],
            ["returned to context", bytes(d.bytesReturned)],
        ],
    }))
    const seg = h("div.seg.small", { role: "group", "aria-label": "Chart metric" })
    for (const x of METRICS) {
        const b = h("button", { type: "button", "aria-pressed": String(x.id === metric) }, x.label)
        b.addEventListener("click", () => {
            metric = x.id
            activityChart(app, o, holder)
        })
        seg.appendChild(b)
    }
    replace(holder,
        h("div.section-head", null, h("h2", null, "Daily activity"), seg),
        card(dailyColumns(data, {
            unit: count,
            onPick: (day) => app.go({ range: "custom", customFrom: day, customTo: day, offset: 0 }),
        })),
        h("p.muted", { style: "margin:0;font-size:var(--fs-xs)" }, "Click a day to narrow every view to it."))
}

export function sessionTitle(r: SessionRow): HTMLElement {
    return r.title ? h("div.row-title", null, r.title) : h("div.row-title.untitled", null, `Untitled · ${shortId(r.id)}`)
}

function cell(r: SessionRow, c: ColumnId): { text: string; cls?: string } {
    switch (c) {
        case "last": return { text: ago(r.lastEventAt) }
        case "span": return { text: duration(r.activeMs) }
        case "prompts": return { text: full(r.tally.prompts) }
        case "events": return { text: full(r.tally.events - r.tally.steps) }
        case "steps": return { text: full(r.usage.steps) }
        case "tokens": return { text: count(promptTokens(r) + r.usage.tokensOut) }
        case "peak": return { text: r.usage.peakContext ? count(r.usage.peakContext) : "–" }
        case "errors": return { text: full(r.tally.errors), cls: r.tally.errors ? "cell-bad" : undefined }
        case "compactions": return { text: full(r.tally.compactions) }
        case "cost": return { text: r.usage.costUsd ? usd(r.usage.costUsd) : "–" }
    }
}

export function sessionLedger(app: App, page: SessionsPayload, opts: { sortable?: boolean } = {}): HTMLElement {
    const cols = app.settings.display.columns
    const v = app.view
    const head = h("tr", null, h("th", { scope: "col" }, sortButton(app, "title", "Session", opts.sortable !== false)))
    cols.forEach((c, i) => {
        const label = SESSION_COLUMNS.find((x) => x.id === c)?.label ?? c
        const th = h("th", { scope: "col", class: i >= 1 ? "col-opt" : "" }, sortButton(app, c, label, opts.sortable !== false))
        if (v.sort === c) th.setAttribute("aria-sort", v.dir === "asc" ? "ascending" : "descending")
        head.appendChild(th)
    })
    const body = h("tbody")
    for (const r of page.rows) {
        const isCurrent = app.current.sessionId === r.id
        const tr = h("tr", { tabindex: 0 },
            h("td.cell-main", null,
                sessionTitle(r),
                h("div.row-sub", null,
                    isCurrent ? h("span.badge.current", null, "this chat") : null,
                    h("span", null, r.projectName),
                    r.parentId ? h("span.badge", null, "subagent") : null,
                    r.childCount ? h("span.badge", null, `${r.childCount} subagent${r.childCount === 1 ? "" : "s"}`) : null,
                    r.model ? h("span", null, r.model) : null),
                h("div.row-compact", null, `${ago(r.lastEventAt)} · ${full(r.tally.prompts)} prompts · ${full(r.usage.steps)} steps · ${count(promptTokens(r))} tokens${r.tally.errors ? ` · ${r.tally.errors} errors` : ""}`)),
            ...cols.map((c, i) => {
                const x = cell(r, c)
                return h("td", { class: `${i >= 1 ? "col-opt" : ""} ${x.cls ?? ""}`.trim() }, x.text)
            }))
        const open = () => app.go({ sessionId: r.id, timelineOffset: 0, timelineTypes: [] })
        tr.addEventListener("click", open)
        tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open() })
        body.appendChild(tr)
    }
    return h("table.ledger", null, h("thead", null, head), body)
}

function sortButton(app: App, key: string, label: string, sortable: boolean): HTMLElement | string {
    if (!sortable) return label
    const v = app.view
    const active = v.sort === key
    const b = h("button.sort", { type: "button", title: `Sort by ${label.toLowerCase()}` }, label, active ? icon(v.dir === "asc" ? "up" : "down", 14) : null)
    b.addEventListener("click", () => app.go({ sort: key, dir: active && v.dir === "desc" ? "asc" : "desc", offset: 0 }, { keepScroll: true }))
    return b
}

export const renderSessions: ViewRenderer = async (app, el, isStale) => {
    const filter = filterOf(app.view, app.settings)
    const d = app.settings.display
    const [o, page] = await Promise.all([
        app.api<OverviewPayload>("/v1/overview", { filter, topN: d.topN }),
        app.api<SessionsPayload>("/v1/sessions", { filter, sort: app.view.sort, dir: app.view.dir, offset: app.view.offset, limit: d.pageSize }),
    ])
    if (isStale()) return
    const chart = h("section.section")
    activityChart(app, o, chart)
    const ledger = page.total
        ? h("div", null, sessionLedger(app, page))
        : h("p.muted", null, app.view.q ? `No session matches “${app.view.q}” in this range.` : "No sessions in this range. Widen the range or check Settings → Locations.")
    replace(el,
        section("Summary", o.range.from ? `${o.range.from === o.range.to ? o.range.from : `${o.range.from} → ${o.range.to}`}` : null, summaryStatement(o, d.showEstimates)),
        chart,
        section(
            "Sessions",
            h("span", null, `${full(page.total)} in range · whole-session totals `, info("sessions")),
            ledger,
            page.total > d.pageSize ? pager(page.offset, d.pageSize, page.total, (offset) => app.go({ offset }, { keepScroll: false })) : null,
        ),
    )
}
