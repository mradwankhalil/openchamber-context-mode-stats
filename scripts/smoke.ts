/**
 * Smoke test against the real stores on this machine (read-only).
 *
 *   node scripts/smoke.ts            # auto-discovered locations
 *   node scripts/smoke.ts --json     # dump payload sizes as JSON
 *
 * Exits non-zero when a route throws or returns an invalid shape.
 */

import { Engine } from "../service/engine.ts"
import { DEFAULT_SERVICE_SETTINGS } from "../service/settings.ts"

const engine = new Engine()
const settings = structuredClone(DEFAULT_SERVICE_SETTINGS)
const failures: string[] = []
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failures.push(`${name}${detail ? ": " + detail : ""}`)
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
}
const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
    const t = performance.now()
    const v = await fn()
    console.log(`     ${label}: ${(performance.now() - t).toFixed(0)} ms, ${((JSON.stringify(v) ?? "").length / 1024).toFixed(1)} KB`)
    return v
}

const ctx = engine.context(settings)
console.log("node", process.versions.node, "sqlite", JSON.stringify(ctx.report.sqlite))
for (const l of ctx.report.locations) {
    console.log(`  ${l.used ? "USED" : "    "} ${l.kind.padEnd(10)} ${l.origin.padEnd(9)} files=${String(l.files).padStart(5)} ${(l.bytes / 1e6).toFixed(1).padStart(8)} MB  ${l.path}`)
}
check("sqlite available", ctx.report.sqlite.available, ctx.report.sqlite.error)
check("session dirs found", ctx.sessionDirs.length > 0, ctx.sessionDirs.join(", "))

await time("initial index", () => engine.events.refresh(ctx.sessionDirs))
check("index ready", engine.events.progress.phase === "ready", JSON.stringify(engine.events.progress))
const status = await time("status", () => engine.status(ctx))
console.log("     totals", JSON.stringify(status.totals), "live", status.live?.pid ?? "none")
await time("incremental refresh", () => engine.events.refresh(ctx.sessionDirs))

const overview = await time("overview all-time", () => engine.overview(ctx, {}, 10))
check("overview sessions", overview.sessions > 0, `${overview.sessions} sessions, ${overview.tally.events} events, ${overview.usage.steps} steps, ${overview.daily.length} days`)
const today = new Date()
const from = new Date(today.getTime() - 6 * 86_400_000)
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const week = await time("overview 7d", () => engine.overview(ctx, { from: day(from), to: day(today) }, 10))
check("7d series length", week.daily.length === 7, String(week.daily.length))

const page = await time("sessions page", () => engine.sessionsPage(ctx, {}, "tokens", "desc", 0, 50))
check("sessions page", page.rows.length > 0, `${page.total} total; top: ${page.rows[0]?.title ?? page.rows[0]?.id}`)
const titled = page.rows.filter((r) => r.title).length
console.log(`     titled rows: ${titled}/${page.rows.length}`)

const top = page.rows[0]
if (top) {
    const detail = await time("session detail", () => engine.detail(ctx, top.id, { offset: 0, limit: 150, types: null, topN: 10 }))
    check("detail", !!detail && detail.timeline.length > 0, detail ? `${detail.timelineTotal} events, ${detail.usageSeries.length} points, ${detail.compactions.length} compactions` : "null")
    const brief = await time("brief", () => engine.brief(ctx, top.id, null))
    check("brief", !!brief.session, `${brief.contextTrail.length} trail points`)
}
const insights = await time("insights all-time", () => engine.insights(ctx, {}, 10))
check("insights", insights.files.length > 0 || insights.skills.length > 0, `files ${insights.files.length}, errors ${insights.errors.length}, refs ${insights.refs.length}`)
await time("insights cached", () => engine.insights(ctx, {}, 10))
const runs = await time("runs", () => engine.runsPayload(ctx, {}, 0, 50))
check("runs", runs.total > 0, `${runs.total} runs, live ${runs.live?.pid ?? "none"}, sandbox-dominated ${runs.sandboxDominated}`)
const kb = await time("knowledge", () => engine.knowledgePayload(ctx, {}, 0, 50, "recent"))
check("knowledge", kb.totals.dbs > 0, `${kb.totals.dbs} dbs, ${kb.totals.sources} sources, ${kb.totals.chunks} chunks`)

if (engine.events.errors().length) console.log("     db errors:", JSON.stringify(engine.events.errors().slice(0, 3)))
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
