/**
 * The query engine: owns the stores, resolves locations from settings, and
 * answers each panel request from the in-memory index (plus targeted SQL for
 * per-session detail and ranked insights).
 */

import * as path from "node:path"
import { discover, usedPaths } from "./discover.ts"
import { EventIndex, addTypes, emptyTally, emptyUsage, mergeUsage, promptSize, stepAt, stepCount, typeGroup } from "./events.ts"
import type { SessionAgg } from "./events.ts"
import { KnowledgeStore } from "./knowledge.ts"
import type { KnowledgeDb } from "./knowledge.ts"
import { OpencodeStore } from "./opencode.ts"
import type { OcSession } from "./opencode.ts"
import { RunStore, aggregateRuns, liveRuns, pickLive } from "./runs.ts"
import { excludeMatcher } from "./settings.ts"
import { int, sqliteTime, str, tableNames, withDb } from "./sqlite.ts"
import type {
    BriefPayload, DayBucket, DiscoveryReport, EventTally, InsightsPayload, KnowledgePayload, OverviewPayload,
    ProjectSummary, QueryFilter, RankedItem, ResumeSnapshot, RunSummary, RunsPayload, ServiceSettings, SessionDetail,
    SessionRow, SessionsPayload, StatusPayload, TimelineEvent, Usage, UsagePoint,
} from "./types.ts"
import { dayKey, dayStart, daysBetween, inDayRange, projectName, rangeMs, redactPath, sqliteUtc } from "./util.ts"

/** Event types whose text is the user's or the model's words. Hidden when content is off. */
const SENSITIVE = new Set([
    "user_prompt", "data", "role", "decision", "blocker", "blocker_resolved", "error_tool", "error_resolved",
    "constraint_discovered", "env", "cwd", "bash_outcome", "rule_content", "compaction_summary", "retry_detected", "git_commit",
])
const PATH_TYPES = new Set(["file_read", "file_write", "file_edit", "file_search", "file_glob", "rule", "cwd"])

const SESSION_SORTS = new Set(["last", "started", "events", "steps", "tokens", "peak", "errors", "prompts", "span", "cost", "compactions", "title"])

export interface Ctx {
    settings: ServiceSettings
    report: DiscoveryReport
    sessionDirs: string[]
    statsDirs: string[]
    contentDirs: string[]
    opencodeDb: string | null
}

export function normDir(p: string): string {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "")
    return process.platform === "win32" || /^[a-z]:\//i.test(s) ? s.toLowerCase() : s
}

const sumPrompt = (u: Usage): number => u.tokensIn + u.cacheRead + u.cacheWrite

export class Engine {
    readonly events = new EventIndex()
    readonly runs = new RunStore()
    readonly knowledge = new KnowledgeStore()
    readonly opencode = new OpencodeStore()
    private discoveryCache: { key: string; at: number; report: DiscoveryReport } | null = null
    private rowCache: { key: string; rows: SessionRow[]; byId: Map<string, SessionRow> } | null = null
    private insightCache = new Map<string, { at: number; payload: InsightsPayload }>()

    // ----------------------------------------------------------- context

    context(settings: ServiceSettings): Ctx {
        const key = JSON.stringify(settings.locations)
        const now = Date.now()
        let report: DiscoveryReport
        if (this.discoveryCache && this.discoveryCache.key === key && now - this.discoveryCache.at < 5000) {
            report = this.discoveryCache.report
        } else {
            report = discover(settings.locations)
            this.discoveryCache = { key, at: now, report }
        }
        const db = report.locations.find((l) => l.kind === "opencodeDb" && l.used)
        return {
            settings,
            report,
            sessionDirs: usedPaths(report, "sessions"),
            statsDirs: usedPaths(report, "stats"),
            contentDirs: usedPaths(report, "content"),
            opencodeDb: db ? db.path : null,
        }
    }

