/**
 * Find context-mode's OpenCode stores on this machine.
 *
 * context-mode for OpenCode writes three kinds of files:
 *   - session event DBs   <root>/context-mode/sessions/<hash>[__<wt>].db  (the plugin hooks)
 *   - run stats files     <root>/context-mode/sessions/stats-pid-<ppid>.json (the MCP server)
 *   - knowledge-base DBs  <root>/context-mode/content/<hash>.db             (the MCP server)
 *
 * `<root>` differs by component and OS: the plugin follows OpenCode's config
 * dir (%APPDATA%\opencode on Windows, $XDG_CONFIG_HOME/opencode elsewhere),
 * while the MCP server uses ~/.config/opencode. CONTEXT_MODE_DATA_DIR moves
 * both. The extension's service does not inherit the host environment, so
 * the user's overrides arrive through Settings instead of env vars.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { DiscoveredLocation, DiscoveryReport, LocationKind, LocationSettings } from "./types.ts"
import { sqliteStatus } from "./sqlite.ts"

export const SESSION_DB_RE = /^[0-9a-f]{16}(?:__[0-9a-z]+)?\.db$/i
export const STATS_RE = /^stats-pid-(.+)\.json$/
export const CONTENT_DB_RE = /^[0-9a-f]{16}(?:__[0-9a-z]+)?\.db$/i

export function expandHome(p: string, home = os.homedir()): string {
    const t = p.trim()
    if (t === "~") return home
    if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(home, t.slice(2))
    return t
}

interface Candidate {
    path: string
    origin: DiscoveredLocation["origin"]
    note?: string
}

/** Roots that may contain `context-mode/` for OpenCode, most specific first. */
export function candidateRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): Candidate[] {
    const out: Candidate[] = []
    if (platform === "win32") {
        if (env.APPDATA) out.push({ path: path.join(env.APPDATA, "opencode"), origin: "auto", note: "OpenCode plugin (APPDATA)" })
        out.push({ path: path.join(home, "AppData", "Roaming", "opencode"), origin: "auto", note: "OpenCode plugin (APPDATA)" })
    }
    if (env.XDG_CONFIG_HOME) out.push({ path: path.join(env.XDG_CONFIG_HOME, "opencode"), origin: "auto", note: "XDG_CONFIG_HOME" })
    out.push({ path: path.join(home, ".config", "opencode"), origin: "auto", note: "~/.config (MCP server)" })
    if (platform === "darwin") {
        out.push({ path: path.join(home, "Library", "Application Support", "opencode"), origin: "auto" })
    }
    return dedupe(out)
}

export function candidateOpencodeDbs(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string[] {
    const dirs: string[] = []
    if (env.XDG_DATA_HOME) dirs.push(path.join(env.XDG_DATA_HOME, "opencode"))
    dirs.push(path.join(home, ".local", "share", "opencode"))
    if (platform === "win32") {
        if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "opencode"))
        dirs.push(path.join(home, "AppData", "Local", "opencode"))
    }
    if (platform === "darwin") dirs.push(path.join(home, "Library", "Application Support", "opencode"))
    const files: string[] = []
    for (const dir of [...new Set(dirs)]) {
        let entries: string[] = []
        try {
            entries = fs.readdirSync(dir)
        } catch {
            continue
        }
        for (const name of entries) {
            if (/^opencode(?:-[\w.-]+)?\.db$/.test(name)) files.push(path.join(dir, name))
        }
        if (!entries.length) files.push(path.join(dir, "opencode.db"))
    }
    return [...new Set(files)]
}

