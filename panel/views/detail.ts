/** One session: identity, measured totals, context curve, and everything context-mode captured. */

import type { RunSummary, SessionDetail, SessionRow, TimelineEvent } from "../../service/types.ts"
import type { App, ViewRenderer } from "../app.ts"
import { contextArea, rankBars } from "../charts.ts"
import type { AreaPoint } from "../charts.ts"
import { h, icon, iconButton, replace } from "../dom.ts"
import { ago, bytes, count, dateTime, duration, full, pct, plural, time, usd } from "../format.ts"
import { promptTokens, sessionTitle } from "./sessions.ts"
import { TIMELINE_FILTERS, card, section, statement, typeLabel, typeTone } from "../widgets.ts"

type Tab = "timeline" | "prompts" | "files" | "errors" | "decisions" | "subagents" | "context-mode"
let tab: Tab = "timeline"
const openTexts = new Set<number>()

function eventItem(e: TimelineEvent): HTMLElement {
    const text = e.text
    const body = text === null
        ? h("p.ev-text.hidden", null, "Hidden — event text is off in Settings → Privacy.")
        : text
            ? h("p.ev-text", { class: openTexts.has(e.id) ? "open" : "" }, text)
            : null
    const more = body && text && (text.length > 360 || text.split("\n").length > 5)
        ? h("button.link.ev-more", { type: "button" }, openTexts.has(e.id) ? "Show less" : "Show all")
        : null
    if (more && body) {
        more.addEventListener("click", () => {
            if (openTexts.has(e.id)) openTexts.delete(e.id)
            else openTexts.add(e.id)
            body.classList.toggle("open")
            more.textContent = body.classList.contains("open") ? "Show less" : "Show all"
        })
    }
    return h("li.ev", { style: `--tone:var(${typeTone(e.type)})` },
        h("span.ev-time", { title: dateTime(e.at) }, time(e.at)),
        h("span.ev-dot"),
        h("div.ev-body", null, h("div.ev-type", null, typeLabel(e.type), e.bytes ? ` · ${bytes(e.bytes)}` : ""), body, more))
}

function timeline(app: App, d: SessionDetail): HTMLElement {
    const v = app.view
    const chips = h("div.chips", { role: "group", "aria-label": "Event types" })
    const activeIds = new Set(TIMELINE_FILTERS.filter((f) => f.types.every((t) => v.timelineTypes.includes(t))).map((f) => f.id))
    for (const f of TIMELINE_FILTERS) {
        const n = f.types.reduce((a, t) => a + (d.row.types[t] ?? 0), 0)
        if (!n) continue
        const tone = typeTone(f.types[0])
        const chip = h("button.chip", { type: "button", "aria-pressed": String(activeIds.has(f.id)), style: `--tone:var(${tone})` }, h("i"), `${f.label} ${count(n)}`)
        chip.addEventListener("click", () => {
            const next = new Set(v.timelineTypes)
            if (activeIds.has(f.id)) f.types.forEach((t) => next.delete(t))
            else f.types.forEach((t) => next.add(t))
            app.go({ timelineTypes: [...next], timelineOffset: 0 }, { keepScroll: true })
        })
        chips.appendChild(chip)
    }
    const size = app.settings.display.timelineSize
    const shown = v.timelineOffset + d.timeline.length
    const more = shown < d.timelineTotal ? h("button.btn", { type: "button" }, `Show older (${full(d.timelineTotal - shown)} more)`) : null
    more?.addEventListener("click", () => app.go({ timelineOffset: v.timelineOffset + size }, { keepScroll: true }))
    const newer = v.timelineOffset > 0 ? h("button.btn", { type: "button" }, "Back to newest") : null
    newer?.addEventListener("click", () => app.go({ timelineOffset: 0 }, { keepScroll: true }))
    return h("div.section", null,
        chips,
        h("p.muted", { style: "margin:0;font-size:var(--fs-sm)" }, d.timelineTotal
            ? `Newest first · ${full(v.timelineOffset + 1)}–${full(shown)} of ${full(d.timelineTotal)} ${v.timelineTypes.length ? "matching events" : "events (model steps hidden unless chosen)"}`
            : "No events of these types."),
        h("ol.timeline", null, ...d.timeline.map(eventItem)),
        h("div.pager", null, newer ?? h("span"), more ?? h("span")))
}