    /**
     * Bring the event index up to date. During the first full scan requests
     * answer from the partial index instead of waiting; afterwards a refresh
     * (usually a handful of changed DBs) is awaited briefly.
     */
    async prepare(settings: ServiceSettings): Promise<Ctx> {
        const ctx = this.context(settings)
        if (!this.events.initialDone) {
            void this.events.refresh(ctx.sessionDirs)
            return ctx
        }
        if (Date.now() - this.events.lastRefresh > 2000 || this.events.busy) {
            await Promise.race([this.events.refresh(ctx.sessionDirs), new Promise((r) => setTimeout(r, 1500))])
        }
        return ctx
    }

    // -------------------------------------------------------------- rows

    private ocSessions(ctx: Ctx): Map<string, OcSession> {
        return this.opencode.load(ctx.opencodeDb)
    }

    rows(ctx: Ctx): { rows: SessionRow[]; byId: Map<string, SessionRow> } {
        const oc = this.ocSessions(ctx)
        const key = `${this.events.version}|${ctx.opencodeDb}|${oc.size}|${this.opencodeStamp(oc)}`
        if (this.rowCache && this.rowCache.key === key) return this.rowCache
        const rows: SessionRow[] = []
        const children = new Map<string, number>()
        for (const o of oc.values()) if (o.parentId) children.set(o.parentId, (children.get(o.parentId) ?? 0) + 1)
        for (const s of this.events.sessions()) rows.push(this.toRow(s, oc.get(s.id) ?? null, children.get(s.id) ?? 0))
        const byId = new Map(rows.map((r) => [r.id, r]))
        this.rowCache = { key, rows, byId }
        return this.rowCache
    }

    private opencodeStamp(oc: Map<string, OcSession>): number {
        let m = 0
        for (const o of oc.values()) if (o.updatedAt > m) m = o.updatedAt
        return m
    }

    private toRow(s: SessionAgg, oc: OcSession | null, childCount: number): SessionRow {
        const tally = emptyTally()
        addTypes(tally, s.types)
        tally.compactions = Math.max(tally.compactions, s.compactions)
        // OpenCode knows the session's real directory; context-mode's home DB is the fallback.
        const projectDir = oc?.directory || s.projectDir || ""
        return {
            id: s.id,
            title: oc?.title ?? null,
            projectDir,
            projectName: projectName(projectDir),
            parentId: oc?.parentId ?? null,
            agent: oc?.agent ?? null,
            model: oc?.model ?? null,
            startedAt: s.startedAt,
            lastEventAt: s.lastEventAt,
            activeMs: Math.max(0, s.lastEventAt - s.startedAt),
            synthetic: !s.id.startsWith("ses_"),
            tally,
            usage: s.usage,
            types: s.types,
            resumes: s.resumes,
            childCount,
        }
    }

    /** Sessions passing the global settings filters and the request filter. */
    filtered(ctx: Ctx, filter: QueryFilter): SessionRow[] {
        const { rows } = this.rows(ctx)
        const exclude = excludeMatcher(ctx.settings.filters.excludeProjects)
        const project = filter.project ? normDir(filter.project) : null
        const q = filter.q?.toLowerCase()
        const [lo, hi] = rangeMs(filter.from, filter.to)
        const ranged = !!(filter.from || filter.to)
        const sessions = new Map(this.events.sessions().map((s) => [s.id, s]))
        return rows.filter((r) => {
            if (ctx.settings.filters.hideSynthetic && r.synthetic) return false
            if (exclude && exclude(r.projectDir)) return false
            if (filter.subagents === false && r.parentId) return false
            if (project && normDir(r.projectDir) !== project) return false
            if (q && !(`${r.title ?? ""} ${r.id} ${r.projectDir} ${r.model ?? ""} ${r.agent ?? ""}`.toLowerCase().includes(q))) return false
            if (ranged) {
                const s = sessions.get(r.id)
                if (!s) return false
                if (s.days.size) {
                    let hit = false
                    for (const d of s.days.keys()) if (inDayRange(d, filter.from, filter.to)) { hit = true; break }
                    if (!hit) return false
                } else if (!(r.startedAt >= lo && r.startedAt < hi)) return false
            }
            return true
        })
    }

    // ---------------------------------------------------------- overview

