/**
 * context-mode stats aggregation.
 *
 * Reads the per-process stats files context-mode persists
 * (`<config>/opencode/context-mode/sessions/stats-pid-*.json`) and produces
 * the panel payload: the live process, all-time totals, a daily savings
 * series and per-tool breakdowns.
 *
 * Persisted files are untrusted JSON: every field is validated and malformed
 * files are skipped, never thrown.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

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
    dollarsSaved: number
    tools: ToolStat[]
}

export interface AllTime {
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
    dollarsSaved: number
    tools: ToolStat[]
}

export interface DayPoint {
    /** YYYY-MM-DD (local) */
    day: string
    tokensSaved: number
    dollarsSaved: number
    calls: number
    bytesProcessed: number
    sessions: number
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
    allTime: AllTime | null
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
    dollarsSaved: number
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
    const totalCalls = num(raw.total_calls)
    const totalProcessed = num(raw.total_processed)
    return {
        pid,
        sessionStart: num(raw.session_start),
        updatedAt: num(raw.updated_at),
        uptimeMs: num(raw.uptime_ms),
        totalCalls,
        bytesReturned: num(raw.bytes_returned),
        bytesIndexed: num(raw.bytes_indexed),
        bytesSandboxed: num(raw.bytes_sandboxed),
        cacheHits: num(raw.cache_hits),
        cacheBytesSaved: num(raw.cache_bytes_saved),
        keptOut: num(raw.kept_out),
        totalProcessed,
        reductionPct: num(raw.reduction_pct),
        tokensSaved: num(raw.tokens_saved),
        dollarsSaved: num(raw.dollars_saved_session),
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

// ------------------------------------------------------------------ store

const LIVE_WINDOW_MS = 60_000

export class StatsStore {
    readonly storageDirs: string[]

    constructor(storageDirs: string[]) {
        this.storageDirs = storageDirs
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

    async getStats(): Promise<StatsPayload> {
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
                allTime: null,
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
                dollarsSaved: newest.dollarsSaved,
                tools: newest.tools,
            }
        }

        // ---- all-time aggregate
        let allTime: AllTime | null = null
        if (files.length > 0) {
            const toolMap = new Map<string, ToolStat>()
            const acc: AllTime = {
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
                dollarsSaved: 0,
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
                acc.dollarsSaved += f.dollarsSaved
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
            allTime = acc
        }

        // ---- daily series (bucket by session start day)
        const dayMap = new Map<string, DayPoint>()
        for (const f of files) {
            if (f.sessionStart <= 0) continue
            const key = dayKey(f.sessionStart)
            const point = dayMap.get(key) ?? {
                day: key,
                tokensSaved: 0,
                dollarsSaved: 0,
                calls: 0,
                bytesProcessed: 0,
                sessions: 0,
            }
            point.tokensSaved += f.tokensSaved
            point.dollarsSaved += f.dollarsSaved
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
            allTime,
            daily,
        }
    }
}
