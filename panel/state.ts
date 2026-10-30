/** Settings (persisted in OpenChamber extension storage) and transient view state. */

import type { QueryFilter, ServiceSettings } from "../service/types.ts"
import { addDays, localDay } from "./format.ts"

export type View = "sessions" | "insights" | "runs" | "knowledge" | "settings"
export type RangeKey = "today" | "7d" | "30d" | "90d" | "all" | "custom"

export const SESSION_COLUMNS = [
    { id: "last", label: "Last active" },
    { id: "span", label: "Span" },
    { id: "prompts", label: "Prompts" },
    { id: "events", label: "Events" },
    { id: "steps", label: "Model steps" },
    { id: "tokens", label: "Tokens" },
    { id: "peak", label: "Peak context" },
    { id: "errors", label: "Errors" },
    { id: "compactions", label: "Compactions" },
    { id: "cost", label: "Cost" },
] as const
export type ColumnId = (typeof SESSION_COLUMNS)[number]["id"]

export interface DisplaySettings {
    /** Root font size in px. */
    scale: number
    defaultView: Exclude<View, "settings">
    defaultRange: RangeKey
    /** Length of every ranked list (tools, files, projects, errors, sources…). */
    topN: number
    /** Rows per ledger page. */
    pageSize: number
    /** Seconds between refreshes while visible; 0 = manual. */
    refreshSec: number
    /** Show context-mode's own `tokens_saved` estimate (always labelled). */
    showEstimates: boolean
    /** Include subagent sessions in lists and totals. */
    subagents: boolean
    columns: ColumnId[]
    /** Timeline page size in session detail. */
    timelineSize: number
}

export interface UiSettings {
    version: 1
    service: ServiceSettings
    display: DisplaySettings
}

export const DEFAULT_SETTINGS: UiSettings = {
    version: 1,
    service: {
        locations: { dataRoot: "", sessionDirs: [], statsDirs: [], contentDirs: [], opencodeDb: "" },
        filters: { hideSynthetic: true, excludeProjects: "" },
        privacy: { showContent: true, redactPaths: false },
    },
    display: {
        scale: 15,
        defaultView: "sessions",
        defaultRange: "7d",
        topN: 10,
        pageSize: 40,
        refreshSec: 5,
        showEstimates: true,
        subagents: true,
        columns: ["last", "prompts", "steps", "tokens", "peak", "errors"],
        timelineSize: 120,
    },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
const VIEWS = ["sessions", "insights", "runs", "knowledge"] as const
const RANGES: RangeKey[] = ["today", "7d", "30d", "90d", "all", "custom"]

/** Merge stored JSON over the defaults, dropping anything malformed. */
export function normalize(raw: unknown): UiSettings {
    const d = DEFAULT_SETTINGS
    const r = isRecord(raw) ? raw : {}
    const sv = isRecord(r.service) ? r.service : {}
    const loc = isRecord(sv.locations) ? sv.locations : {}
    const fil = isRecord(sv.filters) ? sv.filters : {}
    const pri = isRecord(sv.privacy) ? sv.privacy : {}
    const dp = isRecord(r.display) ? r.display : {}
    const cols = strs(dp.columns).filter((c): c is ColumnId => SESSION_COLUMNS.some((x) => x.id === c))
    return {
        version: 1,
        service: {
            locations: {
                dataRoot: typeof loc.dataRoot === "string" ? loc.dataRoot : "",
                sessionDirs: strs(loc.sessionDirs),
                statsDirs: strs(loc.statsDirs),
                contentDirs: strs(loc.contentDirs),
                opencodeDb: typeof loc.opencodeDb === "string" ? loc.opencodeDb : "",
            },
            filters: {
                hideSynthetic: typeof fil.hideSynthetic === "boolean" ? fil.hideSynthetic : d.service.filters.hideSynthetic,
                excludeProjects: typeof fil.excludeProjects === "string" ? fil.excludeProjects : "",
            },
            privacy: {
                showContent: typeof pri.showContent === "boolean" ? pri.showContent : d.service.privacy.showContent,
                redactPaths: typeof pri.redactPaths === "boolean" ? pri.redactPaths : d.service.privacy.redactPaths,
            },
        },
        display: {
            scale: num(dp.scale, 13, 20, d.display.scale),
            defaultView: (VIEWS as readonly string[]).includes(dp.defaultView as string) ? (dp.defaultView as DisplaySettings["defaultView"]) : d.display.defaultView,
            defaultRange: RANGES.includes(dp.defaultRange as RangeKey) && dp.defaultRange !== "custom" ? (dp.defaultRange as RangeKey) : d.display.defaultRange,
            topN: num(dp.topN, 3, 50, d.display.topN),
            pageSize: num(dp.pageSize, 10, 200, d.display.pageSize),
            refreshSec: num(dp.refreshSec, 0, 600, d.display.refreshSec),
            showEstimates: typeof dp.showEstimates === "boolean" ? dp.showEstimates : d.display.showEstimates,
            subagents: typeof dp.subagents === "boolean" ? dp.subagents : d.display.subagents,
            columns: cols.length ? cols : d.display.columns,
            timelineSize: num(dp.timelineSize, 20, 500, d.display.timelineSize),
        },
    }
}

export interface ViewState {
    view: View
    range: RangeKey
    customFrom: string
    customTo: string
    project: string
    q: string
    sort: string
    dir: "asc" | "desc"
    offset: number
    sessionId: string | null
    timelineTypes: string[]
    timelineOffset: number
    runsOffset: number
    kbOffset: number
    kbSort: "recent" | "chunks"
}

export function initialView(s: UiSettings): ViewState {
    const today = localDay()
    return {
        view: s.display.defaultView,
        range: s.display.defaultRange,
        customFrom: addDays(today, -13),
        customTo: today,
        project: "",
        q: "",
        sort: "last",
        dir: "desc",
        offset: 0,
        sessionId: null,
        timelineTypes: [],
        timelineOffset: 0,
        runsOffset: 0,
        kbOffset: 0,
        kbSort: "recent",
    }
}

export function rangeOf(v: ViewState): { from?: string; to?: string } {
    const today = localDay()
    switch (v.range) {
        case "today": return { from: today, to: today }
        case "7d": return { from: addDays(today, -6), to: today }
        case "30d": return { from: addDays(today, -29), to: today }
        case "90d": return { from: addDays(today, -89), to: today }
        case "custom": return { from: v.customFrom <= v.customTo ? v.customFrom : v.customTo, to: v.customFrom <= v.customTo ? v.customTo : v.customFrom }
        default: return {}
    }
}

export function filterOf(v: ViewState, s: UiSettings): QueryFilter {
    return { ...rangeOf(v), project: v.project || undefined, q: v.q.trim() || undefined, subagents: s.display.subagents }
}

export const RANGE_LABELS: Record<RangeKey, string> = {
    today: "Today", "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time", custom: "Custom",
}

/** Compact labels for the filter bar, so the whole control fits a narrow rail. */
export const RANGE_SHORT: Record<RangeKey, string> = {
    today: "Today", "7d": "7d", "30d": "30d", "90d": "90d", all: "All", custom: "Custom",
}