    overview(ctx: Ctx, filter: QueryFilter, topN: number): OverviewPayload {
        const rows = this.filtered(ctx, filter)
        const sessions = new Map(this.events.sessions().map((s) => [s.id, s]))
        const tally = emptyTally()
        const usage = emptyUsage()
        const days = new Map<string, DayBucket>()
        const groups = new Map<string, number>()
        const hourly = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
        const projects = new Map<string, ProjectSummary>()
        let firstDay = ""
        const bucket = (day: string): DayBucket => {
            let b = days.get(day)
            if (!b) {
                b = { day, sessions: 0, events: 0, prompts: 0, errors: 0, steps: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, toolCalls: 0, bytesReturned: 0 }
                days.set(day, b)
            }
            return b
        }
        let subagents = 0
        for (const r of rows) {
            if (r.parentId) subagents++
            const s = sessions.get(r.id)
            if (!s) continue
            const dirKey = normDir(r.projectDir)
            let p = projects.get(dirKey)
            if (!p) {
                p = { dir: r.projectDir, name: r.projectName, sessions: 0, events: 0, steps: 0, tokens: 0, lastEventAt: 0 }
                projects.set(dirKey, p)
            }
            p.sessions++
            p.lastEventAt = Math.max(p.lastEventAt, r.lastEventAt)
            let sessionCounted = false
            for (const d of s.days.values()) {
                if (!inDayRange(d.day, filter.from, filter.to)) continue
                if (!firstDay || d.day < firstDay) firstDay = d.day
                const t = emptyTally()
                addTypes(t, d.types)
                addTypes(tally, d.types)
                mergeUsage(usage, d.usage)
                const b = bucket(d.day)
                b.sessions++
                b.events += t.events - t.steps
                b.prompts += t.prompts
                b.errors += t.errors
                b.steps += d.usage.steps
                b.tokensIn += d.usage.tokensIn
                b.tokensOut += d.usage.tokensOut
                b.cacheRead += d.usage.cacheRead
                b.cacheWrite += d.usage.cacheWrite
                b.costUsd += d.usage.costUsd
                for (const [type, c] of Object.entries(d.types)) {
                    const g = typeGroup(type)
                    groups.set(g, (groups.get(g) ?? 0) + c)
                }
                const dow = new Date(dayStart(d.day) ?? 0).getDay()
                d.hours.forEach((c, h) => (hourly[dow][h] += c))
                p.events += t.events - t.steps
                p.steps += d.usage.steps
                p.tokens += sumPrompt(d.usage) + d.usage.tokensOut
                sessionCounted = true
            }
            if (sessionCounted) tally.compactions += r.tally.compactions
        }
        usage.lastContext = 0

        // Run counters by the day each run started.
        const runs = this.runs.read(ctx.statsDirs).filter((r) => runInRange(r, filter))
        for (const run of runs) {
            const b = bucket(dayKey(run.startedAt || run.updatedAt))
            if (!inDayRange(b.day, filter.from, filter.to)) continue
            b.toolCalls += run.calls
            b.bytesReturned += run.bytesReturned
            if (!firstDay || b.day < firstDay) firstDay = b.day
        }

        const today = dayKey(Date.now())
        const from = filter.from ?? (firstDay || today)
        const to = filter.to ?? today
        const series = from && from <= to ? daysBetween(from, to, 731).map((d) => days.get(d) ?? bucket(d)) : [...days.values()]

        return {
            ok: true,
            generatedAt: Date.now(),
            range: { from: filter.from ?? (firstDay || null), to: filter.to ?? today, days: series.length },
            sessions: rows.length,
            subagentSessions: subagents,
            projects: projects.size,
            tally,
            usage,
            runs: aggregateRuns(runs),
            daily: series,
            categories: [...groups].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
            hourly,
            projectsTop: [...projects.values()].sort((a, b) => b.events + b.steps - (a.events + a.steps)).slice(0, topN),
            heaviest: [...rows].sort((a, b) => sumPrompt(b.usage) - sumPrompt(a.usage)).slice(0, Math.min(topN, 10)),
        }
    }

    // ---------------------------------------------------------- sessions

