/**
 * Runs: context-mode's MCP server processes. Measured byte counters first;
 * context-mode's own "tokens saved" estimate is shown hatched and explained.
 */

import type { RunSummary, RunsPayload, ToolStat } from "../../service/types.ts"
import type { App, ViewRenderer } from "../app.ts"
import { dailyColumns, rankBars, splitBar } from "../charts.ts"
import type { ColumnDatum } from "../charts.ts"
import { h, replace } from "../dom.ts"
import { bytes, count, dateTime, duration, full, plural } from "../format.ts"
import { filterOf } from "../state.ts"
import { card, info, pager, section, statement } from "../widgets.ts"

const expanded = new Set<string>()

function liveBlock(app: App, lives: RunSummary[]): HTMLElement {
    if (!lives.length) {
        return section("Running now", null, h("p.muted", null, "No context-mode MCP server is running for a live OpenCode process. Its counters appear here once a chat calls a context-mode tool."))
    }
    return h("div.section", null, ...lives.map((r, i) => liveOne(app, r, i, lives.length)),
        lives.length > 1 ? h("p.muted", { style: "margin:0;font-size:var(--fs-sm)" }, `${lives.length} context-mode servers share parent pid ${lives[0].pid}, so they write the same stats file and overwrite each other's numbers on disk. This panel remembers both while it runs.`) : null)
}

function liveOne(app: App, live: RunSummary, i: number, n: number): HTMLElement {
    const est = app.settings.display.showEstimates
    return section(n > 1 ? `Running now · server ${i + 1} of ${n}` : "Running now", h("span", null, `started ${dateTime(live.startedAt)} · up ${duration(live.uptimeMs)} · last call ${dateTime(live.updatedAt)}`),
        statement([
            ["Measured", [
                { value: full(live.calls), label: "tool calls", glossary: "calls" },
                { value: bytes(live.bytesReturned), label: "returned to context", glossary: "returned" },
                { value: bytes(live.bytesIndexed), label: "indexed", glossary: "indexed" },
                { value: bytes(live.bytesSandboxed), label: "read inside the sandbox", glossary: "sandboxed" },
                live.cacheHits > 0 && { value: full(live.cacheHits), label: `cache hits (${bytes(live.cacheBytesSaved)})` },
            ]],
            ["Estimate", [est && { value: count(live.estTokensSaved), label: "tokens “saved” by context-mode's formula", tone: "est", glossary: "estSaved" }]],
        ]),
        toolBars(live.tools))
}

function toolBars(tools: ToolStat[]): HTMLElement {
    return rankBars(tools.map((t) => ({
        label: t.name,
        value: t.calls,
        display: `${plural(t.calls, "call")} · ${bytes(t.bytes)}`,
        sub: t.calls ? `${bytes(t.bytes / t.calls)} returned per call` : undefined,
    })), { empty: "No tool calls yet.", mono: true })
}

function explainer(p: RunsPayload): HTMLElement {
    const a = p.aggregate
    const kept = a.bytesIndexed + a.bytesSandboxed + a.cacheBytesSaved
    return h("div.explain", null,
        h("h3", null, "What “tokens saved” really counts"),
        h("p", null, "context-mode computes ", h("code", null, "tokens_saved = (indexed + sandbox reads + cache) ÷ 4"), ". Sandbox reads are every byte a ctx_execute script reads from disk or the network, so a script that scans a 100 MB database to count rows adds 25M “saved” tokens even though the model would never have read that file."),
        h("p", null, `In this range ${full(p.sandboxDominated)} of ${full(p.total)} runs owe more than 90% of their estimate to sandbox reads, and sandbox reads are ${a.bytesSandboxed && kept ? Math.round((a.bytesSandboxed / kept) * 100) : 0}% of all kept-out bytes. The measured, comparable number is what came back into context: ${bytes(a.bytesReturned)}.`))
}

