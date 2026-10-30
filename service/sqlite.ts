/**
 * Read-only SQLite access through Node's built-in `node:sqlite`.
 *
 * Loaded lazily so the service still starts (and can explain itself) on a
 * runtime without it. Every handle is opened read-only and closed by `withDb`;
 * we never hold a context-mode or OpenCode database open between requests.
 */

import { createRequire } from "node:module"

export interface Statement {
    all(...params: unknown[]): Record<string, unknown>[]
    get(...params: unknown[]): Record<string, unknown> | undefined
}

export interface Db {
    prepare(sql: string): Statement
    close(): void
}

type DatabaseCtor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => Db

let ctor: DatabaseCtor | null = null
let loadError: string | undefined
let attempted = false

function load(): DatabaseCtor | null {
    if (attempted) return ctor
    attempted = true
    try {
        const require = createRequire(import.meta.url)
        const mod = require("node:sqlite") as { DatabaseSync: DatabaseCtor }
        ctor = mod.DatabaseSync
    } catch (error) {
        loadError = error instanceof Error ? error.message : String(error)
    }
    return ctor
}

export function sqliteStatus(): { available: boolean; error?: string } {
    const available = load() !== null
    return available ? { available } : { available, error: loadError }
}

export function openReadonly(file: string): Db {
    const Database = load()
    if (!Database) throw new Error(`node:sqlite is unavailable: ${loadError ?? "unknown"}`)
    return new Database(file, { readOnly: true, timeout: 2000 })
}

/** Open, run `fn`, always close. */
export function withDb<T>(file: string, fn: (db: Db) => T): T {
    const db = openReadonly(file)
    try {
        return fn(db)
    } finally {
        try {
            db.close()
        } catch {
            // already closed
        }
    }
}

export function tableNames(db: Db): Set<string> {
    return new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()
            .map((r) => String(r.name)),
    )
}

export function columnNames(db: Db, table: string): Set<string> {
    return new Set(db.prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all().map((r) => String(r.name)))
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v))
export const int = (v: unknown): number => {
    const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v)
    return Number.isFinite(n) ? n : 0
}

/** SQLite `datetime('now')` text (UTC, no zone) → epoch ms. */
export function sqliteTime(v: unknown): number {
    const s = str(v)
    if (!s) return 0
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + "Z" : s
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : 0
}