    sessionsPage(ctx: Ctx, filter: QueryFilter, sort: string, dir: "asc" | "desc", offset: number, limit: number): SessionsPayload {
        const rows = this.filtered(ctx, filter)
        const key = SESSION_SORTS.has(sort) ? sort : "last"
        const val = (r: SessionRow): number | string => {
            switch (key) {
                case "started": return r.startedAt
                case "events": return r.tally.events - r.tally.steps
                case "steps": return r.usage.steps
                case "tokens": return sumPrompt(r.usage) + r.usage.tokensOut
                case "peak": return r.usage.peakContext
                case "errors": return r.tally.errors
                case "prompts": return r.tally.prompts
                case "span": return r.activeMs
                case "cost": return r.usage.costUsd
                case "compactions": return r.tally.compactions
                case "title": return (r.title ?? r.id).toLowerCase()
                default: return r.lastEventAt
            }
        }
        const sign = dir === "asc" ? 1 : -1
        rows.sort((a, b) => {
            const x = val(a), y = val(b)
            if (x < y) return -sign
            if (x > y) return sign
            return b.lastEventAt - a.lastEventAt
        })
        return { ok: true, total: rows.length, offset, rows: rows.slice(offset, offset + limit) }
    }

    // ------------------------------------------------------------ detail