function runsLedger(app: App, p: RunsPayload): HTMLElement {
    const est = app.settings.display.showEstimates
    const body = h("tbody")
    for (const r of p.runs) {
        const tr = h("tr", { tabindex: 0, "aria-expanded": String(expanded.has(r.key)) },
            h("td.cell-main", null,
                h("div.row-title", null, dateTime(r.startedAt), r.alive ? h("span.badge.ok", { style: "margin-left:8px" }, "running") : null),
                h("div.row-sub", null, `pid ${r.pid}`, h("span", null, duration(r.uptimeMs)), r.version ? h("span", null, `v${r.version}`) : null),
                h("div.row-compact", null, `${full(r.calls)} calls · ${bytes(r.bytesReturned)} returned · ${bytes(r.bytesSandboxed)} sandbox reads`)),
            h("td", null, full(r.calls)),
            h("td.col-opt", null, bytes(r.bytesReturned)),
            h("td.col-opt", null, bytes(r.bytesIndexed)),
            h("td.col-opt", null, bytes(r.bytesSandboxed)),
            est ? h("td.col-opt", { style: "color:var(--est)" }, count(r.estTokensSaved)) : null)
        const toggle = () => {
            if (expanded.has(r.key)) expanded.delete(r.key)
            else expanded.add(r.key)
            app.refresh()
        }
        tr.addEventListener("click", toggle)
        tr.addEventListener("keydown", (e) => { if (e.key === "Enter") toggle() })
        body.appendChild(tr)
        if (expanded.has(r.key)) {
            body.appendChild(h("tr", null, h("td", { colspan: est ? 6 : 5, style: "text-align:left;white-space:normal;cursor:default" },
                h("div", { style: "max-width:640px;padding:4px 0 8px" }, toolBars(r.tools), h("p.muted", { style: "font-size:var(--fs-xs);margin:8px 0 0" }, `Stats file in ${r.sourceDir}`)))))
        }
    }
    return h("table.ledger", null,
        h("thead", null, h("tr", null,
            h("th", null, "Started"), h("th", null, "Calls"), h("th.col-opt", null, "Returned"), h("th.col-opt", null, "Indexed"),
            h("th.col-opt", null, "Sandbox reads"), est ? h("th.col-opt", null, "Est. “saved”") : null)),
        body)
}

export const renderRuns: ViewRenderer = async (app, el, isStale) => {
    const filter = filterOf(app.view, app.settings)
    const limit = app.settings.display.pageSize
    const p = await app.api<RunsPayload>("/v1/runs", { filter, offset: app.view.runsOffset, limit })
    if (isStale()) return
    const a = p.aggregate
    const est = app.settings.display.showEstimates
    const data: ColumnDatum[] = p.daily.map((d) => ({
        day: d.day,
        value: d.calls,
        detail: [["runs", full(d.runs)], ["calls", full(d.calls)], ["returned", bytes(d.bytesReturned)], ["indexed", bytes(d.bytesIndexed)], ["sandbox reads", bytes(d.bytesSandboxed)]],
    }))
    replace(el,
        liveBlock(app, p.liveRuns),
        section("All runs in range", h("span", null, `${plural(p.total, "run")} `, info("runs")),
            statement([
                ["Measured", [
                    { value: full(a.calls), label: "tool calls", glossary: "calls" },
                    { value: bytes(a.bytesReturned), label: "returned to context", glossary: "returned" },
                    { value: bytes(a.bytesIndexed), label: "indexed", glossary: "indexed" },
                    { value: bytes(a.bytesSandboxed), label: "sandbox reads", glossary: "sandboxed" },
                    a.cacheHits > 0 && { value: full(a.cacheHits), label: "cache hits" },
                ]],
                ["Estimate", [est && { value: count(a.estTokensSaved), label: "tokens “saved”", tone: "est", glossary: "estSaved" }]],
            ]),
            h("div.grid-2", null,
                card(h("div.section", null, h("div.section-head", null, h("h2", null, "Where the bytes went")),
                    splitBar([
                        { label: "Returned to context (measured)", value: a.bytesReturned, tone: "--t-returned" },
                        { label: "Indexed instead (measured)", value: a.bytesIndexed, tone: "--t-indexed" },
                        { label: "Read inside the sandbox (measured)", value: a.bytesSandboxed, tone: "--t-other", note: "context-mode counts these bytes as “saved”" },
                        { label: "Served from fetch cache", value: a.cacheBytesSaved, tone: "--t-cache" },
                    ], bytes))),
                card(h("div.section", null, h("div.section-head", null, h("h2", null, "Calls per day"), h("span.hint", null, "by run start")),
                    data.length ? dailyColumns(data, { height: 110 }) : h("p.muted", null, "No runs in range.")))),
            section("Calls by tool", "all runs in range", toolBars(a.tools)),
            explainer(p),
            runsLedger(app, p),
            p.total > limit ? pager(app.view.runsOffset, limit, p.total, (runsOffset) => app.go({ runsOffset }, { keepScroll: false })) : null),
    )
}
