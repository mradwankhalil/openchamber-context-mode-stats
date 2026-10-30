/**
 * Runs: one per context-mode MCP server process.
 *
 * The server persists `stats-pid-<ppid>.json` after every tool call; `<ppid>`
 * is the process that launched it (OpenCode, or OpenChamber hosting it). The
 * counters reset whenever that process restarts. Mirrors of the same file in
 * several directories are deduped by pid + start time.
 *
 * Field meanings (context-mode src/server.ts):
 *   bytes_returned  – bytes its tools put into the model's context (measured)
 *   bytes_indexed   – bytes written to the FTS knowledge base (measured)
 *   bytes_sandboxed – bytes sandboxed code read from disk/network (measured,
 *                     but every byte a script touches, e.g. a whole SQLite file)
 *   tokens_saved    – (indexed + sandboxed + cache) / 4: an upper-bound estimate
 *                     that assumes all of that would otherwise have entered context
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { STATS_RE } from "./discover.ts"
import type { RunAggregate, RunSummary, ToolStat } from "./types.ts"

/** A run silent this long is over even if its pid still exists (pids get reused). */
const STALE_MS = 6 * 3_600_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export function parseRunFile(pid: string, raw: unknown, sourceDir: string): RunSummary | null {
    if (!isRecord(raw)) return null
    const startedAt = num(raw.session_start)
    const updatedAt = num(raw.updated_at)
    if (!startedAt && !updatedAt) return null
    const tools: ToolStat[] = []
    if (isRecord(raw.by_tool)) {
        for (const [name, stat] of Object.entries(raw.by_tool)) {
            if (!isRecord(stat)) continue
            tools.push({ name, calls: num(stat.calls), bytes: num(stat.bytes) })
        }
        tools.sort((a, b) => b.calls - a.calls || b.bytes - a.bytes)
    }
    const bytesIndexed = num(raw.bytes_indexed)
    const bytesSandboxed = num(raw.bytes_sandboxed)
    const cacheBytesSaved = num(raw.cache_bytes_saved)
    return {
        key: `${pid}@${startedAt}`,
        pid,
        alive: false,
        startedAt,
        updatedAt,
        uptimeMs: num(raw.uptime_ms) || Math.max(0, updatedAt - startedAt),
        version: typeof raw.version === "string" ? raw.version : null,
        calls: num(raw.total_calls),
        bytesReturned: num(raw.bytes_returned),
        bytesIndexed,
        bytesSandboxed,
        cacheHits: num(raw.cache_hits),
        cacheBytesSaved,
        estTokensSaved: num(raw.tokens_saved) || Math.round((bytesIndexed + bytesSandboxed + cacheBytesSaved) / 4),
        tools,
        sourceDir,
    }
}

/** Does a process with this pid exist? (Signal 0 never delivers.) */
export function pidAlive(pid: string): boolean {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    try {
        process.kill(n, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export function emptyAggregate(): RunAggregate {
    return { runs: 0, calls: 0, bytesReturned: 0, bytesIndexed: 0, bytesSandboxed: 0, cacheHits: 0, cacheBytesSaved: 0, estTokensSaved: 0, tools: [] }
}

export function aggregateRuns(runs: RunSummary[]): RunAggregate {
    const acc = emptyAggregate()
    const tools = new Map<string, ToolStat>()
    for (const r of runs) {
        acc.runs++
        acc.calls += r.calls
        acc.bytesReturned += r.bytesReturned
        acc.bytesIndexed += r.bytesIndexed
        acc.bytesSandboxed += r.bytesSandboxed
        acc.cacheHits += r.cacheHits
        acc.cacheBytesSaved += r.cacheBytesSaved
        acc.estTokensSaved += r.estTokensSaved
        for (const t of r.tools) {
            const e = tools.get(t.name)
            if (e) {
                e.calls += t.calls
                e.bytes += t.bytes
            } else tools.set(t.name, { ...t })
        }
    }
    acc.tools = [...tools.values()].sort((a, b) => b.calls - a.calls || b.bytes - a.bytes)
    return acc
}

export class RunStore {
    private cache = new Map<string, { stamp: string; run: RunSummary | null }>()
    private aliveCache = new Map<string, { at: number; alive: boolean }>()
    /**
     * Every run seen since this service started. Two MCP servers launched by
     * the same parent write the same `stats-pid-<ppid>.json`, each overwriting
     * the other, so a file read only ever shows one of them.
     */
    private seenRuns = new Map<string, RunSummary>()

    read(dirs: string[]): RunSummary[] {
        const byKey = new Map<string, RunSummary>()
        const seen = new Set<string>()
        for (const dir of dirs) {
            let entries: string[] = []
            try {
                entries = fs.readdirSync(dir)
            } catch {
                continue
            }
            for (const name of entries) {
                const m = STATS_RE.exec(name)
                if (!m) continue
                const file = path.join(dir, name)
                seen.add(file)
                const st = fs.statSync(file, { throwIfNoEntry: false })
                if (!st) continue
                const stamp = `${st.size}:${st.mtimeMs}`
                let hit = this.cache.get(file)
                if (!hit || hit.stamp !== stamp) {
                    let run: RunSummary | null = null
                    try {
                        run = parseRunFile(m[1], JSON.parse(fs.readFileSync(file, "utf8")), dir)
                    } catch {
                        run = null
                    }
                    hit = { stamp, run }
                    this.cache.set(file, hit)
                }
                if (!hit.run) continue
                const prev = byKey.get(hit.run.key)
                if (!prev || hit.run.updatedAt > prev.updatedAt) byKey.set(hit.run.key, hit.run)
            }
        }
        for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.cache.delete(file)
        for (const r of byKey.values()) {
            const prev = this.seenRuns.get(r.key)
            if (!prev || r.updatedAt >= prev.updatedAt) this.seenRuns.set(r.key, r)
        }
        for (const [key, r] of this.seenRuns) if (!byKey.has(key)) byKey.set(key, r)

        const now = Date.now()
        const out: RunSummary[] = []
        for (const r of byKey.values()) {
            let alive = false
            if (now - r.updatedAt < STALE_MS) {
                const c = this.aliveCache.get(r.pid)
                if (c && now - c.at < 5000) alive = c.alive
                else {
                    alive = pidAlive(r.pid)
                    this.aliveCache.set(r.pid, { at: now, alive })
                }
            }
            out.push({ ...r, alive, uptimeMs: alive ? Math.max(r.uptimeMs, now - r.startedAt) : r.uptimeMs })
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt)
    }
}

/** The run serving right now: alive and most recently updated. */
export function pickLive(runs: RunSummary[]): RunSummary | null {
    let best: RunSummary | null = null
    for (const r of runs) {
        if (!r.alive) continue
        if (!best || r.updatedAt > best.updatedAt) best = r
    }
    return best
}

/** Every live run, most recently active first. */
export function liveRuns(runs: RunSummary[]): RunSummary[] {
    return runs.filter((r) => r.alive).sort((a, b) => b.updatedAt - a.updatedAt)
}