function textList(items: TimelineEvent[], empty: string): HTMLElement {
    if (!items.length) return h("p.muted", null, empty)
    return h("div.qa", null, ...items.map((e) => h("div.qa-item", null,
        h("div.qa-meta", null, h("span.badge", { style: `color:var(${typeTone(e.type)})` }, typeLabel(e.type)), dateTime(e.at)),
        e.text === null ? h("p.ev-text.hidden", null, "Hidden — event text is off in Settings → Privacy.") : h("pre.quote", null, e.text || "(empty)"))))
}

function runsTable(runs: RunSummary[], showEst: boolean): HTMLElement {
    if (!runs.length) return h("p.muted", null, "No context-mode run overlapped this session.")
    return h("table.ledger", null,
        h("thead", null, h("tr", null, h("th", null, "Run"), h("th", null, "Calls"), h("th.col-opt", null, "Returned"), h("th.col-opt", null, "Indexed"), showEst ? h("th.col-opt", null, "Est. “saved”") : null)),
        h("tbody", null, ...runs.map((r) => h("tr", null,
            h("td.cell-main", null, h("div.row-title", null, `pid ${r.pid}`, r.alive ? h("span.badge.ok", { style: "margin-left:8px" }, "running") : null),
                h("div.row-sub", null, `${dateTime(r.startedAt)} · ${duration(r.uptimeMs)}`)),
            h("td", null, full(r.calls)),
            h("td.col-opt", null, bytes(r.bytesReturned)),
            h("td.col-opt", null, bytes(r.bytesIndexed)),
            showEst ? h("td.col-opt", { style: "color:var(--est)" }, count(r.estTokensSaved)) : null))))
}

function header(app: App, d: SessionDetail): HTMLElement {
    const r = d.row
    const back = h("button.link", { type: "button" }, icon("back", 14), " All sessions")
    back.addEventListener("click", () => app.go({ sessionId: null }))
    const copy = iconButton("copy", "Copy session id", () => app.copy(r.id, "Session id"))
    const parent = d.parent ? h("button.link", { type: "button" }, `parent: ${d.parent.title ?? d.parent.id}`) : null
    parent?.addEventListener("click", () => app.go({ sessionId: d.parent?.id ?? null, timelineOffset: 0, timelineTypes: [] }))
    const titleEl = sessionTitle(r)
    titleEl.className = r.title ? "detail-title" : "detail-title untitled"
    return h("div.detail-head", null,
        h("div.crumbs", null, back),
        titleEl,
        h("div.meta-line", null,
            app.current.sessionId === r.id ? h("span.badge.current", null, "this chat") : null,
            h("span.mono", null, r.id), copy,
            h("span", null, r.projectName),
            r.model ? h("span", null, r.model) : null,
            r.agent ? h("span", null, `agent ${r.agent}`) : null,
            parent),
        h("div.meta-line", null, `${dateTime(r.startedAt)} → ${dateTime(r.lastEventAt)} · span ${duration(r.activeMs)} · last activity ${ago(r.lastEventAt)}`),
        h("div.meta-line", { title: r.projectDir }, h("span.mono", { style: "color:var(--text-2)" }, r.projectDir)))
}

