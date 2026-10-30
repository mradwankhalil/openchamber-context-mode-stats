/**
 * Builds a throwaway home directory that looks like a machine running OpenCode
 * with context-mode: session event DBs (one session spread over two DBs, with
 * its model steps duplicated the way context-mode writes them), run stats
 * files (including two servers sharing one parent pid), a knowledge-base DB
 * and an OpenCode database. Schemas match context-mode 1.0.x / OpenCode 2.x.
 */

import { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface Fixture {
    home: string
    sessionsDir: string
    statsDir: string
    contentDir: string
    opencodeDb: string
    cleanup(): void
}

const SESSION_SCHEMA = `
CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2, data TEXT NOT NULL, project_dir TEXT NOT NULL DEFAULT '', attribution_source TEXT NOT NULL DEFAULT 'unknown',
  attribution_confidence REAL NOT NULL DEFAULT 0, bytes_avoided INTEGER NOT NULL DEFAULT 0, bytes_returned INTEGER NOT NULL DEFAULT 0,
  source_hook TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), data_hash TEXT NOT NULL DEFAULT '');
CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at TEXT, event_count INTEGER NOT NULL DEFAULT 0, compact_count INTEGER NOT NULL DEFAULT 0, usage_cursor TEXT);
CREATE TABLE session_resume (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tool_calls (session_id TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, bytes_returned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (session_id, tool));`

/** UTC SQLite text for `minutesAgo` minutes before now. */
export function ts(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace("T", " ")
}

export const PROJECT_A = "/work/alpha"
export const PROJECT_B = "/work/beta"
export const SES_MAIN = "ses_main0000000000000000001"
export const SES_CHILD = "ses_child000000000000000002"
export const SES_OTHER = "ses_other000000000000000003"
export const SES_TEST = "test-session-1"

function sessionDb(file: string, dir: string, rows: [sid: string, type: string, data: string, minutesAgo: number][], meta: [sid: string, compact: number][], resume?: [string, string, number]): void {
    const db = new DatabaseSync(file)
    db.exec(SESSION_SCHEMA)
    const ins = db.prepare("INSERT INTO session_events (session_id, type, category, data, project_dir, source_hook, created_at) VALUES (?, ?, ?, ?, ?, 'test', ?)")
    for (const [sid, type, data, m] of rows) ins.run(sid, type, type === "agent_usage" ? "cost" : type, data, dir, ts(m))
    const meta1 = db.prepare("INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, compact_count) VALUES (?, ?, ?, ?, ?)")
    for (const [sid, c] of meta) meta1.run(sid, dir, ts(60), ts(1), c)
    if (resume) db.prepare("INSERT INTO session_resume (session_id, snapshot, event_count, created_at, consumed) VALUES (?, ?, ?, ?, 1)").run(resume[0], resume[1], resume[2], ts(20))
    db.close()
}

const step = (tin: number, tout: number, cr: number, cw = 0, cost = 0) => `tokens_in:${tin} tokens_out:${tout} cache_create:${cw} cache_read:${cr} cost_usd:${cost}`

export function makeFixture(): Fixture {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cm-fixture-"))
    const sessionsDir = path.join(home, "AppData", "Roaming", "opencode", "context-mode", "sessions")
    const statsDir = path.join(home, ".config", "opencode", "context-mode", "sessions")
    const contentDir = path.join(home, ".config", "opencode", "context-mode", "content")
    const dataDir = path.join(home, ".local", "share", "opencode")
    for (const d of [sessionsDir, statsDir, contentDir, dataDir]) fs.mkdirSync(d, { recursive: true })

    // Project A DB: SES_MAIN's real events + three model steps; SES_TEST is synthetic.
    sessionDb(path.join(sessionsDir, "aaaaaaaaaaaaaaaa.db"), PROJECT_A, [
        [SES_MAIN, "user_prompt", "Please fix the login bug", 50],
        [SES_MAIN, "file_read", "/work/alpha/src/login.ts", 49],
        [SES_MAIN, "file_edit", "/work/alpha/src/login.ts", 48],
        [SES_MAIN, "error_tool", "TypeError: x is undefined\n  at line 3", 47],
        [SES_MAIN, "error_resolved", "fixed", 46],
        [SES_MAIN, "decision", "Use the existing session store", 45],
        [SES_MAIN, "env", "npm test -- --watch=false", 44],
        [SES_MAIN, "external_ref", "#12, #34", 43],
        [SES_MAIN, "skill", "test-driven-development", 42],
        [SES_MAIN, "agent_usage", step(100, 50, 10_000, 500, 0.01), 41],
        [SES_MAIN, "agent_usage", step(200, 80, 60_000, 0, 0.02), 40],
        [SES_MAIN, "agent_usage", step(150, 60, 120_000, 0, 0.03), 39],
        [SES_TEST, "user_prompt", "Reply ACK", 30],
    ], [[SES_MAIN, 1], [SES_TEST, 0]], [SES_MAIN, '<session_resume events="9" compact_count="1"><errors count="1"></errors><files count="2"></files>', 9])

    // Worktree DB: the same three steps again (duplicates) + one new step for SES_MAIN, and SES_CHILD.
    sessionDb(path.join(sessionsDir, "aaaaaaaaaaaaaaaa__wt1.db"), `${PROJECT_A}/.worktrees/wt1`, [
        [SES_MAIN, "agent_usage", step(100, 50, 10_000, 500, 0.01), 41],
        [SES_MAIN, "agent_usage", step(200, 80, 60_000, 0, 0.02), 40],
        [SES_MAIN, "agent_usage", step(150, 60, 120_000, 0, 0.03), 39],
        [SES_MAIN, "agent_usage", step(90, 40, 20_000, 0, 0.01), 35],
        [SES_CHILD, "user_prompt", "subtask: write tests", 34],
        [SES_CHILD, "agent_usage", step(10, 5, 1_000), 33],
    ], [[SES_MAIN, 0], [SES_CHILD, 0]])

    // Project B DB, ten days ago.
    sessionDb(path.join(sessionsDir, "bbbbbbbbbbbbbbbb.db"), PROJECT_B, [
        [SES_OTHER, "user_prompt", "Old work", 60 * 24 * 10],
        [SES_OTHER, "git_commit", "Initial commit", 60 * 24 * 10 - 1],
        [SES_OTHER, "agent_usage", step(1000, 100, 0), 60 * 24 * 10 - 2],
    ], [[SES_OTHER, 0]])

    // A file that is not a session DB, and a DB without the table.
    fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "ignore me")
    new DatabaseSync(path.join(sessionsDir, "cccccccccccccccc.db")).close()

    // Run stats: an ended run, and the live process (this test's own pid).
    const now = Date.now()
    const run = (start: number, upd: number, calls: number, extra: Record<string, unknown> = {}) => JSON.stringify({
        schemaVersion: 2, updated_at: upd, session_start: start, uptime_ms: upd - start, total_calls: calls,
        bytes_returned: 4000, bytes_indexed: 1000, bytes_sandboxed: 95_000, cache_hits: 0, cache_bytes_saved: 0,
        kept_out: 96_000, total_processed: 100_000, reduction_pct: 96, tokens_saved: 24_000,
        by_tool: { ctx_execute: { calls: calls - 1, bytes: 3000 }, ctx_search: { calls: 1, bytes: 1000 } }, ...extra,
    })
    fs.writeFileSync(path.join(statsDir, "stats-pid-999999.json"), run(now - 86_400_000 * 2, now - 86_400_000 * 2 + 600_000, 10))
    fs.writeFileSync(path.join(statsDir, `stats-pid-${process.pid}.json`), run(now - 3_600_000, now - 60_000, 7))
    fs.writeFileSync(path.join(statsDir, "stats-pid-broken.json"), "{not json")

    // Knowledge base for project A (same hash as its session DB).
    const kb = new DatabaseSync(path.join(contentDir, "aaaaaaaaaaaaaaaa.db"))
    kb.exec("CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0, code_chunk_count INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL DEFAULT (datetime('now')), file_path TEXT, content_hash TEXT)")
    const src = kb.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, file_path) VALUES (?, ?, ?, ?, ?)")
    src.run("execute:python", 12, 0, ts(30), null)
    src.run("batch:git log,git diff", 4, 1, ts(25), null)
    src.run("React docs::https://react.dev/learn", 30, 20, ts(20), null)
    src.run("file:/work/alpha/README.md", 3, 0, ts(10), "/work/alpha/README.md")
    kb.close()

    // OpenCode 2.x database: titles, parent link, model.
    const opencodeDb = path.join(dataDir, "opencode.db")
    const oc = new DatabaseSync(opencodeDb)
    oc.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT,
        version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
        tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
        agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
    const s2 = oc.prepare("INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated, tokens_input) VALUES (?, 'p', ?, 's', ?, ?, '2.2.0', ?, ?, ?, ?, 450)")
    s2.run(SES_MAIN, null, PROJECT_A, "Fix login bug", "build", '{"providerID":"anthropic","modelID":"claude-test"}', now - 3_600_000, now)
    s2.run(SES_CHILD, SES_MAIN, PROJECT_A, "Write tests", "general", "openai/gpt-test", now - 2_000_000, now)
    oc.close()

    return {
        home, sessionsDir, statsDir, contentDir, opencodeDb,
        cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
    }
}
