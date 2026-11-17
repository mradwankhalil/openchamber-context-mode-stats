/**
 * context-mode v2 compatibility.
 *
 * v2 keeps one SQLite DB per project, `~/.context-mode/projects/<key>/context.db`,
 * shared by every worktree, session and host. Its journal is a single `events`
 * table (kind prompt | edit | cmd | toolerr | index | cost | decision) and its
 * knowledge base a `sources` table with a different shape than v1's.
 *
 * Rather than duplicating every query, a v2 DB gets TEMP views that present it
 * in the v1 shape (`session_events`, `sources`). TEMP objects live in the
 * connection's own temp schema, so the DB file stays untouched and read-only.
 *
 * v2 has no stats-pid files and records no token counts: a `cost` row marks a
 * model step (one per session turn) and becomes a zero-token `agent_usage` event.
 */

import type { Db } from "./sqlite.ts"

export const V2_DB_NAME = "context.db"
export const V2_PROJECT_DIR_RE = /^[0-9a-f]{16}$/i

// v1 timestamps are SQLite `datetime('now')` text (UTC); v2 stores epoch ms.
const TIME = "strftime('%Y-%m-%d %H:%M:%f', e.created_at / 1000.0, 'unixepoch')"

const SESSION_EVENTS_VIEW = `
CREATE TEMP VIEW session_events AS
SELECT e.seq AS id,
       e.session_id,
       CASE e.kind
           WHEN 'prompt' THEN 'user_prompt'
           WHEN 'edit' THEN 'file_edit'
           WHEN 'toolerr' THEN 'error_tool'
           WHEN 'decision' THEN 'decision'
           WHEN 'cost' THEN 'agent_usage'
           WHEN 'index' THEN 'index'
           WHEN 'cmd' THEN CASE WHEN e.tool = 'Bash' THEN 'env' ELSE 'tool_call' END
           ELSE e.kind
       END AS type,
       e.kind AS category,
       0 AS priority,
       CASE
           WHEN e.kind = 'cost' THEN 'tokens_in:0 tokens_out:0'
           WHEN e.kind IN ('edit', 'index') THEN coalesce(e.path, e.key, e.body, '')
           WHEN e.kind = 'cmd' AND e.tool = 'Bash' AND e.key LIKE 'Bash:%' THEN substr(e.key, 6)
           WHEN e.kind = 'cmd' THEN coalesce(e.tool, '')
           ELSE coalesce(e.body, '')
       END AS data,
       e.worktree AS project_dir,
       ${TIME} AS created_at,
       max(0, coalesce(e.sandbox_bytes, 0) - coalesce(e.returned_bytes, 0)) AS bytes_avoided,
       coalesce(e.returned_bytes, 0) AS bytes_returned
FROM main.events e`

const SOURCES_VIEW = `
CREATE TEMP VIEW sources AS
SELECT s.id,
       s.label,
       coalesce(s.chunk_count, 0) AS chunk_count,
       0 AS code_chunk_count,
       strftime('%Y-%m-%d %H:%M:%f', s.created_ts / 1000.0, 'unixepoch') AS indexed_at,
       CASE WHEN s.kind = 'path' THEN s.label END AS file_path
FROM main.sources s`

function mainColumns(db: Db, table: string): Set<string> {
    return new Set(db.prepare(`PRAGMA main.table_info("${table}")`).all().map((r) => String(r.name)))
}

/** Whether `db` is a context-mode v2 project DB. */
export function isV2(db: Db): boolean {
    const cols = mainColumns(db, "events")
    return cols.has("kind") && cols.has("sandbox_bytes") && cols.has("returned_bytes") && mainColumns(db, "session_events").size === 0
}

/** Present a v2 DB in the v1 shape. A no-op for anything else. */
export function adaptV2(db: Db): void {
    if (!isV2(db)) return
    db.exec(SESSION_EVENTS_VIEW)
    if (mainColumns(db, "sources").has("created_ts")) db.exec(SOURCES_VIEW)
}