function totals(app: App, d: SessionDetail): HTMLElement {
    const r = d.row
    const read = promptTokens(r)
    const oc = d.opencode
    return statement([
        ["Conversation", [
            { value: full(r.tally.prompts), label: "prompts", glossary: "prompts" },
            { value: full(r.usage.steps), label: "model steps", glossary: "steps" },
            { value: full(r.tally.events - r.tally.steps), label: "events", glossary: "events" },
            r.childCount > 0 && { value: full(r.childCount), label: "subagents" },
        ]],
        ["Context", [
            { value: count(read), label: "tokens read", glossary: "tokensRead" },
            { value: count(r.usage.tokensOut), label: "generated", glossary: "tokensOut" },
            read > 0 && { value: pct(r.usage.cacheRead, read), label: "from cache", glossary: "cacheHit" },
            { value: count(r.usage.peakContext), label: "peak", glossary: "peak" },
            { value: count(r.usage.lastContext), label: "latest" },
            r.usage.costUsd > 0 && { value: usd(r.usage.costUsd), label: "reported cost" },
        ]],
        ["Signals", [
            { value: full(r.tally.errors), label: r.tally.errorsResolved ? `errors · ${full(r.tally.errorsResolved)} resolved` : "errors", tone: r.tally.errors ? "bad" : undefined, glossary: "errors" },
            { value: full(r.tally.retries), label: "retry loops", glossary: "retries" },
            { value: full(r.tally.compactions), label: "compactions", glossary: "compactions" },
            { value: full(r.resumes), label: "resume snapshots" },
        ]],
        ["Work", [
            { value: full(r.tally.fileReads), label: "file reads" },
            { value: full(r.tally.fileEdits + r.tally.fileWrites), label: "edits & writes" },
            { value: full(r.tally.fileSearches), label: "searches" },
            { value: full(r.tally.gitOps), label: r.tally.commits ? `git ops · ${r.tally.commits} commits` : "git ops" },
            { value: full(r.tally.skills), label: "skills" },
        ]],
        oc ? ["OpenCode", [
            { value: count(oc.tokensInput + oc.tokensCacheRead + oc.tokensCacheWrite), label: "prompt tokens (OpenCode)" },
            { value: count(oc.tokensOutput + oc.tokensReasoning), label: "output + reasoning" },
            oc.cost > 0 && { value: usd(oc.cost), label: "cost" },
            oc.summaryFiles != null && { value: full(oc.summaryFiles), label: `files changed (+${full(oc.summaryAdditions ?? 0)} −${full(oc.summaryDeletions ?? 0)})` },
        ]] : ["OpenCode", []],
    ])
}

function curve(d: SessionDetail): HTMLElement {
    const pts: AreaPoint[] = d.usageSeries.map((p) => ({
        at: p.at,
        value: p.context,
        detail: [["prompt tokens", count(p.context)], ["input", count(p.tokensIn)], ["cache read", count(p.cacheRead)], ["cache write", count(p.cacheWrite)], ["generated", count(p.tokensOut)]],
    }))
    const marks = [...d.compactions.map((at) => ({ at, kind: "compaction" as const })), ...d.contextDrops.map((at) => ({ at, kind: "drop" as const }))]
    return section("Context per model step",
        `${plural(d.row.usage.steps, "step")} · peak ${count(d.row.usage.peakContext)}`,
        card(contextArea(pts, marks),
            h("div.chart-legend", { style: "margin-top:8px" },
                h("span", null, h("i", { style: "border-color:var(--accent)" }), "prompt size (input + cache)"),
                d.compactions.length ? h("span", null, h("i", { style: "border-color:var(--t-compaction)" }), `compaction (${d.compactions.length})`) : null,
                d.contextDrops.length ? h("span", null, h("i", { style: "border-color:var(--text-2);border-top-style:dashed" }), `context halved (${d.contextDrops.length})`) : null)))
}

