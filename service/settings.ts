/** Defaults and validation for the settings the panel sends with each request. */

import type { QueryFilter, ServiceSettings } from "./types.ts"
import { DAY_RE, dayKey, dayStart } from "./util.ts"

/** A real calendar day in YYYY-MM-DD form (rejects 2026-13-99 and 2026-02-30). */
export function isDay(s: string): boolean {
    if (!DAY_RE.test(s)) return false
    const ms = dayStart(s)
    return ms !== null && dayKey(ms) === s
}

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
    locations: { dataRoot: "", sessionDirs: [], statsDirs: [], contentDirs: [], opencodeDb: "" },
    filters: { hideSynthetic: true, excludeProjects: "" },
    privacy: { showContent: true, redactPaths: false },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 1024): string => (typeof v === "string" ? v.slice(0, max) : "")
const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 1024)).filter(Boolean).slice(0, 16) : []
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d)

export function normalizeSettings(raw: unknown): ServiceSettings {
    const d = DEFAULT_SERVICE_SETTINGS
    const r = isRecord(raw) ? raw : {}
    const loc = isRecord(r.locations) ? r.locations : {}
    const fil = isRecord(r.filters) ? r.filters : {}
    const pri = isRecord(r.privacy) ? r.privacy : {}
    return {
        locations: {
            dataRoot: text(loc.dataRoot).trim(),
            sessionDirs: list(loc.sessionDirs),
            statsDirs: list(loc.statsDirs),
            contentDirs: list(loc.contentDirs),
            opencodeDb: text(loc.opencodeDb).trim(),
        },
        filters: {
            hideSynthetic: bool(fil.hideSynthetic, d.filters.hideSynthetic),
            excludeProjects: text(fil.excludeProjects, 512),
        },
        privacy: {
            showContent: bool(pri.showContent, d.privacy.showContent),
            redactPaths: bool(pri.redactPaths, d.privacy.redactPaths),
        },
    }
}

export function normalizeFilter(raw: unknown): QueryFilter {
    const r = isRecord(raw) ? raw : {}
    const f: QueryFilter = {}
    const from = text(r.from, 32), to = text(r.to, 32)
    if (isDay(from)) f.from = from
    if (isDay(to)) f.to = to
    if (typeof r.project === "string" && r.project) f.project = r.project.slice(0, 1024)
    if (typeof r.q === "string" && r.q.trim()) f.q = r.q.trim().slice(0, 200)
    f.subagents = bool(r.subagents, true)
    return f
}

/** Compile the user's exclusion regex; an invalid pattern excludes nothing. */
export function excludeMatcher(pattern: string): ((dir: string) => boolean) | null {
    const p = pattern.trim()
    if (!p) return null
    try {
        const re = new RegExp(p, "i")
        return (dir) => re.test(dir.replace(/\\/g, "/"))
    } catch {
        return null
    }
}
