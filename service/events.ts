/**
 * Session event index.
 *
 * context-mode's OpenCode plugin keeps one SQLite DB per project directory
 * (`<hash>.db`, `<hash>__<worktree>.db`) with `session_meta` (one row per
 * OpenCode session) and `session_events` (prompts, file ops, errors, model
 * steps, …). This module indexes every DB into compact per-session, per-day
 * aggregates and re-reads a DB only when its file (or WAL) changes.
 *
 * One OpenCode session usually appears in several DBs: its real events live in
 * the DB of its project, but each model step (`agent_usage`) is written to
 * every project DB that plugin instance has open. So sessions are merged
 * across DBs: ordinary events are summed (they are not duplicated), and model
 * steps are de-duplicated by (time, token counts).
 *
 * `agent_usage` data is `tokens_in:N tokens_out:N [cache_create:N]
 * [cache_read:N] cost_usd:N`. The prompt size of a step (in + cache read +
 * cache write) is the context the model actually read — the one real
 * "context size" signal there is.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { int, sqliteTime, str, tableNames, withDb } from "./sqlite.ts"
import type { Db } from "./sqlite.ts"
import { SESSION_DB_RE } from "./discover.ts"
import { dayKey, yieldTick } from "./util.ts"
import type { EventTally, IndexProgress, Usage } from "./types.ts"

// ------------------------------------------------------------------ shapes

export interface StepUsage {
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    costUsd: number
}

/** Steps packed as [at, in, out, cacheRead, cacheWrite, cost] × n. */
export const STEP_STRIDE = 6

export interface DayAgg {
    day: string
    types: Record<string, number>
    /** Local hour (0–23) → events, model steps included. */
    hours: number[]
    usage: Usage
}

/** One session as seen by one DB. */
export interface DbSession {
    id: string
    dbFile: string
    projectDir: string
    startedAt: number
    lastEventAt: number
    compactions: number
    resumes: number
    /** Ordinary (non-step) events in this DB. */
    events: number
    types: Record<string, number>
    days: Map<string, { types: Record<string, number>; hours: number[] }>
    steps: Float64Array
}

/** One session merged across every DB it appears in. */
export interface SessionAgg {
    id: string
    /** DBs holding any of its events, home DB first. */
    dbFiles: string[]
    /** The DB holding most of its ordinary events. */
    dbFile: string
    projectDir: string
    startedAt: number
    lastEventAt: number
    compactions: number
    resumes: number
    types: Record<string, number>
    usage: Usage
    days: Map<string, DayAgg>
    /** De-duplicated steps, time-ordered, packed like DbSession.steps. */
    steps: Float64Array
}

interface DbIndex {
    file: string
    hash: string
    stamp: string
    sessions: DbSession[]
    error?: string
}

// --------------------------------------------------------------- parsing

const USAGE_RE = /(tokens_in|tokens_out|cache_create|cache_read|cost_usd):\s*([0-9.eE+-]+)/g

export function parseUsage(data: string): StepUsage | null {
    let found = false
    const u: StepUsage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
    USAGE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = USAGE_RE.exec(data))) {
        const v = Number(m[2])
        if (!Number.isFinite(v)) continue
        found = true
        if (m[1] === "tokens_in") u.tokensIn = v
        else if (m[1] === "tokens_out") u.tokensOut = v
        else if (m[1] === "cache_create") u.cacheWrite = v
        else if (m[1] === "cache_read") u.cacheRead = v
        else u.costUsd = v
    }
    return found ? u : null
}

export const promptSize = (u: StepUsage): number => u.tokensIn + u.cacheRead + u.cacheWrite

export function stepAt(steps: Float64Array, i: number): { at: number; u: StepUsage } {
    const o = i * STEP_STRIDE
    return { at: steps[o], u: { tokensIn: steps[o + 1], tokensOut: steps[o + 2], cacheRead: steps[o + 3], cacheWrite: steps[o + 4], costUsd: steps[o + 5] } }
}

export const stepCount = (steps: Float64Array): number => steps.length / STEP_STRIDE

export function emptyUsage(): Usage {
    return { steps: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, peakContext: 0, lastContext: 0 }
}

export function addStep(u: Usage, s: StepUsage): void {
    u.steps++
    u.tokensIn += s.tokensIn
    u.tokensOut += s.tokensOut
    u.cacheRead += s.cacheRead
    u.cacheWrite += s.cacheWrite
    u.costUsd += s.costUsd
    const p = promptSize(s)
    u.peakContext = Math.max(u.peakContext, p)
    u.lastContext = p
}