function dedupe(list: Candidate[]): Candidate[] {
    const seen = new Set<string>()
    return list.filter((c) => {
        const key = path.resolve(c.path).toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function scanDir(dir: string, re: RegExp): { exists: boolean; files: number; bytes: number; newestMs: number } {
    let entries: string[]
    try {
        entries = fs.readdirSync(dir)
    } catch {
        return { exists: false, files: 0, bytes: 0, newestMs: 0 }
    }
    let files = 0, bytes = 0, newestMs = 0
    for (const name of entries) {
        if (!re.test(name)) continue
        files++
        try {
            const st = fs.statSync(path.join(dir, name))
            bytes += st.size
            newestMs = Math.max(newestMs, st.mtimeMs)
            // WAL files carry the freshest writes.
            const wal = fs.statSync(path.join(dir, name + "-wal"), { throwIfNoEntry: false })
            if (wal) {
                bytes += wal.size
                newestMs = Math.max(newestMs, wal.mtimeMs)
            }
        } catch {
            // vanished between readdir and stat
        }
    }
    return { exists: true, files, bytes, newestMs }
}

function rootFromSetting(p: string, home: string): string {
    const abs = expandHome(p, home)
    // Accept the root itself, `<root>/context-mode`, or a sessions/content dir.
    const base = path.basename(abs).toLowerCase()
    if (base === "sessions" || base === "content") return path.dirname(path.dirname(abs))
    if (base === "context-mode") return path.dirname(abs)
    return abs
}

/**
 * Resolve every location. A pinned setting replaces auto-discovery for its
 * kind; auto-discovery keeps every candidate that exists and holds files.
 */
export function discover(settings: LocationSettings, opts: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {}): DiscoveryReport {
    const env = opts.env ?? process.env
    const home = opts.home ?? os.homedir()
    const platform = opts.platform ?? process.platform
    const locations: DiscoveredLocation[] = []

    const roots: Candidate[] = settings.dataRoot.trim()
        ? [{ path: rootFromSetting(settings.dataRoot, home), origin: "data-root" }]
        : candidateRoots(env, home, platform)

    const add = (kind: LocationKind, c: Candidate, re: RegExp, pinned: boolean) => {
        const s = scanDir(c.path, re)
        locations.push({
            kind,
            path: c.path,
            origin: c.origin,
            exists: s.exists,
            files: s.files,
            bytes: s.bytes,
            newestMs: s.newestMs,
            used: s.exists && (pinned || s.files > 0),
            note: c.note,
        })
    }

    const pinnedOrRoots = (kind: LocationKind, pinned: string[], sub: string, re: RegExp) => {
        const list = pinned.map((p) => p.trim()).filter(Boolean)
        if (list.length) {
            for (const p of list) add(kind, { path: expandHome(p, home), origin: "setting" }, re, true)
            return
        }
        for (const root of roots) add(kind, { ...root, path: path.join(root.path, "context-mode", sub) }, re, root.origin === "data-root")
    }

    pinnedOrRoots("sessions", settings.sessionDirs, "sessions", SESSION_DB_RE)
    pinnedOrRoots("stats", settings.statsDirs, "sessions", STATS_RE)
    pinnedOrRoots("content", settings.contentDirs, "content", CONTENT_DB_RE)

    // opencode.db: the pinned file, else the freshest existing candidate.
    const dbCandidates = settings.opencodeDb.trim()
        ? [{ path: expandHome(settings.opencodeDb, home), origin: "setting" as const }]
        : candidateOpencodeDbs(env, home, platform).map((p) => ({ path: p, origin: "auto" as const }))
    let best = -1
    const dbLocs: DiscoveredLocation[] = dbCandidates.map((c) => {
        const st = fs.statSync(c.path, { throwIfNoEntry: false })
        const wal = st ? fs.statSync(c.path + "-wal", { throwIfNoEntry: false }) : undefined
        return {
            kind: "opencodeDb" as const,
            path: c.path,
            origin: c.origin,
            exists: !!st && st.isFile(),
            files: st ? 1 : 0,
            bytes: (st?.size ?? 0) + (wal?.size ?? 0),
            newestMs: Math.max(st?.mtimeMs ?? 0, wal?.mtimeMs ?? 0),
            used: false,
        }
    })
    dbLocs.forEach((l, i) => {
        if (l.exists && (best < 0 || l.newestMs > dbLocs[best].newestMs)) best = i
    })
    if (best >= 0) dbLocs[best].used = true
    locations.push(...dbLocs)

    return {
        platform,
        home,
        locations,
        sqlite: sqliteStatus(),
        node: process.versions.node,
    }
}

export function usedPaths(report: DiscoveryReport, kind: LocationKind): string[] {
    return report.locations.filter((l) => l.kind === kind && l.used).map((l) => l.path)
}
