/**
 * Knowledge base: context-mode's FTS5 stores (`content/<hash>.db`), one per
 * project. Only the `sources` table is read — what was indexed, when, and how
 * many chunks it produced. Chunk text is never loaded.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { CONTENT_DB_RE } from "./discover.ts"
import { int, sqliteTime, str, tableNames, withDb } from "./sqlite.ts"
import type { KnowledgeDbSummary, KnowledgeSource } from "./types.ts"

/**
 * Source kind from its label. context-mode labels look like
 * `execute:python`, `batch:<labels>`, `file:<name>`, `<name>::https://…`
 * (fetch), `session-events`, or a free label from `ctx_index`.
 */
export function sourceKind(label: string): string {
    if (/::https?:\/\//i.test(label) || /^https?:\/\//i.test(label)) return "fetch"
    const m = /^([a-z][a-z0-9_-]{1,24}):/i.exec(label)
    if (m) {
        const k = m[1].toLowerCase()
        if (k === "execute" || k === "batch" || k === "file" || k === "search" || k === "fetch") return k
        if (k === "session" || k === "session-events" || k === "events") return "session"
    }
    if (/session[-_ ]?events|compaction|resume/i.test(label)) return "session"
    return "index"
}

export interface KnowledgeDb {
    summary: KnowledgeDbSummary
    sources: KnowledgeSource[]
}

export class KnowledgeStore {
    private cache = new Map<string, { stamp: string; db: KnowledgeDb }>()

    read(dirs: string[], projectForHash: (hash: string) => string | null): KnowledgeDb[] {
        const out: KnowledgeDb[] = []
        const seen = new Set<string>()
        for (const dir of dirs) {
            let entries: string[] = []
            try {
                entries = fs.readdirSync(dir)
            } catch {
                continue
            }
            for (const name of entries) {
                if (!CONTENT_DB_RE.test(name)) continue
                const file = path.join(dir, name)
                seen.add(file)
                const st = fs.statSync(file, { throwIfNoEntry: false })
                if (!st) continue
                const wal = fs.statSync(file + "-wal", { throwIfNoEntry: false })
                const stamp = `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`
                let hit = this.cache.get(file)
                if (!hit || hit.stamp !== stamp) {
                    try {
                        hit = { stamp, db: readContentDb(file, (st.size + (wal?.size ?? 0))) }
                    } catch {
                        continue
                    }
                    this.cache.set(file, hit)
                }
                hit.db.summary.projectDir = projectForHash(hit.db.summary.hash)
                out.push(hit.db)
            }
        }
        for (const f of [...this.cache.keys()]) if (!seen.has(f)) this.cache.delete(f)
        return out.sort((a, b) => b.summary.newestAt - a.summary.newestAt)
    }
}

export function readContentDb(file: string, bytes: number): KnowledgeDb {
    const name = path.basename(file)
    const hash = name.replace(/\.db$/, "").split("__")[0]
    return withDb(file, (db) => {
        const sources: KnowledgeSource[] = []
        if (tableNames(db).has("sources")) {
            for (const r of db.prepare("SELECT id, label, chunk_count, code_chunk_count, indexed_at, file_path FROM sources ORDER BY id").all()) {
                const label = str(r.label)
                sources.push({
                    id: int(r.id),
                    label,
                    kind: sourceKind(label),
                    chunks: int(r.chunk_count),
                    codeChunks: int(r.code_chunk_count),
                    indexedAt: sqliteTime(r.indexed_at),
                    filePath: r.file_path == null ? null : str(r.file_path),
                })
            }
        }
        let chunks = 0, codeChunks = 0, newestAt = 0, oldestAt = 0
        for (const s of sources) {
            chunks += s.chunks
            codeChunks += s.codeChunks
            newestAt = Math.max(newestAt, s.indexedAt)
            if (s.indexedAt && (!oldestAt || s.indexedAt < oldestAt)) oldestAt = s.indexedAt
        }
        return {
            summary: { file, dir: path.dirname(file), hash, projectDir: null, bytes, sources: sources.length, chunks, codeChunks, newestAt, oldestAt },
            sources,
        }
    })
}
