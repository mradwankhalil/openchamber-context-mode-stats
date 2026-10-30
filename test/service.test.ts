import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { discover } from "../service/discover.ts"
import { Engine, commandHead } from "../service/engine.ts"
import { indexSessionDb, mergeSession, parseUsage, promptSize, stepCount } from "../service/events.ts"
import { sourceKind } from "../service/knowledge.ts"
import { modelLabel } from "../service/opencode.ts"
import { RunStore, parseRunFile } from "../service/runs.ts"
import { DEFAULT_SERVICE_SETTINGS, normalizeFilter, normalizeSettings } from "../service/settings.ts"
import type { ServiceSettings } from "../service/types.ts"
import { projectName } from "../service/util.ts"
import { PROJECT_A, SES_CHILD, SES_MAIN, SES_OTHER, SES_TEST, makeFixture } from "./fixtures.ts"
import type { Fixture } from "./fixtures.ts"

let fx: Fixture
let settings: ServiceSettings
let engine: Engine

before(async () => {
    fx = makeFixture()
    settings = normalizeSettings({
        locations: { sessionDirs: [fx.sessionsDir], statsDirs: [fx.statsDir], contentDirs: [fx.contentDir], opencodeDb: fx.opencodeDb },
    })
    engine = new Engine()
    const ctx = engine.context(settings)
    await engine.events.refresh(ctx.sessionDirs)
})

after(() => fx.cleanup())

describe("parsing", () => {
    it("reads every agent_usage shape context-mode writes", () => {
        assert.deepEqual(parseUsage("tokens_in:10 tokens_out:2 cache_create:3 cache_read:400 cost_usd:0.5"), { tokensIn: 10, tokensOut: 2, cacheWrite: 3, cacheRead: 400, costUsd: 0.5 })
        assert.deepEqual(parseUsage("tokens_in:7 tokens_out:1 cost_usd:0.0"), { tokensIn: 7, tokensOut: 1, cacheWrite: 0, cacheRead: 0, costUsd: 0 })
        assert.equal(parseUsage("not usage"), null)
        assert.equal(promptSize({ tokensIn: 10, tokensOut: 99, cacheRead: 400, cacheWrite: 3, costUsd: 0 }), 413)
    })

    it("labels knowledge sources by kind", () => {
        assert.equal(sourceKind("execute:python"), "execute")
        assert.equal(sourceKind("batch:a,b"), "batch")
        assert.equal(sourceKind("Docs::https://x.dev"), "fetch")
        assert.equal(sourceKind("file:README.md"), "file")
        assert.equal(sourceKind("my notes"), "index")
    })

    it("names commands, models and projects", () => {
        assert.equal(commandHead("git status --short | head"), "git status")
        assert.equal(commandHead("C:\\bin\\node.exe --version"), "node")
        assert.equal(modelLabel('{"providerID":"a","modelID":"b"}'), "a/b")
        assert.equal(modelLabel("x/y"), "x/y")
        assert.equal(modelLabel(""), null)
        assert.equal(projectName("C:\\Users\\me\\.config\\openchamber\\chats\\2026-10-06\\session-d97f6da7-5ede"), "OpenChamber chat 2026-10-06 · d97f6d")
        assert.equal(projectName("/work/alpha/"), "alpha")
    })

    it("parses run files and rejects junk", () => {
        const r = parseRunFile("42", { session_start: 1, updated_at: 2, total_calls: 3, bytes_indexed: 4, bytes_sandboxed: 8, by_tool: { a: { calls: 3, bytes: 9 } } }, "/d")
        assert.ok(r)
        assert.equal(r.estTokensSaved, 3, "falls back to (indexed + sandboxed + cache) / 4")
        assert.equal(parseRunFile("1", "nope", "/d"), null)
        assert.equal(parseRunFile("1", {}, "/d"), null)
    })

    it("normalizes untrusted settings and filters", () => {
        const s = normalizeSettings({ locations: { sessionDirs: ["a", 3, ""] }, privacy: { showContent: "yes" } })
        assert.deepEqual(s.locations.sessionDirs, ["a"])
        assert.equal(s.privacy.showContent, DEFAULT_SERVICE_SETTINGS.privacy.showContent)
        assert.deepEqual(normalizeFilter({ from: "2026-13-99x", to: "2026-10-30", q: "  hi " }), { to: "2026-10-30", q: "hi", subagents: true })
    })
})