export function mergeUsage(into: Usage, u: Usage): void {
    into.steps += u.steps
    into.tokensIn += u.tokensIn
    into.tokensOut += u.tokensOut
    into.cacheRead += u.cacheRead
    into.cacheWrite += u.cacheWrite
    into.costUsd += u.costUsd
    into.peakContext = Math.max(into.peakContext, u.peakContext)
    into.lastContext = u.lastContext || into.lastContext
}

export function emptyTally(): EventTally {
    return {
        events: 0, prompts: 0, errors: 0, errorsResolved: 0, retries: 0, decisions: 0, blockers: 0,
        blockersResolved: 0, fileReads: 0, fileWrites: 0, fileEdits: 0, fileSearches: 0, gitOps: 0,
        commits: 0, skills: 0, externalRefs: 0, constraints: 0, compactions: 0, steps: 0,
    }
}

/** Fold a `type → count` map into the named tally. Unknown types still count as events. */
export function addTypes(t: EventTally, types: Record<string, number>): void {
    for (const [type, c] of Object.entries(types)) {
        t.events += c
        switch (type) {
            case "user_prompt": t.prompts += c; break
            case "error_tool": t.errors += c; break
            case "error_resolved": t.errorsResolved += c; break
            case "retry_detected": t.retries += c; break
            case "decision": t.decisions += c; break
            case "blocker": t.blockers += c; break
            case "blocker_resolved": t.blockersResolved += c; break
            case "file_read": t.fileReads += c; break
            case "file_write": t.fileWrites += c; break
            case "file_edit": t.fileEdits += c; break
            case "file_search": case "file_glob": t.fileSearches += c; break
            case "git": t.gitOps += c; break
            case "git_commit": t.commits += c; t.gitOps += c; break
            case "skill": t.skills += c; break
            case "external_ref": t.externalRefs += c; break
            case "constraint_discovered": t.constraints += c; break
            case "compaction_summary": t.compactions += c; break
            case "agent_usage": t.steps += c; break
        }
    }
}

/** Display grouping for event types (used for colours and the category mix). */
export function typeGroup(type: string): string {
    if (type === "agent_usage") return "model steps"
    if (type === "user_prompt" || type === "intent" || type === "role" || type === "data") return "prompts & intent"
    if (type.startsWith("file_")) return "files"
    if (type.startsWith("error") || type === "retry_detected") return "errors & retries"
    if (type === "decision" || type.startsWith("blocker") || type === "constraint_discovered") return "decisions & constraints"
    if (type.startsWith("git")) return "git"
    if (type === "skill" || type === "rule" || type === "rule_content") return "skills & rules"
    if (type === "external_ref") return "references"
    if (type === "env" || type === "cwd" || type === "bash_outcome") return "shell & env"
    if (type.includes("compaction") || type.includes("snapshot")) return "compaction"
    return "other"
}

// ------------------------------------------------------------- per-DB read

function fileStamp(file: string): string | null {
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (!st) return null
    const wal = fs.statSync(file + "-wal", { throwIfNoEntry: false })
    return `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`
}

/** Read one session DB. Exported for tests. */
export function indexSessionDb(file: string): DbSession[] {
    return withDb(file, (db) => readSessions(db, file))
}

function readSessions(db: Db, file: string): DbSession[] {
    const tables = tableNames(db)
    if (!tables.has("session_events")) return []
    const sessions = new Map<string, DbSession>()
    const stepLists = new Map<string, number[]>()
    const get = (id: string): DbSession => {
        let s = sessions.get(id)
        if (!s) {
            s = { id, dbFile: file, projectDir: "", startedAt: 0, lastEventAt: 0, compactions: 0, resumes: 0, events: 0, types: {}, days: new Map(), steps: new Float64Array(0) }
            sessions.set(id, s)
        }
        return s
    }

    if (tables.has("session_meta")) {
        for (const r of db.prepare("SELECT session_id, project_dir, started_at, last_event_at, compact_count FROM session_meta").all()) {
            const s = get(str(r.session_id))
            s.projectDir = str(r.project_dir)
            s.startedAt = sqliteTime(r.started_at)
            s.lastEventAt = sqliteTime(r.last_event_at)
            s.compactions = int(r.compact_count)
        }
    }

    const rows = db.prepare(
        `SELECT session_id sid, date(created_at,'localtime') d, CAST(strftime('%H',created_at,'localtime') AS INTEGER) h,
                type, count(*) c, min(created_at) a, max(created_at) b, max(project_dir) p
         FROM session_events WHERE type != 'agent_usage' GROUP BY 1,2,3,4`,
    ).all()
    for (const r of rows) {
        const s = get(str(r.sid))
        const type = str(r.type)
        const c = int(r.c)
        s.events += c
        s.types[type] = (s.types[type] ?? 0) + c
        const dk = str(r.d)
        let d = s.days.get(dk)
        if (!d) s.days.set(dk, (d = { types: {}, hours: new Array(24).fill(0) }))
        d.types[type] = (d.types[type] ?? 0) + c
        const h = int(r.h)
        if (h >= 0 && h < 24) d.hours[h] += c
        const a = sqliteTime(r.a), b = sqliteTime(r.b)
        if (a && (!s.startedAt || a < s.startedAt)) s.startedAt = a
        if (b > s.lastEventAt) s.lastEventAt = b
        if (!s.projectDir && r.p) s.projectDir = str(r.p)
    }

    for (const r of db.prepare("SELECT session_id sid, created_at at, data FROM session_events WHERE type = 'agent_usage' ORDER BY id").all()) {
        const at = sqliteTime(r.at)
        const u = parseUsage(str(r.data))
        if (!at || !u) continue
        const sid = str(r.sid)
        get(sid)
        let list = stepLists.get(sid)
        if (!list) stepLists.set(sid, (list = []))
        list.push(at, u.tokensIn, u.tokensOut, u.cacheRead, u.cacheWrite, u.costUsd)
    }
    for (const [sid, list] of stepLists) get(sid).steps = Float64Array.from(list)

    if (tables.has("session_resume")) {
        for (const r of db.prepare("SELECT session_id sid, count(*) c FROM session_resume GROUP BY 1").all()) get(str(r.sid)).resumes = int(r.c)
    }
    return [...sessions.values()]
}

