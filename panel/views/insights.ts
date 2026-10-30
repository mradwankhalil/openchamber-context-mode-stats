/** Insights: when you work, what happened, where, with what — ranked across the filtered sessions. */

import type { InsightsPayload, OverviewPayload } from "../../service/types.ts"
import type { ViewRenderer } from "../app.ts"
import { rankBars, splitBar, weekHeatmap } from "../charts.ts"
import { h, replace } from "../dom.ts"
import { ago, count, full } from "../format.ts"
import { filterOf } from "../state.ts"
import { GROUP_TONE, card, section } from "../widgets.ts"

export const renderInsights: ViewRenderer = async (app, el, isStale) => {
    const filter = filterOf(app.view, app.settings)
    const topN = app.settings.display.topN
    const [o, ins] = await Promise.all([
        app.api<OverviewPayload>("/v1/overview", { filter, topN }),
        app.api<InsightsPayload>("/v1/insights", { filter, topN }),
    ])
    if (isStale()) return
    const hidden = ins.contentHidden ? "Hidden by Settings → Privacy." : undefined
    const totalHeat = o.hourly.flat().reduce((a, b) => a + b, 0)
    replace(el,
        h("div.grid-2", null,
            section("When you work", `${count(totalHeat)} events and steps, local time`, card(weekHeatmap(o.hourly, "events + steps"))),
            section("What happened", `${count(o.categories.reduce((a, c) => a + c.count, 0))} events`,
                card(splitBar(o.categories.map((c) => ({ label: c.label, value: c.count, tone: GROUP_TONE[c.label] ?? "--t-other" })))))),
        h("div.grid-3", null,
            section("Projects", `${full(o.projects)} in range`, rankBars(o.projectsTop.map((p) => ({
                label: p.name,
                value: p.events + p.steps,
                display: `${count(p.events)} ev · ${count(p.steps)} steps`,
                sub: `${full(p.sessions)} sessions · ${count(p.tokens)} tokens · ${ago(p.lastEventAt)}`,
                title: p.dir,
                onClick: () => app.go({ project: p.dir, view: "sessions", offset: 0 }),
            })))),
            section("Heaviest sessions", "by tokens read", rankBars(o.heaviest.map((r) => ({
                label: r.title ?? r.id,
                value: r.usage.tokensIn + r.usage.cacheRead + r.usage.cacheWrite,
                sub: `${r.projectName} · ${full(r.usage.steps)} steps · peak ${count(r.usage.peakContext)}`,
                onClick: () => app.go({ view: "sessions", sessionId: r.id, timelineOffset: 0, timelineTypes: [] }),
            })))),
            section("Models", "by model steps", rankBars(ins.models.map((m) => ({ label: m.label, value: m.count })), { empty: "No model names (needs OpenCode's database)." })),
            section("Files touched most", "reads, edits and writes", rankBars(ins.files.map((f) => ({ label: f.label, value: f.count, title: f.label })), { empty: "No file events with a path in this range.", mono: true })),
            section("Shell commands", "by command", rankBars(ins.commands.map((c) => ({ label: c.label, value: c.count })), { empty: hidden ?? "No shell commands recorded.", mono: true })),
            section("Recurring errors", "first line", rankBars(ins.errors.map((e) => ({ label: e.label, value: e.count, title: e.label })), { empty: hidden ?? "No tool errors in this range." })),
            section("Skills", null, rankBars(ins.skills.map((s) => ({ label: s.label, value: s.count })), { empty: "No skills loaded in this range." })),
            section("References", "issues, PRs, links", rankBars(ins.refs.map((r) => ({ label: r.label, value: r.count })), { empty: "No references captured." })),
            section("Retry loops", null, rankBars(ins.retries.map((r) => ({ label: r.label, value: r.count })), { empty: "No retry loops detected." })),
            section("Intent", "how sessions were classified", rankBars(ins.intents.map((r) => ({ label: r.label, value: r.count })), { empty: "No intent recorded." })),
            ins.agents.length ? section("Agents", "sessions per agent", rankBars(ins.agents.map((r) => ({ label: r.label, value: r.count })))) : null,
        ),
    )
}
