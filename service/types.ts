/**
 * Wire types shared by the service and the panel (type-only imports on the
 * panel side). Every timestamp is epoch milliseconds; every "day" is a local
 * calendar day, YYYY-MM-DD.
 */

// ---------------------------------------------------------------- settings

/** Locations the user pinned in Settings. Empty string / empty list = auto. */
export interface LocationSettings {
    /** context-mode data root override (the CONTEXT_MODE_DATA_DIR equivalent). */
    dataRoot: string
    /** Directories holding session event DBs (`<hash>.db`). */
    sessionDirs: string[]
    /** Directories holding `stats-pid-*.json` run files. */
    statsDirs: string[]
    /** Directories holding knowledge-base DBs (`content/<hash>.db`). */
    contentDirs: string[]
    /** OpenCode's database (`opencode.db`), for titles, models and subagents. */
    opencodeDb: string
}

/** Which sessions count. Sent with every request. */
export interface DataFilterSettings {
    /** Hide sessions whose id does not look like an OpenCode session (`ses_…`). */
    hideSynthetic: boolean
    /** Regex (case-insensitive) — sessions whose project dir matches are hidden. */
    excludeProjects: string
}

export interface PrivacySettings {
    /** Show event text: prompts, errors, decisions, commands. Off = counts only. */
    showContent: boolean
    /** Reduce file and project paths to their last segment. */
    redactPaths: boolean
}

export interface ServiceSettings {
    locations: LocationSettings
    filters: DataFilterSettings
    privacy: PrivacySettings
}

// ------------------------------------------------------------------ filter

export interface QueryFilter {
    /** Inclusive local day. */
    from?: string
    /** Inclusive local day. */
    to?: string
    /** Exact project directory. */
    project?: string
    /** Free text over session title, id and project. */
    q?: string
    /** Include subagent sessions (those with a parent in opencode.db). */
    subagents?: boolean
}

// --------------------------------------------------------------- discovery

export type LocationKind = "sessions" | "stats" | "content" | "opencodeDb"

export interface DiscoveredLocation {
    kind: LocationKind
    path: string
    /** How it was found. */
    origin: "setting" | "data-root" | "auto"
    exists: boolean
    /** Files of the relevant kind. */
    files: number
    bytes: number
    newestMs: number
    used: boolean
    note?: string
}

export interface DiscoveryReport {
    platform: string
    home: string
    locations: DiscoveredLocation[]
    sqlite: { available: boolean; error?: string }
    node: string
}

// ------------------------------------------------------------------ status

export interface IndexProgress {
    phase: "idle" | "scanning" | "ready" | "error"
    done: number
    total: number
    startedAt: number
    finishedAt: number
    error?: string
}

export interface StatusPayload {
    ok: true
    generatedAt: number
    progress: IndexProgress
    discovery: DiscoveryReport
    totals: { sessions: number; events: number; runs: number; knowledgeSources: number }
    live: RunSummary | null
    /** Every live context-mode server (OpenCode can run several at once). */
    liveRuns: RunSummary[]
}

// ----------------------------------------------------------------- session

/** Event-type tallies for one session (or a whole set). */
export interface EventTally {
    events: number
    prompts: number
    errors: number
    errorsResolved: number
    retries: number
    decisions: number
    blockers: number
    blockersResolved: number
    fileReads: number
    fileWrites: number
    fileEdits: number
    fileSearches: number
    gitOps: number
    commits: number
    skills: number
    externalRefs: number
    constraints: number
    compactions: number
    steps: number
}

/** Token usage recorded by context-mode's `agent_usage` events (one per model step). */
export interface Usage {
    steps: number
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    costUsd: number
    /** Largest single-step prompt (input + cache read + cache write) = peak context. */
    peakContext: number
    /** Prompt size of the most recent step. */
    lastContext: number
}

export interface SessionRow {
    id: string
    title: string | null
    projectDir: string
    projectName: string
    parentId: string | null
    agent: string | null
    model: string | null
    startedAt: number
    lastEventAt: number
    activeMs: number
    synthetic: boolean
    tally: EventTally
    usage: Usage
    /** Raw `type → count` for the session. */
    types: Record<string, number>
    resumes: number
    childCount: number
}

export interface SessionsPayload {
    ok: true
    total: number
    offset: number
    rows: SessionRow[]
}

export interface TimelineEvent {
    id: number
    at: number
    type: string
    category: string
    priority: number
    /** Null when the privacy switch hides content. */
    text: string | null
    bytes: number
}

export interface UsagePoint {
    at: number
    context: number
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    costUsd: number
}

export interface RankedItem {
    label: string
    count: number
    /** Optional secondary value (bytes, tokens). */
    value?: number
    hint?: string
}

export interface ResumeSnapshot {
    at: number
    events: number
    consumed: boolean
    bytes: number
    sections: RankedItem[]
}