describe("discovery", () => {
    it("finds the OpenCode stores under a home folder with no environment", () => {
        const report = discover(DEFAULT_SERVICE_SETTINGS.locations, { home: fx.home, env: {}, platform: "win32" })
        const used = (k: string) => report.locations.filter((l) => l.kind === k && l.used).map((l) => l.path)
        assert.deepEqual(used("sessions"), [fx.sessionsDir])
        assert.deepEqual(used("stats"), [fx.statsDir])
        assert.deepEqual(used("content"), [fx.contentDir])
        assert.deepEqual(used("opencodeDb"), [fx.opencodeDb])
    })

    it("lets a data root replace auto-detection", () => {
        const root = path.join(fx.home, ".config", "opencode")
        const report = discover({ ...DEFAULT_SERVICE_SETTINGS.locations, dataRoot: root }, { home: fx.home, env: {}, platform: "linux" })
        const sessions = report.locations.filter((l) => l.kind === "sessions")
        assert.equal(sessions.length, 1)
        assert.equal(sessions[0].origin, "data-root")
        assert.equal(sessions[0].path, path.join(root, "context-mode", "sessions"))
    })

    it("reports a pinned folder that does not exist instead of failing", () => {
        const report = discover({ ...DEFAULT_SERVICE_SETTINGS.locations, statsDirs: ["~/missing"] }, { home: fx.home, env: {}, platform: "linux" })
        const stats = report.locations.filter((l) => l.kind === "stats")
        assert.equal(stats.length, 1)
        assert.equal(stats[0].exists, false)
        assert.equal(stats[0].used, false)
    })
})

describe("session index", () => {
    it("merges a session across DBs and de-duplicates its model steps", () => {
        const a = indexSessionDb(path.join(fx.sessionsDir, "aaaaaaaaaaaaaaaa.db")).find((s) => s.id === SES_MAIN)
        const b = indexSessionDb(path.join(fx.sessionsDir, "aaaaaaaaaaaaaaaa__wt1.db")).find((s) => s.id === SES_MAIN)
        assert.ok(a && b)
        const m = mergeSession([b, a])
        assert.equal(stepCount(m.steps), 4, "3 shared + 1 unique step")
        assert.equal(m.dbFile, a.dbFile, "home DB holds the ordinary events")
        assert.equal(m.types.user_prompt, 1)
        assert.equal(m.usage.peakContext, 120_150)
        assert.equal(m.usage.lastContext, 20_090, "latest step by time")
        assert.equal(m.compactions, 1)
    })

    it("skips files that are not session DBs", () => {
        const ids = engine.events.sessions().map((s) => s.id).sort()
        assert.deepEqual(ids, [SES_CHILD, SES_MAIN, SES_OTHER, SES_TEST].sort())
        assert.equal(engine.events.progress.phase, "ready")
    })
})