    detail(ctx: Ctx, id: string, opts: { offset: number; limit: number; types: string[] | null; topN: number }): SessionDetail | null {
        const { byId, rows } = this.rows(ctx)
        const row = byId.get(id)
        const agg = this.events.get(id)
        if (!row || !agg) return null
        const oc = this.ocSessions(ctx).get(id) ?? null
        const { showContent, redactPaths } = ctx.settings.privacy
        const textOf = (type: string, data: string): string | null => {
            if (!showContent && SENSITIVE.has(type)) return null
            const t = data.length > 4000 ? data.slice(0, 4000) + "…" : data
            return redactPaths && PATH_TYPES.has(type) ? redactPath(t) : t
        }
        const toEvent = (r: Record<string, unknown>): TimelineEvent => ({
            id: int(r.id), at: sqliteTime(r.created_at), type: str(r.type), category: str(r.category),
            priority: int(r.priority), text: textOf(str(r.type), str(r.data)), bytes: int(r.b),
        })
        const typeFilter = opts.types && opts.types.length ? ` AND type IN (${opts.types.map(() => "?").join(",")})` : " AND type != 'agent_usage'"
        const typeParams = opts.types && opts.types.length ? opts.types : []

        // Ordinary events usually live in the home DB, but walk every DB the session touched.
        let timelineTotal = 0
        const timeline: TimelineEvent[] = []
        const lists: Record<"decisions" | "prompts", TimelineEvent[]> = { decisions: [], prompts: [] }
        const counts: Record<"files" | "errors" | "skills" | "refs", Map<string, { count: number; hint: Set<string> }>> = {
            files: new Map(), errors: new Map(), skills: new Map(), refs: new Map(),
        }
        const bump = (m: Map<string, { count: number; hint: Set<string> }>, label: string, c: number, hint?: string) => {
            if (!label) return
            const e = m.get(label) ?? { count: 0, hint: new Set<string>() }
            e.count += c
            if (hint) e.hint.add(hint)
            m.set(label, e)
        }
        const resumes: ResumeSnapshot[] = []
        const seenEvents = new Set<string>()
        for (const file of agg.dbFiles) {
            try {
                withDb(file, (db) => {
                    const n = int(db.prepare(`SELECT count(*) c FROM session_events WHERE session_id = ?${typeFilter}`).get(id, ...typeParams)?.c)
                    if (!n) return
                    timelineTotal += n
                    for (const r of db.prepare(
                        `SELECT id, type, category, priority, data, created_at, bytes_avoided + bytes_returned b
                         FROM session_events WHERE session_id = ?${typeFilter} ORDER BY created_at DESC, id DESC LIMIT ?`,
                    ).all(id, ...typeParams, opts.offset + opts.limit)) {
                        const key = `${r.type}|${r.created_at}|${str(r.data).slice(0, 200)}`
                        if (seenEvents.has(key)) continue
                        seenEvents.add(key)
                        timeline.push(toEvent(r))
                    }
                    for (const r of db.prepare(
                        `SELECT type, CASE WHEN type = 'error_tool' THEN substr(trim(data), 1, 200) ELSE substr(data, 1, 400) END d, count(*) c
                         FROM session_events WHERE session_id = ? AND type IN ('file_read','file_write','file_edit','error_tool','skill','external_ref')
                         GROUP BY type, d`,
                    ).all(id)) {
                        const type = str(r.type), d = str(r.d), c = int(r.c)
                        if (type.startsWith("file_")) bump(counts.files, redactPaths ? redactPath(d) : d, c, type.slice(5))
                        else if (type === "error_tool") { if (showContent) bump(counts.errors, d, c) }
                        else if (type === "skill") bump(counts.skills, d || "(unnamed)", c)
                        else for (const p of d.split(/,\s*/)) bump(counts.refs, p.trim(), c)
                    }
                    const list = (types: string[], limit: number): TimelineEvent[] =>
                        db.prepare(`SELECT id, type, category, priority, data, created_at, 0 b FROM session_events
                            WHERE session_id = ? AND type IN (${types.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`)
                            .all(id, ...types, limit).map(toEvent)
                    lists.decisions.push(...list(["decision", "blocker", "blocker_resolved", "constraint_discovered"], opts.topN * 2))
                    lists.prompts.push(...list(["user_prompt"], opts.topN * 2))
                    if (tableNames(db).has("session_resume")) {
                        for (const r of db.prepare("SELECT created_at, event_count, consumed, snapshot FROM session_resume WHERE session_id = ? ORDER BY id").all(id)) {
                            const snap = str(r.snapshot)
                            const sections: RankedItem[] = []
                            const re = /<([a-z_]+) count="(\d+)"/g
                            let m: RegExpExecArray | null
                            while ((m = re.exec(snap))) sections.push({ label: m[1].replace(/_/g, " "), count: Number(m[2]) })
                            resumes.push({ at: sqliteTime(r.created_at), events: int(r.event_count), consumed: int(r.consumed) === 1, bytes: snap.length, sections })
                        }
                    }
                })
            } catch {
                // a locked DB drops out of this view; the next request retries
            }
        }
        timeline.sort((a, b) => b.at - a.at || b.id - a.id)
        const ranked = (m: Map<string, { count: number; hint: Set<string> }>): RankedItem[] =>
            [...m].map(([label, v]) => ({ label, count: v.count, hint: v.hint.size ? [...v.hint].join(", ") : undefined }))
                .sort((a, b) => b.count - a.count).slice(0, opts.topN)
        const newest = (l: TimelineEvent[], n: number) => l.sort((a, b) => b.at - a.at).slice(0, n)

        // Per-step usage from the merged in-memory steps, ≤ 600 points (max context per bucket).
        const n = stepCount(agg.steps)
        const per = Math.max(1, Math.ceil(n / 600))
        const series: UsagePoint[] = []
        const drops: number[] = []
        let prev = 0
        for (let i = 0; i < n; i += per) {
            const pt: UsagePoint = { at: 0, context: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
            for (let j = i; j < Math.min(n, i + per); j++) {
                const { at, u } = stepAt(agg.steps, j)
                const size = promptSize(u)
                // A prompt that halves after a large one: a compaction, a reset, or a smaller side call.
                if (prev > 50_000 && size < prev * 0.5) drops.push(at)
                prev = size
                pt.at = at
                pt.context = Math.max(pt.context, size)
                pt.tokensIn += u.tokensIn
                pt.tokensOut += u.tokensOut
                pt.cacheRead += u.cacheRead
                pt.cacheWrite += u.cacheWrite
                pt.costUsd += u.costUsd
            }
            if (pt.at) series.push(pt)
        }

        const runs = this.runs.read(ctx.statsDirs).filter((r) => r.startedAt <= row.lastEventAt && (r.alive ? Date.now() : r.updatedAt) >= row.startedAt)
        const hash = path.basename(agg.dbFile, ".db").split("__")[0]
        const kb = this.knowledgeDbs(ctx).find((k) => k.summary.hash === hash)?.summary ?? null
        return {
            ok: true,
            row,
            parent: row.parentId ? byId.get(row.parentId) ?? null : null,
            children: rows.filter((r) => r.parentId === id).sort((a, b) => a.startedAt - b.startedAt),
            opencode: oc ? {
                title: oc.title, tokensInput: oc.tokensInput, tokensOutput: oc.tokensOutput, tokensReasoning: oc.tokensReasoning,
                tokensCacheRead: oc.tokensCacheRead, tokensCacheWrite: oc.tokensCacheWrite, cost: oc.cost,
                createdAt: oc.createdAt, updatedAt: oc.updatedAt, summaryFiles: oc.summaryFiles,
                summaryAdditions: oc.summaryAdditions, summaryDeletions: oc.summaryDeletions,
            } : null,
            usageSeries: series,
            compactions: resumes.map((r) => r.at).sort((a, b) => a - b),
            contextDrops: drops,
            timeline: timeline.slice(opts.offset, opts.offset + opts.limit),
            timelineTotal,
            files: ranked(counts.files),
            errors: ranked(counts.errors),
            skills: ranked(counts.skills),
            refs: ranked(counts.refs),
            decisions: newest(lists.decisions, opts.topN * 2),
            prompts: newest(lists.prompts, opts.topN * 2),
            resumes: resumes.sort((a, b) => a.at - b.at),
            runs: runs.slice(0, 20),
            knowledge: kb,
        }
    }

    // ---------------------------------------------------------- insights

    insights(ctx: Ctx, filter: QueryFilter, topN: number): InsightsPayload {
        const { showContent, redactPaths } = ctx.settings.privacy
        const key = JSON.stringify([filter, topN, showContent, redactPaths, this.events.version, ctx.settings.filters])
        const hit = this.insightCache.get(key)
        if (hit && Date.now() - hit.at < 30_000) return hit.payload

        const rows = this.filtered(ctx, filter)
        const wanted = new Set(rows.map((r) => r.id))
        const sessions = this.events.sessions()
        const perDb = new Map<string, { ids: string[]; all: boolean }>()
        const dbTotals = new Map<string, number>()
        for (const s of sessions) for (const f of s.dbFiles) dbTotals.set(f, (dbTotals.get(f) ?? 0) + 1)
        for (const s of sessions) {
            if (!wanted.has(s.id) || !s.types || Object.keys(s.types).every((t) => t === "agent_usage")) continue
            for (const f of s.dbFiles) {
                const e = perDb.get(f) ?? { ids: [], all: false }
                e.ids.push(s.id)
                perDb.set(f, e)
            }
        }
        for (const [file, e] of perDb) e.all = e.ids.length === dbTotals.get(file)

        const [lo, hi] = rangeMs(filter.from, filter.to)
        const timeClause = (Number.isFinite(lo) ? ` AND created_at >= '${sqliteUtc(lo)}'` : "") + (Number.isFinite(hi) ? ` AND created_at < '${sqliteUtc(hi)}'` : "")
        const tallies: Record<string, Map<string, number>> = {
            files: new Map(), errors: new Map(), skills: new Map(), refs: new Map(), commands: new Map(), retries: new Map(), intents: new Map(),
        }
        const bump = (m: Map<string, number>, label: string, c: number) => { if (label) m.set(label, (m.get(label) ?? 0) + c) }
        for (const [file, e] of perDb) {
            try {
                withDb(file, (db) => {
                    const idClause = e.all ? "" : ` AND session_id IN (${e.ids.map(() => "?").join(",")})`
                    const params = e.all ? [] : e.ids
                    const res = db.prepare(
                        `SELECT type, substr(trim(data), 1, 200) d, count(*) c FROM session_events
                         WHERE type IN ('file_read','file_write','file_edit','error_tool','skill','external_ref','env','retry_detected','intent')
                         ${idClause}${timeClause} GROUP BY type, d`,
                    ).all(...params)
                    for (const r of res) {
                        const type = str(r.type), d = str(r.d), c = int(r.c)
                        switch (type) {
                            case "file_read": case "file_write": case "file_edit":
                                bump(tallies.files, redactPaths ? redactPath(d) : d, c); break
                            case "error_tool":
                                if (showContent) bump(tallies.errors, d.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 160) ?? "", c); break
                            case "skill": bump(tallies.skills, d || "(unnamed)", c); break
                            case "external_ref": for (const p of d.split(/,\s*/)) bump(tallies.refs, p.trim(), c); break
                            case "env": if (showContent) bump(tallies.commands, commandHead(d), c); break
                            case "retry_detected": bump(tallies.retries, d.replace(/\d+ times/, "N times"), c); break
                            case "intent": bump(tallies.intents, d, c); break
                        }
                    }
                })
            } catch {
                // a locked DB just drops out of this ranking
            }
        }
        const top = (m: Map<string, number>): RankedItem[] => [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, topN)
        const models = new Map<string, number>(), agents = new Map<string, number>()
        for (const r of rows) {
            if (r.model) bump(models, r.model, Math.max(1, r.usage.steps))
            if (r.agent) bump(agents, r.agent, 1)
        }
        const payload: InsightsPayload = {
            ok: true,
            files: top(tallies.files),
            errors: top(tallies.errors),
            skills: top(tallies.skills),
            refs: top(tallies.refs),
            commands: top(tallies.commands),
            retries: top(tallies.retries),
            intents: top(tallies.intents),
            models: top(models),
            agents: top(agents),
            contentHidden: !showContent,
        }
        this.insightCache.set(key, { at: Date.now(), payload })
        if (this.insightCache.size > 32) this.insightCache.delete(this.insightCache.keys().next().value as string)
        return payload
    }

