import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { discover, listStoreFiles, SESSION_DB_RE } from "../service/discover.ts"
import { addTypes, emptyTally, indexSessionDb, stepCount } from "../service/events.ts"
import { KnowledgeStore } from "../service/knowledge.ts"
import { DEFAULT_SERVICE_SETTINGS } from "../service/settings.ts"
import { int, str, withDb } from "../service/sqlite.ts"

// Schema of context-mode 2.2.0 (PRAGMA user_version 6), trimmed to the tables the service reads.
const V2_SCHEMA = `
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, worktree TEXT NOT NULL, agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prompt','edit','cmd','toolerr','index','cost','decision')), tool TEXT, key TEXT, path TEXT,
  ok INTEGER, exit_code INTEGER, bytes INTEGER, body TEXT, turn INTEGER NOT NULL, sandbox_bytes INTEGER NOT NULL DEFAULT 0,
  returned_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_events_cost_session_turn ON events(session_id, turn) WHERE kind = 'cost';
CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, worktree TEXT NOT NULL, agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('path','content','url')), label TEXT NOT NULL, bytes_total INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL, created_ts INTEGER NOT NULL, created_at TEXT NOT NULL, accessed_ts INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 6;`

const KEY = "0123456789abcdef"
const SES = "ses_v2_main"
const WT = "/work/project-v2"
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0)

let home: string
let projects: string
let dbFile: string

before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cm-v2-"))
    projects = path.join(home, ".context-mode", "projects")
    fs.mkdirSync(path.join(projects, KEY), { recursive: true })
    dbFile = path.join(projects, KEY, "context.db")
    const db = new DatabaseSync(dbFile)
    db.exec(V2_SCHEMA)
    const ins = db.prepare(`INSERT INTO events (session_id, worktree, agent, kind, tool, key, path, ok, body, turn, sandbox_bytes, returned_bytes, created_at, accessed_at)
        VALUES (?, ?, 'opencode', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    const ev = (kind: string, tool: string | null, key: string | null, p: string | null, body: string | null, turn: number, sb: number, rb: number, at: number) =>
        ins.run(SES, WT, kind, tool, key, p, body, turn, sb, rb, at, at)
    ev("prompt", null, null, null, "fix the bug", 1, 0, 0, T0)
    ev("cmd", "Bash", "Bash:git status", null, "clean", 1, 120, 120, T0 + 1_000)
    ev("cmd", "ctx_execute", null, null, "summary", 1, 9_000, 400, T0 + 2_000)
    ev("edit", "Edit", null, "/work/project-v2/a.ts", "ok", 1, 0, 0, T0 + 3_000)
    ev("toolerr", "Bash", "Bash:{}", null, "Exit code 1\nboom", 1, 50, 50, T0 + 4_000)
    ev("cost", null, null, null, null, 1, 0, 0, T0 + 5_000)
    ev("cost", null, null, null, null, 2, 0, 0, T0 + 6_000)
    db.prepare(`INSERT INTO sources (session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts)
        VALUES (?, ?, 'opencode', ?, ?, ?, ?, ?, ?, ?)`).run(SES, WT, "content", "execute:shell", 9_000, 3, T0 + 2_000, new Date(T0 + 2_000).toISOString(), T0 + 2_000)
    db.close()
})

after(() => fs.rmSync(home, { recursive: true, force: true }))

describe("context-mode v2", () => {
    it("auto-detects ~/.context-mode/projects for events and knowledge", () => {
        const report = discover(DEFAULT_SERVICE_SETTINGS.locations, { home, env: {}, platform: "darwin" })
        for (const kind of ["sessions", "content"]) {
            const loc = report.locations.find((l) => l.kind === kind && l.path === projects)
            assert.ok(loc, kind)
            assert.equal(loc.used, true)
            assert.equal(loc.files, 1)
        }
        assert.ok(!report.locations.some((l) => l.kind === "stats" && l.path === projects))
    })

    it("accepts ~/.context-mode as the data root", () => {
        const report = discover({ ...DEFAULT_SERVICE_SETTINGS.locations, dataRoot: path.join(home, ".context-mode") }, { home, env: {}, platform: "linux" })
        assert.ok(report.locations.some((l) => l.kind === "sessions" && l.path === projects && l.used))
    })

    it("lists project DBs one level down and a project folder itself", () => {
        assert.deepEqual(listStoreFiles(projects, SESSION_DB_RE, true), [dbFile])
        assert.deepEqual(listStoreFiles(path.join(projects, KEY), SESSION_DB_RE, true), [dbFile])
        assert.deepEqual(listStoreFiles(projects, SESSION_DB_RE), [])
    })

    it("indexes the events journal as sessions", () => {
        const [s] = indexSessionDb(dbFile)
        assert.equal(s.id, SES)
        assert.equal(s.projectDir, WT)
        assert.equal(s.startedAt, T0)
        assert.equal(s.lastEventAt, T0 + 4_000)
        assert.equal(stepCount(s.steps), 2)
        const t = emptyTally()
        addTypes(t, s.types)
        assert.equal(t.prompts, 1)
        assert.equal(t.fileEdits, 1)
        assert.equal(t.errors, 1)
        assert.equal(s.types.env, 1)
        assert.equal(s.types.tool_call, 1)
    })

    it("maps commands, paths and context savings for detail queries", () => {
        const rows = withDb(dbFile, (db) =>
            db.prepare("SELECT type, data, bytes_avoided a, bytes_returned r FROM session_events WHERE session_id = ? ORDER BY id").all(SES))
        const byType = new Map(rows.map((r) => [str(r.type), r]))
        assert.equal(str(byType.get("env")?.data), "git status")
        assert.equal(str(byType.get("file_edit")?.data), "/work/project-v2/a.ts")
        assert.equal(int(byType.get("tool_call")?.a), 8_600)
        assert.equal(int(byType.get("tool_call")?.r), 400)
    })

    it("reads the v2 sources table as a knowledge base", () => {
        const [kb] = new KnowledgeStore().read([projects], () => WT)
        assert.equal(kb.summary.hash, KEY)
        assert.equal(kb.summary.sources, 1)
        assert.equal(kb.summary.chunks, 3)
        assert.equal(kb.sources[0].kind, "execute")
        assert.equal(kb.sources[0].indexedAt, T0 + 2_000)
    })

    it("leaves the DB file untouched", () => {
        const db = new DatabaseSync(dbFile, { readOnly: true })
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all()
        db.close()
        assert.deepEqual(names, [])
    })
})
