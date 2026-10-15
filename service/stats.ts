/**
 * context-mode stats aggregation.
 *
 * Reads the per-process stats files context-mode persists
 * (`<config>/opencode/context-mode/sessions/stats-pid-*.json`) and produces
 * the panel payload: the live process, an aggregate over a selectable scope
 * (all time / single process / day range), a daily savings series and
 * per-tool breakdowns.
 *
 * Dollar figures come from service/pricing.ts (models.dev rates weighted by
 * the user's real model mix), never from context-mode's flat estimate.
 *
 * Persisted files are untrusted JSON: every field is validated and malformed
 * files are skipped, never thrown.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { PricingEngine } from "./pricing"
import type { PricingResult } from "./pricing"

// ------------------------------------------------------------------ types

export interface ToolStat {
    name: string
    calls: number
    bytes: number
}

export interface LiveProcess {
    pid: string
    startedAt: number
    updatedAt: number
    uptimeMs: number
    totalCalls: number
    bytesReturned: number
    bytesIndexed: number
    bytesSandboxed: number
    cacheHits: number
    cacheBytesSaved: number
    keptOut: number
    totalProcessed: number
    reductionPct: number
    tokensSaved: number
    tools: ToolStat[]
}

export interface ProcessSummary {
    pid: string
    startedAt: number
    updatedAt: number
    totalCalls: number
    tokensSaved: number
}

export interface Aggregate {
    processes: number
    totalCalls: number
    bytesReturned: number
    bytesIndexed: number
    bytesSandboxed: number
    cacheHits: number
    cacheBytesSaved: number
    keptOut: number
    totalProcessed: number
    tokensSaved: number
    tools: ToolStat[]
}

export interface DayPoint {
    /** YYYY-MM-DD (local) */
    day: string
    tokensSaved: number
    calls: number
    bytesProcessed: number
    sessions: number
}

/** Scope selector for the aggregate section. */
export interface Scope {
    /** single process pid */
    pid?: string
    /** YYYY-MM-DD, inclusive, local time */
    from?: string
    /** YYYY-MM-DD, inclusive, local time */
    to?: string
}

export interface ScopeEcho {
    kind: "all" | "process" | "range"
    label: string
}

export interface StatsPayload {
    ok: true
    /** Primary store — the candidate dir with the freshest stats file. */
    storageDir: string
    /** Every candidate store that was scanned. */
    storageDirs: string[]
    generatedAt: number
    reason?: "storage-missing"
    live: LiveProcess | null
    liveStale: boolean
    /** Aggregate over the requested scope (all time when no scope given). */
    scoped: Aggregate | null
    scope: ScopeEcho
    /** Pricing for the scoped tokensSaved; null when not computable. */
    pricing: PricingResult | null
    /** Every known process, newest first — feeds the scope picker. */
    processes: ProcessSummary[]
    daily: DayPoint[]
}

// ------------------------------------------------------------- value guards

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

// ------------------------------------------------------------ storage dirs

/**
 * Candidate session-stats directories. context-mode has lived under both the
 * XDG config home and the plain ~/.config tree, and mirrors can lag the live
 * store, so every existing candidate is scanned and files are deduped by
 * pid + session start (mirrors hold byte-identical copies; on conflict the
 * freshest version wins). CONTEXT_MODE_STATS_DIR pins a single directory.
 */
export function resolveStorageDirs(): string[] {
    const override = process.env.CONTEXT_MODE_STATS_DIR
    if (override && override.trim()) return [override.trim()]
    const home = os.homedir()
    const candidates: string[] = []
    const xdg = process.env.XDG_CONFIG_HOME
    if (xdg && xdg.trim()) {
        candidates.push(path.join(xdg.trim(), "opencode", "context-mode", "sessions"))
    }
    candidates.push(path.join(home, ".config", "opencode", "context-mode", "sessions"))
    candidates.push(path.join(home, ".opencode-v2", "config", "opencode", "context-mode", "sessions"))
    return [...new Set(candidates)]
}

// ------------------------------------------------------------- file parsing

interface StatsFile {
    pid: string
    sessionStart: number
    updatedAt: number
    uptimeMs: number
    totalCalls: number
    bytesReturned: number
    bytesIndexed: number
    bytesSandboxed: number
    cacheHits: number
    cacheBytesSaved: number
    keptOut: number
    totalProcessed: number
    reductionPct: number
    tokensSaved: number
    tools: ToolStat[]
}