export interface SessionDetail {
    ok: true
    row: SessionRow
    children: SessionRow[]
    parent: SessionRow | null
    opencode: {
        title: string | null
        tokensInput: number
        tokensOutput: number
        tokensReasoning: number
        tokensCacheRead: number
        tokensCacheWrite: number
        cost: number
        createdAt: number
        updatedAt: number
        summaryFiles: number | null
        summaryAdditions: number | null
        summaryDeletions: number | null
    } | null
    usageSeries: UsagePoint[]
    /** Times (ms) context-mode built a resume snapshot (a compaction it handled). */
    compactions: number[]
    /** Times (ms) the prompt shrank by half or more after a large one (compaction, reset or a smaller side call). */
    contextDrops: number[]
    timeline: TimelineEvent[]
    timelineTotal: number
    files: RankedItem[]
    errors: RankedItem[]
    skills: RankedItem[]
    refs: RankedItem[]
    decisions: TimelineEvent[]
    prompts: TimelineEvent[]
    resumes: ResumeSnapshot[]
    runs: RunSummary[]
    knowledge: KnowledgeDbSummary | null
}

// ---------------------------------------------------------------- overview

export interface DayBucket {
    day: string
    sessions: number
    events: number
    prompts: number
    errors: number
    steps: number
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    costUsd: number
    /** context-mode MCP tool calls started that day (from runs). */
    toolCalls: number
    /** Bytes context-mode tools returned into context that day (from runs). */
    bytesReturned: number
}

export interface ProjectSummary {
    dir: string
    name: string
    sessions: number
    events: number
    steps: number
    tokens: number
    lastEventAt: number
}

export interface OverviewPayload {
    ok: true
    generatedAt: number
    range: { from: string | null; to: string | null; days: number }
    sessions: number
    subagentSessions: number
    projects: number
    tally: EventTally
    usage: Usage
    /** Totals over the same window from run files. */
    runs: RunAggregate
    daily: DayBucket[]
    /** `category → count` over the window. */
    categories: RankedItem[]
    /** 7 × 24 matrix of events by local weekday (0 = Sunday) and hour. */
    hourly: number[][]
    projectsTop: ProjectSummary[]
    heaviest: SessionRow[]
}

// -------------------------------------------------------------------- runs

export interface ToolStat {
    name: string
    calls: number
    /** Bytes the tool returned into the model's context. */
    bytes: number
}

export interface RunSummary {
    key: string
    pid: string
    /** True while the host process that launched context-mode still exists. */
    alive: boolean
    startedAt: number
    updatedAt: number
    uptimeMs: number
    version: string | null
    calls: number
    bytesReturned: number
    bytesIndexed: number
    bytesSandboxed: number
    cacheHits: number
    cacheBytesSaved: number
    /** context-mode's own estimate: (indexed + sandboxed + cache) / 4. */
    estTokensSaved: number
    tools: ToolStat[]
    sourceDir: string
}

export interface RunAggregate {
    runs: number
    calls: number
    bytesReturned: number
    bytesIndexed: number
    bytesSandboxed: number
    cacheHits: number
    cacheBytesSaved: number
    estTokensSaved: number
    tools: ToolStat[]
}

export interface RunsPayload {
    ok: true
    live: RunSummary | null
    liveRuns: RunSummary[]
    aggregate: RunAggregate
    runs: RunSummary[]
    total: number
    daily: { day: string; runs: number; calls: number; bytesReturned: number; bytesIndexed: number; bytesSandboxed: number }[]
    /** Runs whose estimate is dominated by sandbox reads (> 90% of kept-out bytes). */
    sandboxDominated: number
}

// --------------------------------------------------------------- knowledge

export interface KnowledgeSource {
    id: number
    label: string
    kind: string
    chunks: number
    codeChunks: number
    indexedAt: number
    filePath: string | null
}

export interface KnowledgeDbSummary {
    file: string
    dir: string
    hash: string
    projectDir: string | null
    bytes: number
    sources: number
    chunks: number
    codeChunks: number
    newestAt: number
    oldestAt: number
}

export interface KnowledgePayload {
    ok: true
    dbs: KnowledgeDbSummary[]
    totals: { dbs: number; bytes: number; sources: number; chunks: number; codeChunks: number }
    kinds: RankedItem[]
    sources: KnowledgeSource[]
    sourcesTotal: number
    daily: { day: string; sources: number; chunks: number }[]
}

// ---------------------------------------------------------------- insights

export interface InsightsPayload {
    ok: true
    files: RankedItem[]
    errors: RankedItem[]
    skills: RankedItem[]
    refs: RankedItem[]
    commands: RankedItem[]
    retries: RankedItem[]
    intents: RankedItem[]
    models: RankedItem[]
    agents: RankedItem[]
    contentHidden: boolean
}

// ------------------------------------------------------------------- brief

export interface BriefPayload {
    ok: true
    session: SessionRow | null
    /** Last ≤ 40 per-step prompt sizes for a sparkline. */
    contextTrail: number[]
    project: ProjectSummary | null
    live: RunSummary | null
    liveRuns: RunSummary[]
    progress: IndexProgress
}

export interface ErrorPayload {
    ok: false
    error: string
    code?: string
}