    // -------------------------------------------------------------- runs

    runsPayload(ctx: Ctx, filter: QueryFilter, offset: number, limit: number): RunsPayload {
        const all = this.runs.read(ctx.statsDirs)
        const live = pickLive(all)
        const runs = all.filter((r) => runInRange(r, filter))
        const days = new Map<string, RunsPayload["daily"][number]>()
        let sandboxDominated = 0
        for (const r of runs) {
            const day = dayKey(r.startedAt || r.updatedAt)
            const d = days.get(day) ?? { day, runs: 0, calls: 0, bytesReturned: 0, bytesIndexed: 0, bytesSandboxed: 0 }
            d.runs++
            d.calls += r.calls
            d.bytesReturned += r.bytesReturned
            d.bytesIndexed += r.bytesIndexed
            d.bytesSandboxed += r.bytesSandboxed
            days.set(day, d)
            const kept = r.bytesIndexed + r.bytesSandboxed + r.cacheBytesSaved
            if (kept > 0 && r.bytesSandboxed / kept > 0.9) sandboxDominated++
        }
        return {
            ok: true,
            live,
            liveRuns: liveRuns(all),
            aggregate: aggregateRuns(runs),
            runs: runs.slice(offset, offset + limit),
            total: runs.length,
            daily: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
            sandboxDominated,
        }
    }