// ------------------------------------------------------------------ merge

/** Merge one session's per-DB copies. Exported for tests. */
export function mergeSession(parts: DbSession[]): SessionAgg {
    // Home DB: most ordinary events, then earliest start.
    const ordered = [...parts].sort((a, b) => b.events - a.events || (a.startedAt || Infinity) - (b.startedAt || Infinity))
    const home = ordered[0]
    const types: Record<string, number> = {}
    const days = new Map<string, DayAgg>()
    const dayOf = (k: string): DayAgg => {
        let d = days.get(k)
        if (!d) days.set(k, (d = { day: k, types: {}, hours: new Array(24).fill(0), usage: emptyUsage() }))
        return d
    }
    let startedAt = 0, lastEventAt = 0, compactions = 0, resumes = 0
    for (const p of parts) {
        for (const [t, c] of Object.entries(p.types)) types[t] = (types[t] ?? 0) + c
        for (const [k, d] of p.days) {
            const into = dayOf(k)
            for (const [t, c] of Object.entries(d.types)) into.types[t] = (into.types[t] ?? 0) + c
            d.hours.forEach((c, h) => (into.hours[h] += c))
        }
        if (p.startedAt && (!startedAt || p.startedAt < startedAt)) startedAt = p.startedAt
        lastEventAt = Math.max(lastEventAt, p.lastEventAt)
        compactions = Math.max(compactions, p.compactions)
        resumes += p.resumes
    }

    // Union of steps, de-duplicated on (time, in, out, cache read, cache write).
    const seen = new Set<string>()
    const merged: number[] = []
    const all = parts.length === 1 ? [parts[0].steps] : parts.map((p) => p.steps)
    for (const steps of all) {
        for (let o = 0; o < steps.length; o += STEP_STRIDE) {
            const key = `${steps[o]}|${steps[o + 1]}|${steps[o + 2]}|${steps[o + 3]}|${steps[o + 4]}`
            if (seen.has(key)) continue
            seen.add(key)
            for (let k = 0; k < STEP_STRIDE; k++) merged.push(steps[o + k])
        }
    }
    const n = merged.length / STEP_STRIDE
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => merged[a * STEP_STRIDE] - merged[b * STEP_STRIDE])
    const steps = new Float64Array(merged.length)
    order.forEach((src, i) => {
        for (let k = 0; k < STEP_STRIDE; k++) steps[i * STEP_STRIDE + k] = merged[src * STEP_STRIDE + k]
    })

    const usage = emptyUsage()
    for (let i = 0; i < n; i++) {
        const { at, u } = stepAt(steps, i)
        addStep(usage, u)
        const d = dayOf(dayKey(at))
        addStep(d.usage, u)
        d.types.agent_usage = (d.types.agent_usage ?? 0) + 1
        d.hours[new Date(at).getHours()]++
        if (!startedAt || at < startedAt) startedAt = at
        if (at > lastEventAt) lastEventAt = at
    }
    if (n) types.agent_usage = n
    else delete types.agent_usage

    return {
        id: home.id,
        dbFiles: ordered.map((p) => p.dbFile),
        dbFile: home.dbFile,
        projectDir: home.projectDir || ordered.find((p) => p.projectDir)?.projectDir || "",
        startedAt,
        lastEventAt,
        compactions,
        resumes,
        types,
        usage,
        days,
        steps,
    }
}

// ------------------------------------------------------------------ index

