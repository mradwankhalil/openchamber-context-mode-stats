/** Small shared helpers: local days, ranges, names. */

import * as path from "node:path"

/** Local calendar day for an epoch ms. */
export function dayKey(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Local midnight of a YYYY-MM-DD day, or null. */
export function dayStart(day: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!m) return null
    const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    return Number.isFinite(ms) ? ms : null
}

/** Inclusive day range → [startMs, endMsExclusive]. Open ends become ±Infinity. */
export function rangeMs(from?: string, to?: string): [number, number] {
    const a = from ? dayStart(from) : null
    const b = to ? dayStart(to) : null
    return [a ?? -Infinity, b === null ? Infinity : b + 86_400_000]
}

/** Epoch ms → SQLite `datetime('now')`-style UTC text, for range predicates. */
export function sqliteUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ")
}

export function inDayRange(day: string, from?: string, to?: string): boolean {
    if (from && day < from) return false
    if (to && day > to) return false
    return true
}

/** Every day from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string, cap = 3660): string[] {
    const out: string[] = []
    const start = dayStart(from)
    const end = dayStart(to)
    if (start === null || end === null || end < start) return out
    const d = new Date(start)
    while (out.length < cap) {
        const k = dayKey(d.getTime())
        out.push(k)
        if (k >= to) break
        d.setDate(d.getDate() + 1)
    }
    return out
}

/** Friendly project name: last path segment, with OpenChamber chat folders spelled out. */
export function projectName(dir: string): string {
    if (!dir) return "(no project)"
    const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "")
    const chat = /openchamber\/chats\/(\d{4}-\d{2}-\d{2})\/session-([0-9a-f]{6})/i.exec(norm)
    if (chat) return `OpenChamber chat ${chat[1]} · ${chat[2]}`
    if (/openchamber\/chats$/i.test(norm)) return "OpenChamber chats"
    return path.posix.basename(norm) || norm
}

export function redactPath(p: string): string {
    const norm = p.replace(/\\/g, "/")
    const base = norm.split("/").filter(Boolean).pop()
    return base ? `…/${base}` : p
}

export function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
    const n = typeof v === "number" ? v : Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** Await a tick so long scans never starve the HTTP server. */
export const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r))