export const renderDetail: ViewRenderer = async (app, el, isStale) => {
    const v = app.view
    const d = await app.api<SessionDetail>("/v1/session", {
        id: v.sessionId,
        offset: v.timelineOffset,
        limit: app.settings.display.timelineSize,
        types: v.timelineTypes.length ? v.timelineTypes : null,
        topN: app.settings.display.topN,
    })
    if (isStale()) return
    const r = d.row
    const tabs: { id: Tab; label: string; n?: number }[] = [
        { id: "timeline", label: "Timeline", n: r.tally.events - r.tally.steps },
        { id: "prompts", label: "Prompts", n: r.tally.prompts },
        { id: "files", label: "Files", n: d.files.length },
        { id: "errors", label: "Errors", n: r.tally.errors },
        { id: "decisions", label: "Decisions", n: r.tally.decisions + r.tally.blockers + r.tally.constraints },
        ...(d.children.length ? [{ id: "subagents" as Tab, label: "Subagents", n: d.children.length }] : []),
        { id: "context-mode", label: "context-mode", n: d.runs.length },
    ]
    if (!tabs.some((t) => t.id === tab)) tab = "timeline"
    const bar = h("div.subtabs", { role: "tablist" })
    const body = h("div")
    const paint = () => {
        bar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === tab)))
        replace(body, tabBody(app, d))
    }
    for (const t of tabs) {
        const b = h("button", { type: "button", role: "tab", "data-id": t.id }, t.label, t.n !== undefined ? h("span.count", null, count(t.n)) : null)
        b.addEventListener("click", () => {
            tab = t.id
            paint()
        })
        bar.appendChild(b)
    }
    paint()
    replace(el, header(app, d), totals(app, d), curve(d), h("section.section", null, bar, body))
}

function tabBody(app: App, d: SessionDetail): HTMLElement {
    const topN = app.settings.display.topN
    switch (tab) {
        case "timeline": return timeline(app, d)
        case "prompts": return textList(d.prompts, "No prompts recorded.")
        case "files": return rankBars(d.files.map((f) => ({ label: f.label, value: f.count, sub: f.hint, title: f.label })), { empty: "No file reads or edits with a path were recorded.", mono: true })
        case "errors":
            if (!app.settings.service.privacy.showContent) return h("p.muted", null, `${full(d.row.tally.errors)} errors. Error text is hidden by Settings → Privacy.`)
            return rankBars(d.errors.map((e) => ({ label: e.label.split(/\r?\n/)[0] || "(empty)", value: e.count, title: e.label })), { empty: "No tool errors recorded." })
        case "decisions": return textList(d.decisions, "No decisions, blockers or constraints recorded.")
        case "subagents": return subagents(app, d.children)
        case "context-mode": return h("div.grid-2", null,
            section("Runs during this session", null, runsTable(d.runs, app.settings.display.showEstimates)),
            h("div.section", null,
                section("Knowledge base for this project", null, d.knowledge
                    ? h("dl.kv", null,
                        h("dt", null, "Sources"), h("dd", null, full(d.knowledge.sources)),
                        h("dt", null, "Chunks"), h("dd", null, `${full(d.knowledge.chunks)} (${full(d.knowledge.codeChunks)} code)`),
                        h("dt", null, "Size"), h("dd", null, bytes(d.knowledge.bytes)),
                        h("dt", null, "Last indexed"), h("dd", null, ago(d.knowledge.newestAt)))
                    : h("p.muted", null, "No knowledge-base database for this project.")),
                section("Resume snapshots", null, d.resumes.length
                    ? h("div.qa", null, ...d.resumes.map((s) => h("div.qa-item", null,
                        h("div.qa-meta", null, dateTime(s.at), `· ${full(s.events)} events · ${bytes(s.bytes)}`, s.consumed ? h("span.badge.ok", null, "used") : h("span.badge", null, "unused")),
                        s.sections.length ? rankBars(s.sections.slice(0, topN).map((x) => ({ label: x.label, value: x.count }))) : null)))
                    : h("p.muted", null, "context-mode built no resume snapshot for this session."))))
    }
}

function subagents(app: App, rows: SessionRow[]): HTMLElement {
    return h("div.qa", null, ...rows.map((r) => {
        const b = h("button.link", { type: "button" }, r.title ?? r.id)
        b.addEventListener("click", () => app.go({ sessionId: r.id, timelineOffset: 0, timelineTypes: [] }))
        return h("div.qa-item", null, b, h("div.qa-meta", null, `${r.agent ?? "agent"} · ${full(r.usage.steps)} steps · ${count(promptTokens(r))} tokens · ${duration(r.activeMs)}`))
    }))
}
