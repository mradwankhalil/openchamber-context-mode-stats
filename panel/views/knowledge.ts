/** Knowledge base: what context-mode indexed instead of pasting into context. */

import type { KnowledgePayload } from "../../service/types.ts"
import type { ViewRenderer } from "../app.ts"
import { dailyColumns, rankBars, splitBar } from "../charts.ts"
import { h, replace } from "../dom.ts"
import { ago, bytes, count, dateTime, full } from "../format.ts"
import { filterOf } from "../state.ts"
import { card, info, pager, section, statement } from "../widgets.ts"

const KIND_TONE: Record<string, string> = {
    execute: "--t-steps", batch: "--t-files", file: "--t-prompts", fetch: "--t-refs", search: "--t-skills", session: "--t-compaction", index: "--t-git",
}
const KIND_LABEL: Record<string, string> = {
    execute: "ctx_execute output", batch: "ctx_batch_execute output", file: "files", fetch: "fetched pages", search: "searches", session: "session events", index: "ctx_index",
}

export const renderKnowledge: ViewRenderer = async (app, el, isStale) => {
    const filter = filterOf(app.view, app.settings)
    const limit = app.settings.display.pageSize
    const p = await app.api<KnowledgePayload>("/v1/knowledge", { filter, offset: app.view.kbOffset, limit, sort: app.view.kbSort })
    if (isStale()) return
    const t = p.totals
    const sortSeg = h("div.seg.small", { role: "group", "aria-label": "Sort sources" })
    for (const [id, label] of [["recent", "Newest"], ["chunks", "Most chunks"]] as const) {
        const b = h("button", { type: "button", "aria-pressed": String(app.view.kbSort === id) }, label)
        b.addEventListener("click", () => app.go({ kbSort: id, kbOffset: 0 }, { keepScroll: true }))
        sortSeg.appendChild(b)
    }
    const sources = h("table.ledger", null,
        h("thead", null, h("tr", null, h("th", null, "Source"), h("th", null, "Chunks"), h("th.col-opt", null, "Code"), h("th.col-opt", null, "Indexed"))),
        h("tbody", null, ...p.sources.map((s) => h("tr", { style: "cursor:default" },
            h("td.cell-main", null,
                h("div.row-title", { style: "font-size:var(--fs-sm)" }, s.label),
                h("div.row-sub", null, h("span.badge", { style: `color:var(${KIND_TONE[s.kind] ?? "--t-other"})` }, KIND_LABEL[s.kind] ?? s.kind), s.filePath ? h("span.mono", null, s.filePath) : null),
                h("div.row-compact", null, `${full(s.chunks)} chunks · ${ago(s.indexedAt)}`)),
            h("td", null, full(s.chunks)),
            h("td.col-opt", null, full(s.codeChunks)),
            h("td.col-opt", null, dateTime(s.indexedAt))))))
    replace(el,
        section("Knowledge base", h("span", null, "all projects unless a project is chosen ", info("knowledge")), statement([
            ["Stored", [
                { value: full(t.dbs), label: t.dbs === 1 ? "database" : "databases" },
                { value: bytes(t.bytes), label: "on disk" },
                { value: full(t.sources), label: "sources" },
                { value: full(t.chunks), label: `chunks (${full(t.codeChunks)} code)` },
            ]],
            ["In range", [
                { value: full(p.sourcesTotal), label: "sources indexed" },
                { value: full(p.kinds.reduce((a, k) => a + (k.value ?? 0), 0)), label: "chunks" },
            ]],
        ])),
        h("div.grid-2", null,
            card(h("div.section", null, h("div.section-head", null, h("h2", null, "What was indexed"), h("span.hint", null, "sources by kind")),
                p.kinds.length
                    ? splitBar(p.kinds.map((k) => ({ label: KIND_LABEL[k.label] ?? k.label, value: k.count, tone: KIND_TONE[k.label] ?? "--t-other", note: `${count(k.value ?? 0)} chunks` })))
                    : h("p.muted", null, "Nothing indexed in this range."))),
            card(h("div.section", null, h("div.section-head", null, h("h2", null, "Indexed per day")),
                p.daily.length
                    ? dailyColumns(p.daily.map((d) => ({ day: d.day, value: d.sources, detail: [["sources", full(d.sources)], ["chunks", full(d.chunks)]] })), { height: 110 })
                    : h("p.muted", null, "Nothing indexed in this range.")))),
        section("Databases", "one per project", rankBars(p.dbs.map((d) => ({
            label: d.projectDir ? d.projectDir.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") : d.hash,
            value: d.bytes,
            display: bytes(d.bytes),
            sub: `${full(d.sources)} sources · ${full(d.chunks)} chunks · last ${ago(d.newestAt)} · in ${d.dir.replace(/\\/g, "/").split("/").filter(Boolean).slice(-4, -2).join("/")}`,
            title: d.file,
        })), { empty: "No knowledge-base databases found. Check Settings → Locations." })),
        section("Sources", sortSeg, p.sourcesTotal ? sources : h("p.muted", null, app.view.q ? `No source matches “${app.view.q}”.` : "No sources in this range."),
            p.sourcesTotal > limit ? pager(app.view.kbOffset, limit, p.sourcesTotal, (kbOffset) => app.go({ kbOffset }, { keepScroll: false })) : null),
    )
}
