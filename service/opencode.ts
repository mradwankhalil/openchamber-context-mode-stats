/**
 * Optional enrichment from OpenCode's own database (`opencode.db`): session
 * titles, parent sessions (subagents), agent, model and OpenCode's token and
 * cost totals. OpenCode 1.x keeps sessions in `session`, 2.x in `session_v2`;
 * both are read and 2.x wins. Columns are probed, never assumed.
 */

import * as fs from "node:fs"
import { columnNames, int, str, tableNames, withDb } from "./sqlite.ts"
import type { Db } from "./sqlite.ts"

export interface OcSession {
    id: string
    title: string | null
    parentId: string | null
    projectId: string | null
    directory: string | null
    agent: string | null
    model: string | null
    cost: number
    tokensInput: number
    tokensOutput: number
    tokensReasoning: number
    tokensCacheRead: number
    tokensCacheWrite: number
    createdAt: number
    updatedAt: number
    summaryFiles: number | null
    summaryAdditions: number | null
    summaryDeletions: number | null
}

/** `model` is a plain id in some versions and JSON (`{providerID, modelID}` / `{id}`) in others. */
export function modelLabel(v: unknown): string | null {
    const s = str(v).trim()
    if (!s) return null
    if (s.startsWith("{")) {
        try {
            const o = JSON.parse(s) as Record<string, unknown>
            const id = str(o.modelID ?? o.modelId ?? o.id ?? o.model)
            const provider = str(o.providerID ?? o.providerId ?? o.provider)
            if (id) return provider ? `${provider}/${id}` : id
        } catch {
            return null
        }
        return null
    }
    return s
}

function readTable(db: Db, table: string, out: Map<string, OcSession>): void {
    const cols = columnNames(db, table)
    const pick = (name: string, fallback = "NULL") => (cols.has(name) ? `"${name}"` : fallback)
    const sql = `SELECT id, ${pick("title")} title, ${pick("parent_id")} parent_id, ${pick("project_id")} project_id,
        ${pick("directory")} directory, ${pick("agent")} agent, ${pick("model")} model, ${pick("cost", "0")} cost,
        ${pick("tokens_input", "0")} ti, ${pick("tokens_output", "0")} tout, ${pick("tokens_reasoning", "0")} tr,
        ${pick("tokens_cache_read", "0")} tcr, ${pick("tokens_cache_write", "0")} tcw,
        ${pick("time_created", "0")} tc, ${pick("time_updated", "0")} tu,
        ${pick("summary_files")} sf, ${pick("summary_additions")} sa, ${pick("summary_deletions")} sd
        FROM "${table}"`
    for (const r of db.prepare(sql).all()) {
        const id = str(r.id)
        if (!id) continue
        out.set(id, {
            id,
            title: r.title == null ? null : str(r.title) || null,
            parentId: r.parent_id == null ? null : str(r.parent_id) || null,
            projectId: r.project_id == null ? null : str(r.project_id),
            directory: r.directory == null ? null : str(r.directory),
            agent: r.agent == null ? null : str(r.agent) || null,
            model: modelLabel(r.model),
            cost: Number(r.cost) || 0,
            tokensInput: int(r.ti),
            tokensOutput: int(r.tout),
            tokensReasoning: int(r.tr),
            tokensCacheRead: int(r.tcr),
            tokensCacheWrite: int(r.tcw),
            createdAt: int(r.tc),
            updatedAt: int(r.tu),
            summaryFiles: r.sf == null ? null : int(r.sf),
            summaryAdditions: r.sa == null ? null : int(r.sa),
            summaryDeletions: r.sd == null ? null : int(r.sd),
        })
    }
}

export class OpencodeStore {
    private file = ""
    private stamp = ""
    private sessions = new Map<string, OcSession>()
    error: string | null = null

    /** Re-read when the file or its WAL changed; cheap otherwise. */
    load(file: string | null): Map<string, OcSession> {
        if (!file) {
            this.file = ""
            this.sessions = new Map()
            this.error = null
            return this.sessions
        }
        const st = fs.statSync(file, { throwIfNoEntry: false })
        if (!st) {
            this.sessions = new Map()
            this.error = "not found"
            return this.sessions
        }
        const wal = fs.statSync(file + "-wal", { throwIfNoEntry: false })
        const stamp = `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`
        if (file === this.file && stamp === this.stamp) return this.sessions
        try {
            const next = new Map<string, OcSession>()
            withDb(file, (db) => {
                const tables = tableNames(db)
                if (tables.has("session")) readTable(db, "session", next)
                if (tables.has("session_v2")) readTable(db, "session_v2", next)
            })
            this.sessions = next
            this.error = null
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        }
        this.file = file
        this.stamp = stamp
        return this.sessions
    }
}