function parseStatsFile(pid: string, raw: unknown): StatsFile | null {
    if (!isRecord(raw)) return null
    const tools: ToolStat[] = []
    if (isRecord(raw.by_tool)) {
        for (const [name, stat] of Object.entries(raw.by_tool)) {
            if (!isRecord(stat)) continue
            tools.push({ name, calls: num(stat.calls), bytes: num(stat.bytes) })
        }
        tools.sort((a, b) => b.bytes - a.bytes)
    }
    return {
        pid,
        sessionStart: num(raw.session_start),
        updatedAt: num(raw.updated_at),
        uptimeMs: num(raw.uptime_ms),
        totalCalls: num(raw.total_calls),
        bytesReturned: num(raw.bytes_returned),
        bytesIndexed: num(raw.bytes_indexed),
        bytesSandboxed: num(raw.bytes_sandboxed),
        cacheHits: num(raw.cache_hits),
        cacheBytesSaved: num(raw.cache_bytes_saved),
        keptOut: num(raw.kept_out),
        totalProcessed: num(raw.total_processed),
        reductionPct: num(raw.reduction_pct),
        tokensSaved: num(raw.tokens_saved),
        tools,
    }
}

function dayKey(timestamp: number): string {
    const d = new Date(timestamp)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
}

/** Start-of-day ms for a YYYY-MM-DD string in local time; null if invalid. */
function dayStartMs(day: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!match) return null
    const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    return Number.isFinite(ms) ? ms : null
}

// ------------------------------------------------------------------ store

const LIVE_WINDOW_MS = 60_000

export class StatsStore {
    readonly storageDirs: string[]
    private readonly pricing: PricingEngine

    constructor(storageDirs: string[], pricing?: PricingEngine) {
        this.storageDirs = storageDirs
        this.pricing = pricing ?? new PricingEngine()
    }

    /** Primary dir — filled in after each scan with the freshest store. */
    storageDir = ""

    private async readAll(): Promise<StatsFile[] | null> {
        const byKey = new Map<string, StatsFile>()
        let foundAny = false
        let freshestDir = ""
        let freshestUpdate = -1
        for (const dir of this.storageDirs) {
            let entries: string[]
            try {
                entries = await fs.readdir(dir)
            } catch {
                continue
            }
            foundAny = true
            for (const entry of entries) {
                const match = /^stats-pid-(.+)\.json$/.exec(entry)
                if (!match) continue
                try {
                    const raw: unknown = JSON.parse(
                        await fs.readFile(path.join(dir, entry), "utf8"),
                    )
                    const parsed = parseStatsFile(match[1], raw)
                    if (!parsed) continue
                    if (parsed.updatedAt > freshestUpdate) {
                        freshestUpdate = parsed.updatedAt
                        freshestDir = dir
                    }
                    const key = `${parsed.pid}@${parsed.sessionStart}`
                    const existing = byKey.get(key)
                    if (!existing || parsed.updatedAt > existing.updatedAt) {
                        byKey.set(key, parsed)
                    }
                } catch {
                    // malformed file — skip
                }
            }
        }
        if (!foundAny) return null
        this.storageDir = freshestDir
        return [...byKey.values()]
    }

    private aggregate(files: StatsFile[]): Aggregate | null {
        if (files.length === 0) return null
        const toolMap = new Map<string, ToolStat>()
        const acc: Aggregate = {
            processes: files.length,
            totalCalls: 0,
            bytesReturned: 0,
            bytesIndexed: 0,
            bytesSandboxed: 0,
            cacheHits: 0,
            cacheBytesSaved: 0,
            keptOut: 0,
            totalProcessed: 0,
            tokensSaved: 0,
            tools: [],
        }
        for (const f of files) {
            acc.totalCalls += f.totalCalls
            acc.bytesReturned += f.bytesReturned
            acc.bytesIndexed += f.bytesIndexed
            acc.bytesSandboxed += f.bytesSandboxed
            acc.cacheHits += f.cacheHits
            acc.cacheBytesSaved += f.cacheBytesSaved
            acc.keptOut += f.keptOut
            acc.totalProcessed += f.totalProcessed
            acc.tokensSaved += f.tokensSaved
            for (const t of f.tools) {
                const existing = toolMap.get(t.name)
                if (existing) {
                    existing.calls += t.calls
                    existing.bytes += t.bytes
                } else {
                    toolMap.set(t.name, { name: t.name, calls: t.calls, bytes: t.bytes })
                }
            }
        }
        acc.tools = [...toolMap.values()].sort((a, b) => b.bytes - a.bytes)
        return acc
    }