    // --------------------------------------------------------- knowledge

    knowledgeDbs(ctx: Ctx): KnowledgeDb[] {
        return this.knowledge.read(ctx.contentDirs, (h) => this.events.projectForHash(h))
    }

    knowledgePayload(ctx: Ctx, filter: QueryFilter, offset: number, limit: number, sort: string): KnowledgePayload {
        const project = filter.project ? normDir(filter.project) : null
        const [lo, hi] = rangeMs(filter.from, filter.to)
        const q = filter.q?.toLowerCase()
        const dbs = this.knowledgeDbs(ctx).filter((k) => !project || (k.summary.projectDir && normDir(k.summary.projectDir) === project))
        const sources = dbs.flatMap((k) => k.sources.filter((s) => (!s.indexedAt || (s.indexedAt >= lo && s.indexedAt < hi)) && (!q || s.label.toLowerCase().includes(q))))
        const kinds = new Map<string, { count: number; value: number }>()
        const daily = new Map<string, { day: string; sources: number; chunks: number }>()
        for (const s of sources) {
            const k = kinds.get(s.kind) ?? { count: 0, value: 0 }
            k.count++
            k.value += s.chunks
            kinds.set(s.kind, k)
            if (s.indexedAt) {
                const day = dayKey(s.indexedAt)
                const d = daily.get(day) ?? { day, sources: 0, chunks: 0 }
                d.sources++
                d.chunks += s.chunks
                daily.set(day, d)
            }
        }
        sources.sort(sort === "chunks" ? (a, b) => b.chunks - a.chunks : (a, b) => b.indexedAt - a.indexedAt)
        const { redactPaths } = ctx.settings.privacy
        const totals = { dbs: dbs.length, bytes: 0, sources: 0, chunks: 0, codeChunks: 0 }
        for (const k of dbs) {
            totals.bytes += k.summary.bytes
            totals.sources += k.summary.sources
            totals.chunks += k.summary.chunks
            totals.codeChunks += k.summary.codeChunks
        }
        return {
            ok: true,
            dbs: dbs.map((k) => k.summary),
            totals,
            kinds: [...kinds].map(([label, v]) => ({ label, count: v.count, value: v.value })).sort((a, b) => b.count - a.count),
            sources: sources.slice(offset, offset + limit).map((s) => (redactPaths && s.filePath ? { ...s, filePath: redactPath(s.filePath) } : s)),
            sourcesTotal: sources.length,
            daily: [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        }
    }

    // ------------------------------------------------------------- brief

    brief(ctx: Ctx, sessionId: string | null, directory: string | null): BriefPayload {
        const { byId } = this.rows(ctx)
        const rows = this.filtered(ctx, {})
        const session = sessionId ? byId.get(sessionId) ?? null : null
        let contextTrail: number[] = []
        if (session) {
            const agg = this.events.get(session.id)
            if (agg) {
                const n = stepCount(agg.steps)
                for (let i = Math.max(0, n - 40); i < n; i++) contextTrail.push(promptSize(stepAt(agg.steps, i).u))
            }
        }
        let project: ProjectSummary | null = null
        const dir = directory ?? session?.projectDir ?? null
        if (dir) {
            const key = normDir(dir)
            for (const r of rows) {
                if (normDir(r.projectDir) !== key) continue
                project ??= { dir: r.projectDir, name: r.projectName, sessions: 0, events: 0, steps: 0, tokens: 0, lastEventAt: 0 }
                project.sessions++
                project.events += r.tally.events - r.tally.steps
                project.steps += r.usage.steps
                project.tokens += sumPrompt(r.usage) + r.usage.tokensOut
                project.lastEventAt = Math.max(project.lastEventAt, r.lastEventAt)
            }
        }
        const runs = this.runs.read(ctx.statsDirs)
        return { ok: true, session, contextTrail, project, live: pickLive(runs), liveRuns: liveRuns(runs), progress: this.events.progress }
    }

    // ------------------------------------------------------------ status

    status(ctx: Ctx): StatusPayload {
        const runs = this.runs.read(ctx.statsDirs)
        const sessions = this.events.sessions()
        let events = 0
        for (const s of sessions) for (const c of Object.values(s.types)) events += c
        let knowledgeSources = 0
        try {
            for (const k of this.knowledgeDbs(ctx)) knowledgeSources += k.summary.sources
        } catch {
            knowledgeSources = 0
        }
        return {
            ok: true,
            generatedAt: Date.now(),
            progress: this.events.progress,
            discovery: ctx.report,
            totals: { sessions: sessions.length, events, runs: runs.length, knowledgeSources },
            live: pickLive(runs),
            liveRuns: liveRuns(runs),
        }
    }
}

function runInRange(r: RunSummary, filter: QueryFilter): boolean {
    if (!filter.from && !filter.to) return true
    const [lo, hi] = rangeMs(filter.from, filter.to)
    const end = r.alive ? Date.now() : r.updatedAt || r.startedAt
    return (r.startedAt || end) < hi && end >= lo
}

/** First word(s) of a shell command, for ranking: `git status`, `npm run`, `bun test`. */
export function commandHead(cmd: string): string {
    const first = cmd.trim().split(/\s*(?:\||&&|;)\s*/)[0] ?? ""
    const words = first.split(/\s+/).filter(Boolean)
    if (!words.length) return ""
    const bin = words[0].replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "")
    const sub = words[1] && /^[a-z][\w:-]*$/i.test(words[1]) ? ` ${words[1]}` : ""
    return (bin + sub).slice(0, 60)
}

export type { EventTally }