export class EventIndex {
    private dbs = new Map<string, DbIndex>()
    private running: Promise<void> | null = null
    private dirsKey = ""
    private merged = new Map<string, SessionAgg>()
    private dirty = new Set<string>()
    private list: SessionAgg[] | null = null
    lastRefresh = 0
    progress: IndexProgress = { phase: "idle", done: 0, total: 0, startedAt: 0, finishedAt: 0 }
    /** Bumps whenever indexed data changes; consumers key caches on it. */
    version = 0
    initialDone = false

    /** Start (or join) a refresh of every DB under `dirs`. */
    refresh(dirs: string[]): Promise<void> {
        const key = dirs.join("|")
        if (key !== this.dirsKey) {
            this.dirsKey = key
            this.dbs.clear()
            this.merged.clear()
            this.dirty.clear()
            this.list = null
            this.initialDone = false
            this.version++
        }
        if (this.running) return this.running
        this.running = this.run(dirs).finally(() => {
            this.running = null
            this.lastRefresh = Date.now()
        })
        return this.running
    }

    get busy(): boolean {
        return this.running !== null
    }

    private async run(dirs: string[]): Promise<void> {
        const files: string[] = []
        for (const dir of dirs) {
            let entries: string[] = []
            try {
                entries = fs.readdirSync(dir)
            } catch {
                continue
            }
            for (const name of entries) if (SESSION_DB_RE.test(name)) files.push(path.join(dir, name))
        }
        const changed: [string, string][] = []
        for (const file of files) {
            const stamp = fileStamp(file)
            if (!stamp) continue
            if (this.dbs.get(file)?.stamp !== stamp) changed.push([file, stamp])
        }
        const present = new Set(files)
        let removed = false
        for (const [file, db] of [...this.dbs]) {
            if (present.has(file)) continue
            for (const s of db.sessions) this.dirty.add(s.id)
            this.dbs.delete(file)
            removed = true
        }
        if (!changed.length) {
            if (removed) this.bump()
            if (!this.initialDone) this.finish(files.length)
            return
        }
        const initial = !this.initialDone
        if (initial) this.progress = { phase: "scanning", done: 0, total: changed.length, startedAt: Date.now(), finishedAt: 0 }
        let i = 0
        for (const [file, stamp] of changed) {
            const hash = path.basename(file, ".db").split("__")[0]
            const prev = this.dbs.get(file)
            if (prev) for (const s of prev.sessions) this.dirty.add(s.id)
            try {
                const sessions = indexSessionDb(file)
                for (const s of sessions) this.dirty.add(s.id)
                this.dbs.set(file, { file, hash, stamp, sessions })
            } catch (error) {
                // Locked or corrupt: keep the previous copy; an empty stamp retries next refresh.
                this.dbs.set(file, { file, hash, stamp: "", sessions: prev?.sessions ?? [], error: error instanceof Error ? error.message : String(error) })
            }
            i++
            if (initial) this.progress.done = i
            if (i % 8 === 0) {
                if (initial) this.bump()
                await yieldTick()
            }
        }
        this.bump()
        this.finish(files.length)
    }

    private finish(total: number): void {
        this.initialDone = true
        this.progress = { phase: "ready", done: total, total, startedAt: this.progress.startedAt, finishedAt: Date.now() }
    }

    private bump(): void {
        this.version++
        this.list = null
    }

    /** Every session, merged across DBs. Only sessions touched since the last call are re-merged. */
    sessions(): SessionAgg[] {
        if (this.list && !this.dirty.size) return this.list
        if (this.dirty.size) {
            const parts = new Map<string, DbSession[]>()
            for (const db of this.dbs.values()) {
                for (const s of db.sessions) {
                    if (!this.dirty.has(s.id)) continue
                    const l = parts.get(s.id)
                    if (l) l.push(s)
                    else parts.set(s.id, [s])
                }
            }
            for (const id of this.dirty) {
                const p = parts.get(id)
                if (p) this.merged.set(id, mergeSession(p))
                else this.merged.delete(id)
            }
            this.dirty.clear()
        }
        this.list = [...this.merged.values()]
        return this.list
    }

    get(id: string): SessionAgg | undefined {
        this.sessions()
        return this.merged.get(id)
    }

    /** Hash (file name before `__`) → project directory, for knowledge-base DBs. */
    projectForHash(hash: string): string | null {
        for (const db of this.dbs.values()) {
            if (db.hash !== hash) continue
            const best = [...db.sessions].sort((a, b) => b.events - a.events).find((s) => s.projectDir)
            if (best) return best.projectDir
        }
        return null
    }

    errors(): { file: string; error: string }[] {
        return [...this.dbs.values()].filter((d) => d.error).map((d) => ({ file: d.file, error: d.error as string }))
    }
}