    async getStats(scope: Scope = {}): Promise<StatsPayload> {
        const generatedAt = Date.now()
        const files = await this.readAll()
        if (files === null) {
            return {
                ok: true,
                storageDir: this.storageDirs[0] ?? "",
                storageDirs: this.storageDirs,
                generatedAt,
                reason: "storage-missing",
                live: null,
                liveStale: false,
                scoped: null,
                scope: { kind: "all", label: "All time" },
                pricing: null,
                processes: [],
                daily: [],
            }
        }

        // ---- live process: most recently updated file
        let live: LiveProcess | null = null
        let liveStale = false
        const sorted = [...files].sort((a, b) => b.updatedAt - a.updatedAt)
        const newest = sorted[0]
        if (newest && newest.updatedAt > 0) {
            liveStale = generatedAt - newest.updatedAt > LIVE_WINDOW_MS
            live = {
                pid: newest.pid,
                startedAt: newest.sessionStart,
                updatedAt: newest.updatedAt,
                uptimeMs: newest.uptimeMs,
                totalCalls: newest.totalCalls,
                bytesReturned: newest.bytesReturned,
                bytesIndexed: newest.bytesIndexed,
                bytesSandboxed: newest.bytesSandboxed,
                cacheHits: newest.cacheHits,
                cacheBytesSaved: newest.cacheBytesSaved,
                keptOut: newest.keptOut,
                totalProcessed: newest.totalProcessed,
                reductionPct: newest.reductionPct,
                tokensSaved: newest.tokensSaved,
                tools: newest.tools,
            }
        }

        // ---- process picker list (newest first)
        const processes: ProcessSummary[] = sorted.map((f) => ({
            pid: f.pid,
            startedAt: f.sessionStart,
            updatedAt: f.updatedAt,
            totalCalls: f.totalCalls,
            tokensSaved: f.tokensSaved,
        }))

        // ---- scope resolution
        let scopedFiles = files
        let scopeEcho: ScopeEcho = { kind: "all", label: "All time" }
        let windowStart = 0
        let windowEnd = generatedAt

        if (scope.pid) {
            scopedFiles = files.filter((f) => f.pid === scope.pid)
            const p = scopedFiles[0]
            scopeEcho = {
                kind: "process",
                label: p ? `Process ${p.pid}` : `Process ${scope.pid} (not found)`,
            }
            if (p) {
                windowStart = p.sessionStart
                windowEnd = p.updatedAt > p.sessionStart ? p.updatedAt : generatedAt
            }
        } else if (scope.from || scope.to) {
            const fromMs = scope.from ? dayStartMs(scope.from) : null
            const toMs = scope.to ? dayStartMs(scope.to) : null
            const startMs = fromMs ?? 0
            const endMs = toMs !== null ? toMs + 86_399_999 : generatedAt
            scopedFiles = files.filter(
                (f) => f.sessionStart >= startMs && f.sessionStart <= endMs,
            )
            scopeEcho = {
                kind: "range",
                label:
                    scope.from && scope.to
                        ? `${scope.from} → ${scope.to}`
                        : scope.from
                          ? `Since ${scope.from}`
                          : `Until ${scope.to}`,
            }
            windowStart = startMs
            windowEnd = endMs
        } else {
            const starts = files.map((f) => f.sessionStart).filter((s) => s > 0)
            windowStart = starts.length > 0 ? Math.min(...starts) : 0
        }

        const scoped = this.aggregate(scopedFiles)

        // ---- pricing for the scoped savings
        const pricing = scoped
            ? await this.pricing.price(windowStart, windowEnd, scoped.tokensSaved)
            : null

        // ---- daily series (bucket by session start day; respects range scope)
        const dayMap = new Map<string, DayPoint>()
        for (const f of scopedFiles) {
            if (f.sessionStart <= 0) continue
            const key = dayKey(f.sessionStart)
            const point = dayMap.get(key) ?? {
                day: key,
                tokensSaved: 0,
                calls: 0,
                bytesProcessed: 0,
                sessions: 0,
            }
            point.tokensSaved += f.tokensSaved
            point.calls += f.totalCalls
            point.bytesProcessed += f.totalProcessed
            point.sessions += 1
            dayMap.set(key, point)
        }
        const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))

        return {
            ok: true,
            storageDir: this.storageDir,
            storageDirs: this.storageDirs,
            generatedAt,
            live,
            liveStale,
            scoped,
            scope: scopeEcho,
            pricing,
            processes,
            daily,
        }
    }
}