describe("engine", () => {
    it("summarises the filtered set", () => {
        const ctx = engine.context(settings)
        const o = engine.overview(ctx, {}, 10)
        assert.equal(o.sessions, 3, "synthetic test session hidden by default")
        assert.equal(o.subagentSessions, 1)
        assert.equal(o.usage.steps, 4 + 1 + 1)
        assert.equal(o.tally.prompts, 3)
        assert.equal(o.tally.errors, 1)
        assert.equal(o.tally.errorsResolved, 1)
        assert.equal(o.hourly.flat().reduce((a, b) => a + b, 0), o.tally.events, "every event lands in the weekday × hour grid")
        assert.ok(o.daily.length >= 11, "series spans from the first active day to today")
        assert.equal(o.runs.runs, 2)
    })

    it("applies range, project, search, subagent and exclusion filters", () => {
        const ctx = engine.context(settings)
        const today = new Date()
        const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
        assert.deepEqual(engine.filtered(ctx, { from: day, to: day }).map((r) => r.id).sort(), [SES_CHILD, SES_MAIN].sort())
        assert.deepEqual(engine.filtered(ctx, { q: "login" }).map((r) => r.id), [SES_MAIN])
        assert.deepEqual(engine.filtered(ctx, { project: PROJECT_A, subagents: false }).map((r) => r.id), [SES_MAIN])
        const excluding = engine.context(normalizeSettings({ ...settings, filters: { hideSynthetic: false, excludeProjects: "/work/beta" } }))
        assert.deepEqual(engine.filtered(excluding, {}).map((r) => r.id).sort(), [SES_CHILD, SES_MAIN, SES_TEST].sort())
    })

    it("joins OpenCode titles, models and subagent links", () => {
        const ctx = engine.context(settings)
        const page = engine.sessionsPage(ctx, {}, "steps", "desc", 0, 10)
        assert.equal(page.total, 3)
        const main = page.rows[0]
        assert.equal(main.id, SES_MAIN)
        assert.equal(main.title, "Fix login bug")
        assert.equal(main.model, "anthropic/claude-test")
        assert.equal(main.childCount, 1)
        assert.equal(page.rows.find((r) => r.id === SES_CHILD)?.parentId, SES_MAIN)
    })

    it("builds a session detail with a merged timeline and privacy switches", () => {
        const ctx = engine.context(settings)
        const d = engine.detail(ctx, SES_MAIN, { offset: 0, limit: 50, types: null, topN: 10 })
        assert.ok(d)
        assert.equal(d.timelineTotal, 9)
        assert.equal(d.usageSeries.length, 4)
        assert.equal(d.compactions.length, 1, "one resume snapshot")
        assert.ok(d.files[0].label.endsWith("login.ts"))
        assert.equal(d.files[0].count, 2)
        assert.deepEqual(d.refs.map((r) => r.label).sort(), ["#12", "#34"])
        assert.equal(d.children[0].id, SES_CHILD)
        assert.ok(d.knowledge && d.knowledge.sources === 4)
        assert.equal(d.prompts[0].text, "Please fix the login bug")

        const hidden = engine.context(normalizeSettings({ ...settings, privacy: { showContent: false, redactPaths: true } }))
        const h = engine.detail(hidden, SES_MAIN, { offset: 0, limit: 50, types: null, topN: 10 })
        assert.ok(h)
        assert.equal(h.prompts[0].text, null)
        assert.equal(h.errors.length, 0)
        assert.equal(h.files[0].label, "…/login.ts")
        assert.equal(h.timeline.find((e) => e.type === "file_read")?.text, "…/login.ts")

        const steps = engine.detail(ctx, SES_MAIN, { offset: 0, limit: 50, types: ["agent_usage"], topN: 10 })
        assert.equal(steps?.timelineTotal, 7, "raw step rows before de-duplication")
        assert.equal(steps?.timeline.length, 4, "duplicates removed from the list")
    })

    it("ranks insights and respects privacy", () => {
        const ctx = engine.context(settings)
        const ins = engine.insights(ctx, {}, 10)
        assert.equal(ins.files[0].count, 2)
        assert.equal(ins.commands[0].label, "npm test")
        assert.equal(ins.errors[0].label, "TypeError: x is undefined")
        assert.equal(ins.models.length, 2)
        const hidden = engine.context(normalizeSettings({ ...settings, privacy: { showContent: false, redactPaths: false } }))
        const h = engine.insights(hidden, { q: "login" }, 10)
        assert.equal(h.commands.length, 0)
        assert.equal(h.errors.length, 0)
        assert.equal(h.contentHidden, true)
    })

    it("reports runs, the live run and the knowledge base", () => {
        const ctx = engine.context(settings)
        const runs = engine.runsPayload(ctx, {}, 0, 10)
        assert.equal(runs.total, 2)
        assert.equal(runs.live?.pid, String(process.pid))
        assert.equal(runs.liveRuns.length, 1)
        assert.equal(runs.sandboxDominated, 2)
        const kb = engine.knowledgePayload(ctx, { project: PROJECT_A }, 0, 10, "chunks")
        assert.equal(kb.totals.sources, 4)
        assert.equal(kb.sources[0].label, "React docs::https://react.dev/learn")
        assert.deepEqual(kb.kinds.map((k) => k.label).sort(), ["batch", "execute", "fetch", "file"])
    })

    it("answers the Work Status brief for the open chat", () => {
        const ctx = engine.context(settings)
        const b = engine.brief(ctx, SES_MAIN, null)
        assert.equal(b.session?.id, SES_MAIN)
        assert.deepEqual(b.contextTrail, [10_600, 60_200, 120_150, 20_090])
        assert.equal(b.project?.sessions, 2)
        assert.equal(engine.brief(ctx, "ses_unknown", null).session, null)
    })
})

describe("runs", () => {
    it("remembers a run whose stats file another server overwrote", async () => {
        const fs = await import("node:fs")
        const store = new RunStore()
        const file = path.join(fx.statsDir, "stats-pid-777.json")
        const write = (start: number, calls: number) => fs.writeFileSync(file, JSON.stringify({ session_start: start, updated_at: Date.now(), total_calls: calls }))
        write(1000, 5)
        assert.equal(store.read([fx.statsDir]).filter((r) => r.pid === "777").length, 1)
        write(2000, 9)
        const seen = store.read([fx.statsDir]).filter((r) => r.pid === "777").map((r) => r.calls).sort()
        assert.deepEqual(seen, [5, 9])
        fs.rmSync(file)
    })
})
