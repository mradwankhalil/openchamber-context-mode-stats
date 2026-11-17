// service/main.ts
import http from "node:http";
import * as path7 from "node:path";

// service/discover.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// service/sqlite.ts
import { createRequire } from "node:module";

// service/v2.ts
var V2_DB_NAME = "context.db";
var V2_PROJECT_DIR_RE = /^[0-9a-f]{16}$/i;
var TIME = "strftime('%Y-%m-%d %H:%M:%f', e.created_at / 1000.0, 'unixepoch')";
var SESSION_EVENTS_VIEW = `
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
FROM main.events e`;
var SOURCES_VIEW = `
CREATE TEMP VIEW sources AS
SELECT s.id,
       s.label,
       coalesce(s.chunk_count, 0) AS chunk_count,
       0 AS code_chunk_count,
       strftime('%Y-%m-%d %H:%M:%f', s.created_ts / 1000.0, 'unixepoch') AS indexed_at,
       CASE WHEN s.kind = 'path' THEN s.label END AS file_path
FROM main.sources s`;
function mainColumns(db, table) {
  return new Set(db.prepare(`PRAGMA main.table_info("${table}")`).all().map((r) => String(r.name)));
}
function isV2(db) {
  const cols = mainColumns(db, "events");
  return cols.has("kind") && cols.has("sandbox_bytes") && cols.has("returned_bytes") && mainColumns(db, "session_events").size === 0;
}
function adaptV2(db) {
  if (!isV2(db))
    return;
  db.exec(SESSION_EVENTS_VIEW);
  if (mainColumns(db, "sources").has("created_ts"))
    db.exec(SOURCES_VIEW);
}

// service/sqlite.ts
var ctor = null;
var loadError;
var attempted = false;
function load() {
  if (attempted)
    return ctor;
  attempted = true;
  try {
    const require2 = createRequire(import.meta.url);
    const mod = require2("node:sqlite");
    ctor = mod.DatabaseSync;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  return ctor;
}
function sqliteStatus() {
  const available = load() !== null;
  return available ? { available } : { available, error: loadError };
}
function openReadonly(file) {
  const Database = load();
  if (!Database)
    throw new Error(`node:sqlite is unavailable: ${loadError ?? "unknown"}`);
  const db = new Database(file, { readOnly: true, timeout: 2000 });
  try {
    adaptV2(db);
  } catch {}
  return db;
}
function withDb(file, fn) {
  const db = openReadonly(file);
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {}
  }
}
function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') UNION SELECT name FROM sqlite_temp_master WHERE type = 'view'").all().map((r) => String(r.name)));
}
function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all().map((r) => String(r.name)));
}
var str = (v) => typeof v === "string" ? v : v == null ? "" : String(v);
var int = (v) => {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
function sqliteTime(v) {
  const s = str(v);
  if (!s)
    return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// service/discover.ts
var SESSION_DB_RE = /^[0-9a-f]{16}(?:__[0-9a-z]+)?\.db$/i;
var STATS_RE = /^stats-pid-(.+)\.json$/;
var CONTENT_DB_RE = /^[0-9a-f]{16}(?:__[0-9a-z]+)?\.db$/i;
function expandHome(p, home = os.homedir()) {
  const t = p.trim();
  if (t === "~")
    return home;
  if (t.startsWith("~/") || t.startsWith("~\\"))
    return path.join(home, t.slice(2));
  return t;
}
function candidateRoots(env = process.env, home = os.homedir(), platform = process.platform) {
  const out = [];
  if (platform === "win32") {
    if (env.APPDATA)
      out.push({ path: path.join(env.APPDATA, "opencode"), origin: "auto", note: "OpenCode plugin (APPDATA)" });
    out.push({ path: path.join(home, "AppData", "Roaming", "opencode"), origin: "auto", note: "OpenCode plugin (APPDATA)" });
  }
  if (env.XDG_CONFIG_HOME)
    out.push({ path: path.join(env.XDG_CONFIG_HOME, "opencode"), origin: "auto", note: "XDG_CONFIG_HOME" });
  out.push({ path: path.join(home, ".config", "opencode"), origin: "auto", note: "~/.config (MCP server)" });
  if (platform === "darwin") {
    out.push({ path: path.join(home, "Library", "Application Support", "opencode"), origin: "auto" });
  }
  return dedupe(out);
}
function candidateOpencodeDbs(env = process.env, home = os.homedir(), platform = process.platform) {
  const dirs = [];
  if (env.XDG_DATA_HOME)
    dirs.push(path.join(env.XDG_DATA_HOME, "opencode"));
  dirs.push(path.join(home, ".local", "share", "opencode"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA)
      dirs.push(path.join(env.LOCALAPPDATA, "opencode"));
    dirs.push(path.join(home, "AppData", "Local", "opencode"));
  }
  if (platform === "darwin")
    dirs.push(path.join(home, "Library", "Application Support", "opencode"));
  const files = [];
  for (const dir of [...new Set(dirs)]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/^opencode(?:-[\w.-]+)?\.db$/.test(name))
        files.push(path.join(dir, name));
    }
    if (!entries.length)
      files.push(path.join(dir, "opencode.db"));
  }
  return [...new Set(files)];
}
function dedupe(list) {
  const seen = new Set;
  return list.filter((c) => {
    const key = path.resolve(c.path).toLowerCase();
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function v2ProjectsDir(home = os.homedir()) {
  return path.join(home, ".context-mode", "projects");
}
function dbHash(file) {
  const name = path.basename(file);
  if (name === V2_DB_NAME)
    return path.basename(path.dirname(file));
  return name.replace(/\.db$/, "").split("__")[0];
}
function listStoreFiles(dir, re, v2 = false) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = [];
  for (const e of entries) {
    if (re.test(e.name) || v2 && e.name === V2_DB_NAME && !e.isDirectory())
      files.push(path.join(dir, e.name));
    else if (v2 && V2_PROJECT_DIR_RE.test(e.name) && e.isDirectory()) {
      const f = path.join(dir, e.name, V2_DB_NAME);
      if (fs.statSync(f, { throwIfNoEntry: false })?.isFile())
        files.push(f);
    }
  }
  return files;
}
function scanDir(dir, re, v2 = false) {
  const list = listStoreFiles(dir, re, v2);
  if (!list)
    return { exists: false, files: 0, bytes: 0, newestMs: 0 };
  let files = 0, bytes = 0, newestMs = 0;
  for (const file of list) {
    files++;
    try {
      const st = fs.statSync(file);
      bytes += st.size;
      newestMs = Math.max(newestMs, st.mtimeMs);
      const wal = fs.statSync(file + "-wal", { throwIfNoEntry: false });
      if (wal) {
        bytes += wal.size;
        newestMs = Math.max(newestMs, wal.mtimeMs);
      }
    } catch {}
  }
  return { exists: true, files, bytes, newestMs };
}
function rootFromSetting(p, home) {
  const abs = expandHome(p, home);
  const base = path.basename(abs).toLowerCase();
  if (base === "sessions" || base === "content")
    return path.dirname(path.dirname(abs));
  if (base === "context-mode")
    return path.dirname(abs);
  return abs;
}
function discover(settings, opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const locations = [];
  const roots = settings.dataRoot.trim() ? [{ path: rootFromSetting(settings.dataRoot, home), origin: "data-root" }] : candidateRoots(env, home, platform);
  const add = (kind, c, re, pinned) => {
    const s = scanDir(c.path, re, kind !== "stats");
    locations.push({
      kind,
      path: c.path,
      origin: c.origin,
      exists: s.exists,
      files: s.files,
      bytes: s.bytes,
      newestMs: s.newestMs,
      used: s.exists && (pinned || s.files > 0),
      note: c.note
    });
  };
  const pinnedOrRoots = (kind, pinned, sub, re) => {
    const list = pinned.map((p) => p.trim()).filter(Boolean);
    if (list.length) {
      for (const p of list)
        add(kind, { path: expandHome(p, home), origin: "setting" }, re, true);
      return;
    }
    for (const root of roots)
      add(kind, { ...root, path: path.join(root.path, "context-mode", sub) }, re, root.origin === "data-root");
    if (kind === "stats")
      return;
    if (settings.dataRoot.trim()) {
      const dir = path.join(roots[0].path, "projects");
      if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
        add(kind, { path: dir, origin: "data-root", note: "context-mode v2" }, re, true);
    } else {
      add(kind, { path: v2ProjectsDir(home), origin: "auto", note: "context-mode v2" }, re, false);
    }
  };
  pinnedOrRoots("sessions", settings.sessionDirs, "sessions", SESSION_DB_RE);
  pinnedOrRoots("stats", settings.statsDirs, "sessions", STATS_RE);
  pinnedOrRoots("content", settings.contentDirs, "content", CONTENT_DB_RE);
  const dbCandidates = settings.opencodeDb.trim() ? [{ path: expandHome(settings.opencodeDb, home), origin: "setting" }] : candidateOpencodeDbs(env, home, platform).map((p) => ({ path: p, origin: "auto" }));
  let best = -1;
  const dbLocs = dbCandidates.map((c) => {
    const st = fs.statSync(c.path, { throwIfNoEntry: false });
    const wal = st ? fs.statSync(c.path + "-wal", { throwIfNoEntry: false }) : undefined;
    return {
      kind: "opencodeDb",
      path: c.path,
      origin: c.origin,
      exists: !!st && st.isFile(),
      files: st ? 1 : 0,
      bytes: (st?.size ?? 0) + (wal?.size ?? 0),
      newestMs: Math.max(st?.mtimeMs ?? 0, wal?.mtimeMs ?? 0),
      used: false
    };
  });
  dbLocs.forEach((l, i) => {
    if (l.exists && (best < 0 || l.newestMs > dbLocs[best].newestMs))
      best = i;
  });
  if (best >= 0)
    dbLocs[best].used = true;
  locations.push(...dbLocs);
  return {
    platform,
    home,
    locations,
    sqlite: sqliteStatus(),
    node: process.versions.node
  };
}
function usedPaths(report, kind) {
  return report.locations.filter((l) => l.kind === kind && l.used).map((l) => l.path);
}

// service/events.ts
import * as fs3 from "node:fs";
import * as path4 from "node:path";

// service/indexcache.ts
import { createHash, randomUUID } from "node:crypto";
import * as fs2 from "node:fs";
import * as fsp from "node:fs/promises";
import * as os2 from "node:os";
import * as path3 from "node:path";

// service/util.ts
import * as path2 from "node:path";
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayStart(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m)
    return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function rangeMs(from, to) {
  const a = from ? dayStart(from) : null;
  const b = to ? dayStart(to) : null;
  return [a ?? -Infinity, b === null ? Infinity : b + 86400000];
}
function sqliteUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
function inDayRange(day, from, to) {
  if (from && day < from)
    return false;
  if (to && day > to)
    return false;
  return true;
}
function daysBetween(from, to, cap = 3660) {
  const out = [];
  const start = dayStart(from);
  const end = dayStart(to);
  if (start === null || end === null || end < start)
    return out;
  const d = new Date(start);
  while (out.length < cap) {
    const k = dayKey(d.getTime());
    out.push(k);
    if (k >= to)
      break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function projectName(dir) {
  if (!dir)
    return "(no project)";
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const chat = /openchamber\/chats\/(\d{4}-\d{2}-\d{2})\/session-([0-9a-f]{6})/i.exec(norm);
  if (chat)
    return `OpenChamber chat ${chat[1]} · ${chat[2]}`;
  if (/openchamber\/chats$/i.test(norm))
    return "OpenChamber chats";
  return path2.posix.basename(norm) || norm;
}
function redactPath(p) {
  const norm = p.replace(/\\/g, "/");
  const base = norm.split("/").filter(Boolean).pop();
  return base ? `…/${base}` : p;
}
function clampInt(v, lo, hi, dflt) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n))
    return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
var yieldTick = () => new Promise((r) => setImmediate(r));

// service/indexcache.ts
var CACHE_FORMAT = "context-mode-stats/event-index";
var CACHE_VERSION = 1;
var BUCKETS = 64;
var MAX_BUCKET_BYTES = 64 * 1024 * 1024;
var STALE_TMP_MS = 60 * 60 * 1000;
var FLUSH_EVERY_MS = 15000;
var RENAME_TRIES = 8;
var DAY_RE2 = /^\d{4}-\d{2}-\d{2}$/;
var B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
var timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
};
function normScopeDir(p) {
  const r = path3.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
function bucketOf(file) {
  const n = createHash("sha256").update(file).digest().readUInt16BE(0) % BUCKETS;
  return `bucket-${n.toString(16).padStart(2, "0")}.json`;
}
function encodeSession(s) {
  return {
    id: s.id,
    projectDir: s.projectDir,
    startedAt: s.startedAt,
    lastEventAt: s.lastEventAt,
    compactions: s.compactions,
    resumes: s.resumes,
    events: s.events,
    types: s.types,
    days: [...s.days].map(([k, d]) => [k, d.types, d.hours]),
    steps: Buffer.from(s.steps.buffer, s.steps.byteOffset, s.steps.byteLength).toString("base64")
  };
}
var num = (v) => typeof v === "number" && Number.isFinite(v);
function counts(v) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return null;
  const out = {};
  for (const [k, c] of Object.entries(v)) {
    if (!num(c))
      return null;
    out[k] = c;
  }
  return out;
}
function decodeSession(v, file) {
  if (!v || typeof v !== "object")
    return null;
  const o = v;
  if (typeof o.id !== "string" || !o.id || typeof o.projectDir !== "string")
    return null;
  if (!num(o.startedAt) || !num(o.lastEventAt) || !num(o.compactions) || !num(o.resumes) || !num(o.events))
    return null;
  const types = counts(o.types);
  if (!types || !Array.isArray(o.days) || typeof o.steps !== "string")
    return null;
  const days = new Map;
  for (const d of o.days) {
    if (!Array.isArray(d) || d.length !== 3 || typeof d[0] !== "string" || !DAY_RE2.test(d[0]))
      return null;
    const dt = counts(d[1]);
    const hours = d[2];
    if (!dt || !Array.isArray(hours) || hours.length !== 24 || !hours.every(num))
      return null;
    days.set(d[0], { types: dt, hours });
  }
  if (o.steps.length % 4 !== 0 || !B64_RE.test(o.steps))
    return null;
  const buf = Buffer.from(o.steps, "base64");
  if (buf.byteLength % 48 !== 0)
    return null;
  const steps = new Float64Array(buf.byteLength / 8);
  new Uint8Array(steps.buffer).set(buf);
  if (!steps.every(Number.isFinite))
    return null;
  return { id: o.id, dbFile: file, projectDir: o.projectDir, startedAt: o.startedAt, lastEventAt: o.lastEventAt, compactions: o.compactions, resumes: o.resumes, events: o.events, types, days, steps };
}
function decodeEntry(file, v) {
  if (!v || typeof v !== "object")
    return null;
  const e = v;
  if (typeof e.stamp !== "string" || !e.stamp || !num(e.savedAt) || !Array.isArray(e.sessions))
    return null;
  const sessions = [];
  for (const s of e.sessions) {
    const d = decodeSession(s, file);
    if (!d)
      return null;
    sessions.push(d);
  }
  return { file, stamp: e.stamp, savedAt: e.savedAt, sessions };
}

class IndexCache {
  dir;
  tz = timeZone();
  endian = os2.endianness();
  own = new Map;
  scope = new Set;
  dirty = new Set;
  flushing = null;
  timer = null;
  lastFlush = 0;
  disposed = false;
  writeErrors = 0;
  constructor(dir) {
    this.dir = dir;
  }
  setScope(dirs) {
    this.own.clear();
    this.dirty.clear();
    this.scope = new Set(dirs.map(normScopeDir));
  }
  inScope(file) {
    return this.scope.has(normScopeDir(path3.dirname(file)));
  }
  header() {
    return { format: CACHE_FORMAT, version: CACHE_VERSION, timeZone: this.tz, endian: this.endian };
  }
  async readBucket(name) {
    const file = path3.join(this.dir, name);
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_BUCKET_BYTES)
        return null;
      const j = JSON.parse(await fsp.readFile(file, "utf8"));
      const h = this.header();
      if (j.format !== h.format || j.version !== h.version || j.timeZone !== h.timeZone || j.endian !== h.endian)
        return null;
      if (!j.entries || typeof j.entries !== "object" || Array.isArray(j.entries))
        return null;
      return j;
    } catch {
      return null;
    }
  }
  async bucketNames() {
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const now = Date.now();
    for (const n of names) {
      if (!n.endsWith(".tmp"))
        continue;
      try {
        const st = await fsp.stat(path3.join(this.dir, n));
        if (now - st.mtimeMs > STALE_TMP_MS)
          await fsp.unlink(path3.join(this.dir, n));
      } catch {}
    }
    return names.filter((n) => /^bucket-[0-9a-f]{2}\.json$/.test(n));
  }
  async load(present) {
    const want = new Set(present);
    const out = new Map;
    for (const name of await this.bucketNames()) {
      if (this.disposed)
        break;
      const b = await this.readBucket(name);
      if (!b) {
        this.dirty.add(name);
        continue;
      }
      for (const [file, raw] of Object.entries(b.entries)) {
        if (bucketOf(file) !== name)
          continue;
        if (!want.has(file)) {
          if (this.inScope(file))
            this.dirty.add(name);
          continue;
        }
        const e = decodeEntry(file, raw);
        if (e)
          out.set(file, e);
        else
          this.dirty.add(name);
      }
      await yieldTick();
    }
    return out;
  }
  adopt(e) {
    this.own.set(e.file, e);
  }
  put(e) {
    if (this.disposed)
      return;
    this.own.set(e.file, e);
    this.dirty.add(bucketOf(e.file));
  }
  remove(file) {
    if (this.disposed)
      return;
    if (this.own.delete(file) || this.inScope(file))
      this.dirty.add(bucketOf(file));
  }
  requestFlush() {
    if (this.disposed || !this.dirty.size || this.timer)
      return;
    const wait = Math.max(0, FLUSH_EVERY_MS - (Date.now() - this.lastFlush));
    if (wait === 0 && !this.flushing) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait || FLUSH_EVERY_MS);
    this.timer.unref?.();
  }
  flush() {
    const run = async () => {
      if (!this.dirty.size)
        return;
      this.lastFlush = Date.now();
      try {
        await fsp.mkdir(this.dir, { recursive: true, mode: 448 });
      } catch {
        this.writeErrors++;
        return;
      }
      const names = [...this.dirty];
      this.dirty.clear();
      for (const name of names)
        await this.writeBucket(name);
    };
    const next = (this.flushing ?? Promise.resolve()).then(run, run);
    const tracked = next.finally(() => {
      if (this.flushing === tracked)
        this.flushing = null;
    });
    this.flushing = tracked;
    return tracked;
  }
  async writeBucket(name) {
    const entries = {};
    const current = await this.readBucket(name);
    if (current) {
      for (const [file, raw] of Object.entries(current.entries)) {
        if (this.own.has(file) || this.inScope(file) || bucketOf(file) !== name)
          continue;
        if (fs2.existsSync(file))
          entries[file] = raw;
      }
    }
    for (const e of this.own.values()) {
      if (bucketOf(e.file) !== name)
        continue;
      entries[e.file] = { stamp: e.stamp, savedAt: e.savedAt, sessions: e.sessions.map(encodeSession) };
    }
    const target = path3.join(this.dir, name);
    if (!Object.keys(entries).length) {
      await fsp.rm(target, { force: true }).catch(() => {
        return;
      });
      return;
    }
    const body = JSON.stringify({ ...this.header(), entries });
    if (body.length > MAX_BUCKET_BYTES) {
      this.writeErrors++;
      return;
    }
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, body, { encoding: "utf8", mode: 384, flag: "wx" });
      for (let i = 0;; i++) {
        try {
          await fsp.rename(tmp, target);
          return;
        } catch (error) {
          const code = error.code;
          if (i >= RENAME_TRIES || !(code === "EPERM" || code === "EACCES" || code === "EBUSY"))
            throw error;
          await new Promise((r) => setTimeout(r, 15 * (i + 1)));
        }
      }
    } catch {
      this.writeErrors++;
      await fsp.rm(tmp, { force: true }).catch(() => {
        return;
      });
    }
  }
  async dispose() {
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) {
      await this.flushing;
      return;
    }
    await this.flush();
    this.disposed = true;
  }
}

// service/events.ts
var STEP_STRIDE = 6;
var USAGE_RE = /(tokens_in|tokens_out|cache_create|cache_read|cost_usd):\s*([0-9.eE+-]+)/g;
function parseUsage(data) {
  let found = false;
  const u = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  USAGE_RE.lastIndex = 0;
  let m;
  while (m = USAGE_RE.exec(data)) {
    const v = Number(m[2]);
    if (!Number.isFinite(v))
      continue;
    found = true;
    if (m[1] === "tokens_in")
      u.tokensIn = v;
    else if (m[1] === "tokens_out")
      u.tokensOut = v;
    else if (m[1] === "cache_create")
      u.cacheWrite = v;
    else if (m[1] === "cache_read")
      u.cacheRead = v;
    else
      u.costUsd = v;
  }
  return found ? u : null;
}
var promptSize = (u) => u.tokensIn + u.cacheRead + u.cacheWrite;
function stepAt(steps, i) {
  const o = i * STEP_STRIDE;
  return { at: steps[o], u: { tokensIn: steps[o + 1], tokensOut: steps[o + 2], cacheRead: steps[o + 3], cacheWrite: steps[o + 4], costUsd: steps[o + 5] } };
}
var stepCount = (steps) => steps.length / STEP_STRIDE;
function emptyUsage() {
  return { steps: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, peakContext: 0, lastContext: 0 };
}
function addStep(u, s) {
  u.steps++;
  u.tokensIn += s.tokensIn;
  u.tokensOut += s.tokensOut;
  u.cacheRead += s.cacheRead;
  u.cacheWrite += s.cacheWrite;
  u.costUsd += s.costUsd;
  const p = promptSize(s);
  u.peakContext = Math.max(u.peakContext, p);
  u.lastContext = p;
}
function mergeUsage(into, u) {
  into.steps += u.steps;
  into.tokensIn += u.tokensIn;
  into.tokensOut += u.tokensOut;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  into.costUsd += u.costUsd;
  into.peakContext = Math.max(into.peakContext, u.peakContext);
  into.lastContext = u.lastContext || into.lastContext;
}
function emptyTally() {
  return {
    events: 0,
    prompts: 0,
    errors: 0,
    errorsResolved: 0,
    retries: 0,
    decisions: 0,
    blockers: 0,
    blockersResolved: 0,
    fileReads: 0,
    fileWrites: 0,
    fileEdits: 0,
    fileSearches: 0,
    gitOps: 0,
    commits: 0,
    skills: 0,
    externalRefs: 0,
    constraints: 0,
    compactions: 0,
    steps: 0
  };
}
function addTypes(t, types) {
  for (const [type, c] of Object.entries(types)) {
    t.events += c;
    switch (type) {
      case "user_prompt":
        t.prompts += c;
        break;
      case "error_tool":
        t.errors += c;
        break;
      case "error_resolved":
        t.errorsResolved += c;
        break;
      case "retry_detected":
        t.retries += c;
        break;
      case "decision":
        t.decisions += c;
        break;
      case "blocker":
        t.blockers += c;
        break;
      case "blocker_resolved":
        t.blockersResolved += c;
        break;
      case "file_read":
        t.fileReads += c;
        break;
      case "file_write":
        t.fileWrites += c;
        break;
      case "file_edit":
        t.fileEdits += c;
        break;
      case "file_search":
      case "file_glob":
        t.fileSearches += c;
        break;
      case "git":
        t.gitOps += c;
        break;
      case "git_commit":
        t.commits += c;
        t.gitOps += c;
        break;
      case "skill":
        t.skills += c;
        break;
      case "external_ref":
        t.externalRefs += c;
        break;
      case "constraint_discovered":
        t.constraints += c;
        break;
      case "compaction_summary":
        t.compactions += c;
        break;
      case "agent_usage":
        t.steps += c;
        break;
    }
  }
}
function typeGroup(type) {
  if (type === "agent_usage")
    return "model steps";
  if (type === "user_prompt" || type === "intent" || type === "role" || type === "data")
    return "prompts & intent";
  if (type.startsWith("file_"))
    return "files";
  if (type.startsWith("error") || type === "retry_detected")
    return "errors & retries";
  if (type === "decision" || type.startsWith("blocker") || type === "constraint_discovered")
    return "decisions & constraints";
  if (type.startsWith("git"))
    return "git";
  if (type === "skill" || type === "rule" || type === "rule_content")
    return "skills & rules";
  if (type === "external_ref")
    return "references";
  if (type === "env" || type === "cwd" || type === "bash_outcome")
    return "shell & env";
  if (type.includes("compaction") || type.includes("snapshot"))
    return "compaction";
  return "other";
}
function fileStat(file) {
  const st = fs3.statSync(file, { throwIfNoEntry: false });
  if (!st)
    return null;
  const wal = fs3.statSync(file + "-wal", { throwIfNoEntry: false });
  return { stamp: `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`, mtime: Math.max(st.mtimeMs, wal?.mtimeMs ?? 0) };
}
function indexSessionDb(file) {
  return withDb(file, (db) => readSessions(db, file));
}
function readSessions(db, file) {
  const tables = tableNames(db);
  if (!tables.has("session_events"))
    return [];
  const sessions = new Map;
  const stepLists = new Map;
  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { id, dbFile: file, projectDir: "", startedAt: 0, lastEventAt: 0, compactions: 0, resumes: 0, events: 0, types: {}, days: new Map, steps: new Float64Array(0) };
      sessions.set(id, s);
    }
    return s;
  };
  if (tables.has("session_meta")) {
    for (const r of db.prepare("SELECT session_id, project_dir, started_at, last_event_at, compact_count FROM session_meta").all()) {
      const s = get(str(r.session_id));
      s.projectDir = str(r.project_dir);
      s.startedAt = sqliteTime(r.started_at);
      s.lastEventAt = sqliteTime(r.last_event_at);
      s.compactions = int(r.compact_count);
    }
  }
  const rows = db.prepare(`SELECT session_id sid, date(created_at,'localtime') d, CAST(strftime('%H',created_at,'localtime') AS INTEGER) h,
                type, count(*) c, min(created_at) a, max(created_at) b, max(project_dir) p
         FROM session_events WHERE type != 'agent_usage' GROUP BY 1,2,3,4`).all();
  for (const r of rows) {
    const s = get(str(r.sid));
    const type = str(r.type);
    const c = int(r.c);
    s.events += c;
    s.types[type] = (s.types[type] ?? 0) + c;
    const dk = str(r.d);
    let d = s.days.get(dk);
    if (!d)
      s.days.set(dk, d = { types: {}, hours: new Array(24).fill(0) });
    d.types[type] = (d.types[type] ?? 0) + c;
    const h = int(r.h);
    if (h >= 0 && h < 24)
      d.hours[h] += c;
    const a = sqliteTime(r.a), b = sqliteTime(r.b);
    if (a && (!s.startedAt || a < s.startedAt))
      s.startedAt = a;
    if (b > s.lastEventAt)
      s.lastEventAt = b;
    if (!s.projectDir && r.p)
      s.projectDir = str(r.p);
  }
  for (const r of db.prepare("SELECT session_id sid, created_at at, data FROM session_events WHERE type = 'agent_usage' ORDER BY id").all()) {
    const at = sqliteTime(r.at);
    const u = parseUsage(str(r.data));
    if (!at || !u)
      continue;
    const sid = str(r.sid);
    get(sid);
    let list = stepLists.get(sid);
    if (!list)
      stepLists.set(sid, list = []);
    list.push(at, u.tokensIn, u.tokensOut, u.cacheRead, u.cacheWrite, u.costUsd);
  }
  for (const [sid, list] of stepLists)
    get(sid).steps = Float64Array.from(list);
  if (tables.has("session_resume")) {
    for (const r of db.prepare("SELECT session_id sid, count(*) c FROM session_resume GROUP BY 1").all())
      get(str(r.sid)).resumes = int(r.c);
  }
  return [...sessions.values()];
}
function mergeSession(parts) {
  const ordered = [...parts].sort((a, b) => b.events - a.events || (a.startedAt || Infinity) - (b.startedAt || Infinity) || (a.dbFile < b.dbFile ? -1 : a.dbFile > b.dbFile ? 1 : 0));
  const home = ordered[0];
  const types = {};
  const days = new Map;
  const dayOf = (k) => {
    let d = days.get(k);
    if (!d)
      days.set(k, d = { day: k, types: {}, hours: new Array(24).fill(0), usage: emptyUsage() });
    return d;
  };
  let startedAt = 0, lastEventAt = 0, compactions = 0, resumes = 0;
  for (const p of parts) {
    for (const [t, c] of Object.entries(p.types))
      types[t] = (types[t] ?? 0) + c;
    for (const [k, d] of p.days) {
      const into = dayOf(k);
      for (const [t, c] of Object.entries(d.types))
        into.types[t] = (into.types[t] ?? 0) + c;
      d.hours.forEach((c, h) => into.hours[h] += c);
    }
    if (p.startedAt && (!startedAt || p.startedAt < startedAt))
      startedAt = p.startedAt;
    lastEventAt = Math.max(lastEventAt, p.lastEventAt);
    compactions = Math.max(compactions, p.compactions);
    resumes += p.resumes;
  }
  const seen = new Set;
  const merged = [];
  const all = ordered.map((p) => p.steps);
  for (const steps of all) {
    for (let o = 0;o < steps.length; o += STEP_STRIDE) {
      const key = `${steps[o]}|${steps[o + 1]}|${steps[o + 2]}|${steps[o + 3]}|${steps[o + 4]}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      for (let k = 0;k < STEP_STRIDE; k++)
        merged.push(steps[o + k]);
    }
  }
  const n = merged.length / STEP_STRIDE;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => merged[a * STEP_STRIDE] - merged[b * STEP_STRIDE]);
  const steps = new Float64Array(merged.length);
  order.forEach((src, i) => {
    for (let k = 0;k < STEP_STRIDE; k++)
      steps[i * STEP_STRIDE + k] = merged[src * STEP_STRIDE + k];
  });
  const usage = emptyUsage();
  for (let i = 0;i < n; i++) {
    const { at, u } = stepAt(steps, i);
    addStep(usage, u);
    const d = dayOf(dayKey(at));
    addStep(d.usage, u);
    d.types.agent_usage = (d.types.agent_usage ?? 0) + 1;
    d.hours[new Date(at).getHours()]++;
    if (!startedAt || at < startedAt)
      startedAt = at;
    if (at > lastEventAt)
      lastEventAt = at;
  }
  if (n)
    types.agent_usage = n;
  else
    delete types.agent_usage;
  return {
    id: home.id,
    dbFiles: ordered.map((p) => p.dbFile),
    dbFile: home.dbFile,
    projectDir: home.projectDir || ordered.find((p) => p.projectDir)?.projectDir || "",
    startedAt,
    lastEventAt,
    compactions,
    resumes,
    types,
    usage,
    days,
    steps
  };
}
var hashOf = dbHash;

class EventIndex {
  dbs = new Map;
  running = null;
  runningGen = -1;
  gen = 0;
  dirsKey = "";
  merged = new Map;
  dirty = new Set;
  list = null;
  cache;
  reader;
  sliceMs;
  cacheLoaded = false;
  disposed = false;
  useful;
  lastRefresh = 0;
  progress = { phase: "idle", done: 0, total: 0, startedAt: 0, finishedAt: 0 };
  version = 0;
  initialDone = false;
  constructor(opts = {}) {
    this.cache = opts.cacheDir ? new IndexCache(opts.cacheDir) : null;
    this.reader = opts.reader ?? indexSessionDb;
    this.sliceMs = Math.max(0, opts.sliceMs ?? 30);
    this.useful = deferred();
  }
  refresh(dirs) {
    const key = dirs.join("|");
    if (key !== this.dirsKey) {
      this.dirsKey = key;
      this.gen++;
      this.dbs.clear();
      this.merged.clear();
      this.dirty.clear();
      this.list = null;
      this.initialDone = false;
      this.cacheLoaded = false;
      this.useful.resolve();
      this.useful = deferred();
      this.progress = { phase: "idle", done: 0, total: 0, startedAt: 0, finishedAt: 0 };
      this.version++;
    }
    if (this.disposed)
      return Promise.resolve();
    if (this.running && this.runningGen === this.gen)
      return this.running;
    const gen = this.gen;
    const p = (this.running ?? Promise.resolve()).catch(() => {
      return;
    }).then(() => this.run(dirs, gen)).finally(() => {
      if (this.running === p)
        this.running = null;
      this.lastRefresh = Date.now();
      if (gen === this.gen)
        this.useful.resolve();
    });
    this.running = p;
    this.runningGen = gen;
    return p;
  }
  get busy() {
    return this.running !== null;
  }
  whenUseful() {
    return this.initialDone ? Promise.resolve() : this.useful.promise;
  }
  async dispose() {
    this.disposed = true;
    await this.running?.catch(() => {
      return;
    });
    await this.cache?.dispose();
  }
  live(gen) {
    return !this.disposed && gen === this.gen;
  }
  async run(dirs, gen) {
    if (!this.live(gen))
      return;
    const files = [];
    for (const dir of dirs)
      files.push(...listStoreFiles(dir, SESSION_DB_RE, true) ?? []);
    let cached = 0;
    if (!this.cacheLoaded) {
      this.cacheLoaded = true;
      if (this.cache) {
        this.progress = { phase: "loading", done: 0, total: 0, startedAt: Date.now(), finishedAt: 0 };
        this.cache.setScope(dirs);
        const loaded = await this.cache.load(files);
        if (!this.live(gen))
          return;
        for (const e of loaded.values()) {
          this.cache.adopt(e);
          this.dbs.set(e.file, { file: e.file, hash: hashOf(e.file), stamp: e.stamp, sessions: e.sessions, savedAt: e.savedAt, saved: true });
          for (const s of e.sessions)
            this.dirty.add(s.id);
        }
        if (loaded.size)
          this.bump();
      }
    }
    const initial = !this.initialDone;
    const changed = [];
    let slice = performance.now();
    for (const file of files) {
      const st = fileStat(file);
      if (!st)
        continue;
      const prev = this.dbs.get(file);
      if (prev?.stamp !== st.stamp)
        changed.push({ file, ...st });
      else if (initial && prev?.saved)
        cached++;
      if (performance.now() - slice >= Math.max(this.sliceMs, 5)) {
        await yieldTick();
        if (!this.live(gen))
          return;
        slice = performance.now();
      }
    }
    const present = new Set(files);
    let removed = false;
    for (const [file, db] of [...this.dbs]) {
      if (present.has(file))
        continue;
      for (const s of db.sessions)
        this.dirty.add(s.id);
      this.dbs.delete(file);
      this.cache?.remove(file);
      removed = true;
    }
    if (!changed.length) {
      if (removed)
        this.bump();
      if (initial)
        this.finish(files.length, cached);
      this.save(initial);
      return;
    }
    changed.sort((a, b) => b.mtime - a.mtime);
    let stale = 0;
    let savedAt = 0;
    for (const c of changed) {
      const prev = this.dbs.get(c.file);
      if (prev?.saved) {
        stale++;
        savedAt = savedAt ? Math.min(savedAt, prev.savedAt ?? 0) : prev.savedAt ?? 0;
      }
    }
    if (initial) {
      this.progress = {
        phase: "scanning",
        done: 0,
        total: changed.length,
        startedAt: this.progress.startedAt || Date.now(),
        finishedAt: 0,
        cached,
        stale,
        savedAt: stale ? savedAt : 0
      };
    }
    let i = 0;
    slice = performance.now();
    for (const { file, stamp } of changed) {
      if (!this.live(gen))
        return;
      const prev = this.dbs.get(file);
      if (prev)
        for (const s of prev.sessions)
          this.dirty.add(s.id);
      let reread = false;
      try {
        const sessions = this.reader(file);
        reread = true;
        for (const s of sessions)
          this.dirty.add(s.id);
        this.dbs.set(file, { file, hash: hashOf(file), stamp, sessions });
        this.cache?.put({ file, stamp, savedAt: Date.now(), sessions });
      } catch (error) {
        this.dbs.set(file, { file, hash: hashOf(file), stamp: "", sessions: prev?.sessions ?? [], savedAt: prev?.savedAt, saved: prev?.saved, error: error instanceof Error ? error.message : String(error) });
      }
      i++;
      if (initial) {
        this.progress.done = i;
        if (reread && prev?.saved && this.progress.stale)
          this.progress.stale--;
        if (!this.progress.stale)
          this.progress.savedAt = 0;
      }
      if (performance.now() - slice >= this.sliceMs) {
        if (initial)
          this.bump();
        this.useful.resolve();
        this.cache?.requestFlush();
        await yieldTick();
        slice = performance.now();
      }
    }
    this.bump();
    if (initial)
      this.finish(files.length, cached);
    this.save(initial);
  }
  save(now) {
    if (now)
      this.cache?.flush();
    else
      this.cache?.requestFlush();
  }
  finish(total, cached) {
    this.initialDone = true;
    this.progress = { phase: "ready", done: total, total, startedAt: this.progress.startedAt, finishedAt: Date.now(), cached, stale: 0, savedAt: 0 };
    this.useful.resolve();
  }
  bump() {
    this.version++;
    this.list = null;
  }
  sessions() {
    if (this.list && !this.dirty.size)
      return this.list;
    if (this.dirty.size) {
      const parts = new Map;
      for (const db of this.dbs.values()) {
        for (const s of db.sessions) {
          if (!this.dirty.has(s.id))
            continue;
          const l = parts.get(s.id);
          if (l)
            l.push(s);
          else
            parts.set(s.id, [s]);
        }
      }
      for (const id of this.dirty) {
        const p = parts.get(id);
        if (p)
          this.merged.set(id, mergeSession(p));
        else
          this.merged.delete(id);
      }
      this.dirty.clear();
    }
    this.list = [...this.merged.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return this.list;
  }
  get(id) {
    this.sessions();
    return this.merged.get(id);
  }
  projectForHash(hash) {
    const rank = (db) => path4.basename(db.file) === `${hash}.db` ? "" : path4.basename(db.file);
    const candidates = [...this.dbs.values()].filter((db) => db.hash === hash).sort((a, b) => rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0);
    for (const db of candidates) {
      const best = [...db.sessions].sort((a, b) => b.events - a.events).find((s) => s.projectDir);
      if (best)
        return best.projectDir;
    }
    return null;
  }
  errors() {
    return [...this.dbs.values()].filter((d) => d.error).map((d) => ({ file: d.file, error: d.error }));
  }
}
function deferred() {
  let resolve = () => {
    return;
  };
  const promise = new Promise((r) => resolve = r);
  return { promise, resolve };
}

// service/knowledge.ts
import * as fs4 from "node:fs";
import * as path5 from "node:path";
function sourceKind(label) {
  if (/::https?:\/\//i.test(label) || /^https?:\/\//i.test(label))
    return "fetch";
  const m = /^([a-z][a-z0-9_-]{1,24}):/i.exec(label);
  if (m) {
    const k = m[1].toLowerCase();
    if (k === "execute" || k === "batch" || k === "file" || k === "search" || k === "fetch")
      return k;
    if (k === "session" || k === "session-events" || k === "events")
      return "session";
  }
  if (/session[-_ ]?events|compaction|resume/i.test(label))
    return "session";
  return "index";
}

class KnowledgeStore {
  cache = new Map;
  read(dirs, projectForHash) {
    const out = [];
    const seen = new Set;
    for (const dir of dirs) {
      for (const file of listStoreFiles(dir, CONTENT_DB_RE, true) ?? []) {
        if (seen.has(file))
          continue;
        seen.add(file);
        const st = fs4.statSync(file, { throwIfNoEntry: false });
        if (!st)
          continue;
        const wal = fs4.statSync(file + "-wal", { throwIfNoEntry: false });
        const stamp = `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
        let hit = this.cache.get(file);
        if (!hit || hit.stamp !== stamp) {
          try {
            hit = { stamp, db: readContentDb(file, st.size + (wal?.size ?? 0)) };
          } catch {
            continue;
          }
          this.cache.set(file, hit);
        }
        hit.db.summary.projectDir = projectForHash(hit.db.summary.hash);
        out.push(hit.db);
      }
    }
    for (const f of [...this.cache.keys()])
      if (!seen.has(f))
        this.cache.delete(f);
    return out.sort((a, b) => b.summary.newestAt - a.summary.newestAt);
  }
}
function readContentDb(file, bytes) {
  const hash = dbHash(file);
  return withDb(file, (db) => {
    const sources = [];
    if (tableNames(db).has("sources")) {
      for (const r of db.prepare("SELECT id, label, chunk_count, code_chunk_count, indexed_at, file_path FROM sources ORDER BY id").all()) {
        const label = str(r.label);
        sources.push({
          id: int(r.id),
          label,
          kind: sourceKind(label),
          chunks: int(r.chunk_count),
          codeChunks: int(r.code_chunk_count),
          indexedAt: sqliteTime(r.indexed_at),
          filePath: r.file_path == null ? null : str(r.file_path)
        });
      }
    }
    let chunks = 0, codeChunks = 0, newestAt = 0, oldestAt = 0;
    for (const s of sources) {
      chunks += s.chunks;
      codeChunks += s.codeChunks;
      newestAt = Math.max(newestAt, s.indexedAt);
      if (s.indexedAt && (!oldestAt || s.indexedAt < oldestAt))
        oldestAt = s.indexedAt;
    }
    return {
      summary: { file, dir: path5.dirname(file), hash, projectDir: null, bytes, sources: sources.length, chunks, codeChunks, newestAt, oldestAt },
      sources
    };
  });
}

// service/opencode.ts
import * as fs5 from "node:fs";
function modelLabel(v) {
  const s = str(v).trim();
  if (!s)
    return null;
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      const id = str(o.modelID ?? o.modelId ?? o.id ?? o.model);
      const provider = str(o.providerID ?? o.providerId ?? o.provider);
      if (id)
        return provider ? `${provider}/${id}` : id;
    } catch {
      return null;
    }
    return null;
  }
  return s;
}
function readTable(db, table, out) {
  const cols = columnNames(db, table);
  const pick = (name, fallback = "NULL") => cols.has(name) ? `"${name}"` : fallback;
  const sql = `SELECT id, ${pick("title")} title, ${pick("parent_id")} parent_id, ${pick("project_id")} project_id,
        ${pick("directory")} directory, ${pick("agent")} agent, ${pick("model")} model, ${pick("cost", "0")} cost,
        ${pick("tokens_input", "0")} ti, ${pick("tokens_output", "0")} tout, ${pick("tokens_reasoning", "0")} tr,
        ${pick("tokens_cache_read", "0")} tcr, ${pick("tokens_cache_write", "0")} tcw,
        ${pick("time_created", "0")} tc, ${pick("time_updated", "0")} tu,
        ${pick("summary_files")} sf, ${pick("summary_additions")} sa, ${pick("summary_deletions")} sd
        FROM "${table}"`;
  for (const r of db.prepare(sql).all()) {
    const id = str(r.id);
    if (!id)
      continue;
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
      summaryDeletions: r.sd == null ? null : int(r.sd)
    });
  }
}

class OpencodeStore {
  file = "";
  stamp = "";
  sessions = new Map;
  error = null;
  load(file) {
    if (!file) {
      this.file = "";
      this.sessions = new Map;
      this.error = null;
      return this.sessions;
    }
    const st = fs5.statSync(file, { throwIfNoEntry: false });
    if (!st) {
      this.sessions = new Map;
      this.error = "not found";
      return this.sessions;
    }
    const wal = fs5.statSync(file + "-wal", { throwIfNoEntry: false });
    const stamp = `${st.size}:${st.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
    if (file === this.file && stamp === this.stamp)
      return this.sessions;
    try {
      const next = new Map;
      withDb(file, (db) => {
        const tables = tableNames(db);
        if (tables.has("session"))
          readTable(db, "session", next);
        if (tables.has("session_v2"))
          readTable(db, "session_v2", next);
      });
      this.sessions = next;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.file = file;
    this.stamp = stamp;
    return this.sessions;
  }
}

// service/runs.ts
import * as fs6 from "node:fs";
import * as path6 from "node:path";
var STALE_MS = 6 * 3600000;
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
function parseRunFile(pid, raw, sourceDir) {
  if (!isRecord(raw))
    return null;
  const startedAt = num2(raw.session_start);
  const updatedAt = num2(raw.updated_at);
  if (!startedAt && !updatedAt)
    return null;
  const tools = [];
  if (isRecord(raw.by_tool)) {
    for (const [name, stat] of Object.entries(raw.by_tool)) {
      if (!isRecord(stat))
        continue;
      tools.push({ name, calls: num2(stat.calls), bytes: num2(stat.bytes) });
    }
    tools.sort((a, b) => b.calls - a.calls || b.bytes - a.bytes);
  }
  const bytesIndexed = num2(raw.bytes_indexed);
  const bytesSandboxed = num2(raw.bytes_sandboxed);
  const cacheBytesSaved = num2(raw.cache_bytes_saved);
  return {
    key: `${pid}@${startedAt}`,
    pid,
    alive: false,
    startedAt,
    updatedAt,
    uptimeMs: num2(raw.uptime_ms) || Math.max(0, updatedAt - startedAt),
    version: typeof raw.version === "string" ? raw.version : null,
    calls: num2(raw.total_calls),
    bytesReturned: num2(raw.bytes_returned),
    bytesIndexed,
    bytesSandboxed,
    cacheHits: num2(raw.cache_hits),
    cacheBytesSaved,
    estTokensSaved: num2(raw.tokens_saved) || Math.round((bytesIndexed + bytesSandboxed + cacheBytesSaved) / 4),
    tools,
    sourceDir
  };
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0)
    return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function emptyAggregate() {
  return { runs: 0, calls: 0, bytesReturned: 0, bytesIndexed: 0, bytesSandboxed: 0, cacheHits: 0, cacheBytesSaved: 0, estTokensSaved: 0, tools: [] };
}
function aggregateRuns(runs) {
  const acc = emptyAggregate();
  const tools = new Map;
  for (const r of runs) {
    acc.runs++;
    acc.calls += r.calls;
    acc.bytesReturned += r.bytesReturned;
    acc.bytesIndexed += r.bytesIndexed;
    acc.bytesSandboxed += r.bytesSandboxed;
    acc.cacheHits += r.cacheHits;
    acc.cacheBytesSaved += r.cacheBytesSaved;
    acc.estTokensSaved += r.estTokensSaved;
    for (const t of r.tools) {
      const e = tools.get(t.name);
      if (e) {
        e.calls += t.calls;
        e.bytes += t.bytes;
      } else
        tools.set(t.name, { ...t });
    }
  }
  acc.tools = [...tools.values()].sort((a, b) => b.calls - a.calls || b.bytes - a.bytes);
  return acc;
}
var RECENT_MS = 2000;

class RunStore {
  cache = new Map;
  aliveCache = new Map;
  seenRuns = new Map;
  read(dirs) {
    const byKey = new Map;
    const seen = new Set;
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = fs6.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const m = STATS_RE.exec(name);
        if (!m)
          continue;
        const file = path6.join(dir, name);
        seen.add(file);
        const st = fs6.statSync(file, { throwIfNoEntry: false });
        if (!st)
          continue;
        const stamp = `${st.size}:${st.mtimeMs}`;
        let hit = this.cache.get(file);
        const recent = Date.now() - st.mtimeMs < RECENT_MS;
        if (!hit || hit.stamp !== stamp || recent) {
          let run = null;
          try {
            run = parseRunFile(m[1], JSON.parse(fs6.readFileSync(file, "utf8")), dir);
          } catch {
            run = null;
          }
          hit = { stamp, run };
          this.cache.set(file, hit);
        }
        if (!hit.run)
          continue;
        const prev = byKey.get(hit.run.key);
        if (!prev || hit.run.updatedAt > prev.updatedAt)
          byKey.set(hit.run.key, hit.run);
      }
    }
    for (const file of [...this.cache.keys()])
      if (!seen.has(file))
        this.cache.delete(file);
    for (const r of byKey.values()) {
      const prev = this.seenRuns.get(r.key);
      if (!prev || r.updatedAt >= prev.updatedAt)
        this.seenRuns.set(r.key, r);
    }
    for (const [key, r] of this.seenRuns)
      if (!byKey.has(key))
        byKey.set(key, r);
    const now = Date.now();
    const out = [];
    for (const r of byKey.values()) {
      let alive = false;
      if (now - r.updatedAt < STALE_MS) {
        const c = this.aliveCache.get(r.pid);
        if (c && now - c.at < 5000)
          alive = c.alive;
        else {
          alive = pidAlive(r.pid);
          this.aliveCache.set(r.pid, { at: now, alive });
        }
      }
      out.push({ ...r, alive, uptimeMs: alive ? Math.max(r.uptimeMs, now - r.startedAt) : r.uptimeMs });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
function pickLive(runs) {
  let best = null;
  for (const r of runs) {
    if (!r.alive)
      continue;
    if (!best || r.updatedAt > best.updatedAt)
      best = r;
  }
  return best;
}
function liveRuns(runs) {
  return runs.filter((r) => r.alive).sort((a, b) => b.updatedAt - a.updatedAt);
}

// service/settings.ts
function isDay(s) {
  if (!DAY_RE.test(s))
    return false;
  const ms = dayStart(s);
  return ms !== null && dayKey(ms) === s;
}
var DEFAULT_SERVICE_SETTINGS = {
  locations: { dataRoot: "", sessionDirs: [], statsDirs: [], contentDirs: [], opencodeDb: "" },
  filters: { hideSynthetic: true, excludeProjects: "" },
  privacy: { showContent: true, redactPaths: false }
};
var isRecord2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var text = (v, max = 1024) => typeof v === "string" ? v.slice(0, max) : "";
var list = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim().slice(0, 1024)).filter(Boolean).slice(0, 16) : [];
var bool = (v, d) => typeof v === "boolean" ? v : d;
function normalizeSettings(raw) {
  const d = DEFAULT_SERVICE_SETTINGS;
  const r = isRecord2(raw) ? raw : {};
  const loc = isRecord2(r.locations) ? r.locations : {};
  const fil = isRecord2(r.filters) ? r.filters : {};
  const pri = isRecord2(r.privacy) ? r.privacy : {};
  return {
    locations: {
      dataRoot: text(loc.dataRoot).trim(),
      sessionDirs: list(loc.sessionDirs),
      statsDirs: list(loc.statsDirs),
      contentDirs: list(loc.contentDirs),
      opencodeDb: text(loc.opencodeDb).trim()
    },
    filters: {
      hideSynthetic: bool(fil.hideSynthetic, d.filters.hideSynthetic),
      excludeProjects: text(fil.excludeProjects, 512)
    },
    privacy: {
      showContent: bool(pri.showContent, d.privacy.showContent),
      redactPaths: bool(pri.redactPaths, d.privacy.redactPaths)
    }
  };
}
function normalizeFilter(raw) {
  const r = isRecord2(raw) ? raw : {};
  const f = {};
  const from = text(r.from, 32), to = text(r.to, 32);
  if (isDay(from))
    f.from = from;
  if (isDay(to))
    f.to = to;
  if (typeof r.project === "string" && r.project)
    f.project = r.project.slice(0, 1024);
  if (typeof r.q === "string" && r.q.trim())
    f.q = r.q.trim().slice(0, 200);
  f.subagents = bool(r.subagents, true);
  return f;
}
function excludeMatcher(pattern) {
  const p = pattern.trim();
  if (!p)
    return null;
  try {
    const re = new RegExp(p, "i");
    return (dir) => re.test(dir.replace(/\\/g, "/"));
  } catch {
    return null;
  }
}

// service/engine.ts
var SENSITIVE = new Set([
  "user_prompt",
  "data",
  "role",
  "decision",
  "blocker",
  "blocker_resolved",
  "error_tool",
  "error_resolved",
  "constraint_discovered",
  "env",
  "cwd",
  "bash_outcome",
  "rule_content",
  "compaction_summary",
  "retry_detected",
  "git_commit"
]);
var PATH_TYPES = new Set(["file_read", "file_write", "file_edit", "file_search", "file_glob", "rule", "cwd"]);
var SESSION_SORTS = new Set(["last", "started", "events", "steps", "tokens", "peak", "errors", "prompts", "span", "cost", "compactions", "title"]);
function normDir(p) {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
}
var sumPrompt = (u) => u.tokensIn + u.cacheRead + u.cacheWrite;
async function within(p, ms) {
  let timer;
  try {
    await Promise.race([p.catch(() => {
      return;
    }), new Promise((r) => timer = setTimeout(r, ms))]);
  } finally {
    clearTimeout(timer);
  }
}

class Engine {
  events;
  runs = new RunStore;
  knowledge = new KnowledgeStore;
  opencode = new OpencodeStore;
  discoveryCache = null;
  rowCache = null;
  insightCache = new Map;
  constructor(opts = {}) {
    this.events = new EventIndex({ cacheDir: opts.cacheDir ?? null });
  }
  dispose() {
    return this.events.dispose();
  }
  context(settings) {
    const key = JSON.stringify(settings.locations);
    const now = Date.now();
    let report;
    if (this.discoveryCache && this.discoveryCache.key === key && now - this.discoveryCache.at < 5000) {
      report = this.discoveryCache.report;
    } else {
      report = discover(settings.locations);
      this.discoveryCache = { key, at: now, report };
    }
    const db = report.locations.find((l) => l.kind === "opencodeDb" && l.used);
    return {
      settings,
      report,
      sessionDirs: usedPaths(report, "sessions"),
      statsDirs: usedPaths(report, "stats"),
      contentDirs: usedPaths(report, "content"),
      opencodeDb: db ? db.path : null
    };
  }
  async prepare(settings) {
    const ctx = this.context(settings);
    if (!this.events.initialDone) {
      const run = this.events.refresh(ctx.sessionDirs);
      await within(Promise.race([run, this.events.whenUseful()]), 1500);
      return ctx;
    }
    if (Date.now() - this.events.lastRefresh > 2000 || this.events.busy) {
      await within(this.events.refresh(ctx.sessionDirs), 1500);
    }
    return ctx;
  }
  ocSessions(ctx) {
    return this.opencode.load(ctx.opencodeDb);
  }
  rows(ctx) {
    const oc = this.ocSessions(ctx);
    const key = `${this.events.version}|${ctx.opencodeDb}|${oc.size}|${this.opencodeStamp(oc)}`;
    if (this.rowCache && this.rowCache.key === key)
      return this.rowCache;
    const rows = [];
    const children = new Map;
    for (const o of oc.values())
      if (o.parentId)
        children.set(o.parentId, (children.get(o.parentId) ?? 0) + 1);
    for (const s of this.events.sessions())
      rows.push(this.toRow(s, oc.get(s.id) ?? null, children.get(s.id) ?? 0));
    const byId = new Map(rows.map((r) => [r.id, r]));
    this.rowCache = { key, rows, byId };
    return this.rowCache;
  }
  opencodeStamp(oc) {
    let m = 0;
    for (const o of oc.values())
      if (o.updatedAt > m)
        m = o.updatedAt;
    return m;
  }
  toRow(s, oc, childCount) {
    const tally = emptyTally();
    addTypes(tally, s.types);
    tally.compactions = Math.max(tally.compactions, s.compactions);
    const projectDir = oc?.directory || s.projectDir || "";
    return {
      id: s.id,
      title: oc?.title ?? null,
      projectDir,
      projectName: projectName(projectDir),
      parentId: oc?.parentId ?? null,
      agent: oc?.agent ?? null,
      model: oc?.model ?? null,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
      activeMs: Math.max(0, s.lastEventAt - s.startedAt),
      synthetic: !s.id.startsWith("ses_"),
      tally,
      usage: s.usage,
      types: s.types,
      resumes: s.resumes,
      childCount
    };
  }
  filtered(ctx, filter) {
    const { rows } = this.rows(ctx);
    const exclude = excludeMatcher(ctx.settings.filters.excludeProjects);
    const project = filter.project ? normDir(filter.project) : null;
    const q = filter.q?.toLowerCase();
    const [lo, hi] = rangeMs(filter.from, filter.to);
    const ranged = !!(filter.from || filter.to);
    const sessions = new Map(this.events.sessions().map((s) => [s.id, s]));
    return rows.filter((r) => {
      if (ctx.settings.filters.hideSynthetic && r.synthetic)
        return false;
      if (exclude && exclude(r.projectDir))
        return false;
      if (filter.subagents === false && r.parentId)
        return false;
      if (project && normDir(r.projectDir) !== project)
        return false;
      if (q && !`${r.title ?? ""} ${r.id} ${r.projectDir} ${r.model ?? ""} ${r.agent ?? ""}`.toLowerCase().includes(q))
        return false;
      if (ranged) {
        const s = sessions.get(r.id);
        if (!s)
          return false;
        if (s.days.size) {
          let hit = false;
          for (const d of s.days.keys())
            if (inDayRange(d, filter.from, filter.to)) {
              hit = true;
              break;
            }
          if (!hit)
            return false;
        } else if (!(r.startedAt >= lo && r.startedAt < hi))
          return false;
      }
      return true;
    });
  }
  overview(ctx, filter, topN) {
    const rows = this.filtered(ctx, filter);
    const sessions = new Map(this.events.sessions().map((s) => [s.id, s]));
    const tally = emptyTally();
    const usage = emptyUsage();
    const days = new Map;
    const groups = new Map;
    const hourly = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const projects = new Map;
    let firstDay = "";
    const bucket = (day) => {
      let b = days.get(day);
      if (!b) {
        b = { day, sessions: 0, events: 0, prompts: 0, errors: 0, steps: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, toolCalls: 0, bytesReturned: 0 };
        days.set(day, b);
      }
      return b;
    };
    let subagents = 0;
    for (const r of rows) {
      if (r.parentId)
        subagents++;
      const s = sessions.get(r.id);
      if (!s)
        continue;
      const dirKey = normDir(r.projectDir);
      let p = projects.get(dirKey);
      if (!p) {
        p = { dir: r.projectDir, name: r.projectName, sessions: 0, events: 0, steps: 0, tokens: 0, lastEventAt: 0 };
        projects.set(dirKey, p);
      }
      p.sessions++;
      p.lastEventAt = Math.max(p.lastEventAt, r.lastEventAt);
      let sessionCounted = false;
      for (const d of s.days.values()) {
        if (!inDayRange(d.day, filter.from, filter.to))
          continue;
        if (!firstDay || d.day < firstDay)
          firstDay = d.day;
        const t = emptyTally();
        addTypes(t, d.types);
        addTypes(tally, d.types);
        mergeUsage(usage, d.usage);
        const b = bucket(d.day);
        b.sessions++;
        b.events += t.events - t.steps;
        b.prompts += t.prompts;
        b.errors += t.errors;
        b.steps += d.usage.steps;
        b.tokensIn += d.usage.tokensIn;
        b.tokensOut += d.usage.tokensOut;
        b.cacheRead += d.usage.cacheRead;
        b.cacheWrite += d.usage.cacheWrite;
        b.costUsd += d.usage.costUsd;
        for (const [type, c] of Object.entries(d.types)) {
          const g = typeGroup(type);
          groups.set(g, (groups.get(g) ?? 0) + c);
        }
        const dow = new Date(dayStart(d.day) ?? 0).getDay();
        d.hours.forEach((c, h) => hourly[dow][h] += c);
        p.events += t.events - t.steps;
        p.steps += d.usage.steps;
        p.tokens += sumPrompt(d.usage) + d.usage.tokensOut;
        sessionCounted = true;
      }
      if (sessionCounted)
        tally.compactions += r.tally.compactions;
    }
    usage.lastContext = 0;
    const runs = this.runs.read(ctx.statsDirs).filter((r) => runInRange(r, filter));
    for (const run of runs) {
      const b = bucket(dayKey(run.startedAt || run.updatedAt));
      if (!inDayRange(b.day, filter.from, filter.to))
        continue;
      b.toolCalls += run.calls;
      b.bytesReturned += run.bytesReturned;
      if (!firstDay || b.day < firstDay)
        firstDay = b.day;
    }
    const today = dayKey(Date.now());
    const from = filter.from ?? (firstDay || today);
    const to = filter.to ?? today;
    const series = from && from <= to ? daysBetween(from, to, 731).map((d) => days.get(d) ?? bucket(d)) : [...days.values()];
    return {
      ok: true,
      generatedAt: Date.now(),
      range: { from: filter.from ?? (firstDay || null), to: filter.to ?? today, days: series.length },
      sessions: rows.length,
      subagentSessions: subagents,
      projects: projects.size,
      tally,
      usage,
      runs: aggregateRuns(runs),
      daily: series,
      categories: [...groups].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      hourly,
      projectsTop: [...projects.values()].sort((a, b) => b.events + b.steps - (a.events + a.steps)).slice(0, topN),
      heaviest: [...rows].sort((a, b) => sumPrompt(b.usage) - sumPrompt(a.usage)).slice(0, Math.min(topN, 10))
    };
  }
  sessionsPage(ctx, filter, sort, dir, offset, limit) {
    const rows = this.filtered(ctx, filter);
    const key = SESSION_SORTS.has(sort) ? sort : "last";
    const val = (r) => {
      switch (key) {
        case "started":
          return r.startedAt;
        case "events":
          return r.tally.events - r.tally.steps;
        case "steps":
          return r.usage.steps;
        case "tokens":
          return sumPrompt(r.usage) + r.usage.tokensOut;
        case "peak":
          return r.usage.peakContext;
        case "errors":
          return r.tally.errors;
        case "prompts":
          return r.tally.prompts;
        case "span":
          return r.activeMs;
        case "cost":
          return r.usage.costUsd;
        case "compactions":
          return r.tally.compactions;
        case "title":
          return (r.title ?? r.id).toLowerCase();
        default:
          return r.lastEventAt;
      }
    };
    const sign = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x < y)
        return -sign;
      if (x > y)
        return sign;
      return b.lastEventAt - a.lastEventAt;
    });
    return { ok: true, total: rows.length, offset, rows: rows.slice(offset, offset + limit) };
  }
  detail(ctx, id, opts) {
    const { byId, rows } = this.rows(ctx);
    const row = byId.get(id);
    const agg = this.events.get(id);
    if (!row || !agg)
      return null;
    const oc = this.ocSessions(ctx).get(id) ?? null;
    const { showContent, redactPaths } = ctx.settings.privacy;
    const textOf = (type, data) => {
      if (!showContent && SENSITIVE.has(type))
        return null;
      const t = data.length > 4000 ? data.slice(0, 4000) + "…" : data;
      return redactPaths && PATH_TYPES.has(type) ? redactPath(t) : t;
    };
    const toEvent = (r) => ({
      id: int(r.id),
      at: sqliteTime(r.created_at),
      type: str(r.type),
      category: str(r.category),
      priority: int(r.priority),
      text: textOf(str(r.type), str(r.data)),
      bytes: int(r.b)
    });
    const typeFilter = opts.types && opts.types.length ? ` AND type IN (${opts.types.map(() => "?").join(",")})` : " AND type != 'agent_usage'";
    const typeParams = opts.types && opts.types.length ? opts.types : [];
    let timelineTotal = 0;
    const timeline = [];
    const lists = { decisions: [], prompts: [] };
    const counts = {
      files: new Map,
      errors: new Map,
      skills: new Map,
      refs: new Map
    };
    const bump = (m, label, c, hint) => {
      if (!label)
        return;
      const e = m.get(label) ?? { count: 0, hint: new Set };
      e.count += c;
      if (hint)
        e.hint.add(hint);
      m.set(label, e);
    };
    const resumes = [];
    const seenEvents = new Set;
    for (const file of agg.dbFiles) {
      try {
        withDb(file, (db) => {
          const n = int(db.prepare(`SELECT count(*) c FROM session_events WHERE session_id = ?${typeFilter}`).get(id, ...typeParams)?.c);
          if (!n)
            return;
          timelineTotal += n;
          for (const r of db.prepare(`SELECT id, type, category, priority, data, created_at, bytes_avoided + bytes_returned b
                         FROM session_events WHERE session_id = ?${typeFilter} ORDER BY created_at DESC, id DESC LIMIT ?`).all(id, ...typeParams, opts.offset + opts.limit)) {
            const key = `${r.type}|${r.created_at}|${str(r.data).slice(0, 200)}`;
            if (seenEvents.has(key))
              continue;
            seenEvents.add(key);
            timeline.push(toEvent(r));
          }
          for (const r of db.prepare(`SELECT type, CASE WHEN type = 'error_tool' THEN substr(trim(data), 1, 200) ELSE substr(data, 1, 400) END d, count(*) c
                         FROM session_events WHERE session_id = ? AND type IN ('file_read','file_write','file_edit','error_tool','skill','external_ref')
                         GROUP BY type, d`).all(id)) {
            const type = str(r.type), d = str(r.d), c = int(r.c);
            if (type.startsWith("file_"))
              bump(counts.files, redactPaths ? redactPath(d) : d, c, type.slice(5));
            else if (type === "error_tool") {
              if (showContent)
                bump(counts.errors, d, c);
            } else if (type === "skill")
              bump(counts.skills, d || "(unnamed)", c);
            else
              for (const p of d.split(/,\s*/))
                bump(counts.refs, p.trim(), c);
          }
          const list = (types, limit) => db.prepare(`SELECT id, type, category, priority, data, created_at, 0 b FROM session_events
                            WHERE session_id = ? AND type IN (${types.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`).all(id, ...types, limit).map(toEvent);
          lists.decisions.push(...list(["decision", "blocker", "blocker_resolved", "constraint_discovered"], opts.topN * 2));
          lists.prompts.push(...list(["user_prompt"], opts.topN * 2));
          if (tableNames(db).has("session_resume")) {
            for (const r of db.prepare("SELECT created_at, event_count, consumed, snapshot FROM session_resume WHERE session_id = ? ORDER BY id").all(id)) {
              const snap = str(r.snapshot);
              const sections = [];
              const re = /<([a-z_]+) count="(\d+)"/g;
              let m;
              while (m = re.exec(snap))
                sections.push({ label: m[1].replace(/_/g, " "), count: Number(m[2]) });
              resumes.push({ at: sqliteTime(r.created_at), events: int(r.event_count), consumed: int(r.consumed) === 1, bytes: snap.length, sections });
            }
          }
        });
      } catch {}
    }
    timeline.sort((a, b) => b.at - a.at || b.id - a.id);
    const ranked = (m) => [...m].map(([label, v]) => ({ label, count: v.count, hint: v.hint.size ? [...v.hint].join(", ") : undefined })).sort((a, b) => b.count - a.count).slice(0, opts.topN);
    const newest = (l, n) => l.sort((a, b) => b.at - a.at).slice(0, n);
    const n = stepCount(agg.steps);
    const per = Math.max(1, Math.ceil(n / 600));
    const series = [];
    const drops = [];
    let prev = 0;
    for (let i = 0;i < n; i += per) {
      const pt = { at: 0, context: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      for (let j = i;j < Math.min(n, i + per); j++) {
        const { at, u } = stepAt(agg.steps, j);
        const size = promptSize(u);
        if (prev > 50000 && size < prev * 0.5)
          drops.push(at);
        prev = size;
        pt.at = at;
        pt.context = Math.max(pt.context, size);
        pt.tokensIn += u.tokensIn;
        pt.tokensOut += u.tokensOut;
        pt.cacheRead += u.cacheRead;
        pt.cacheWrite += u.cacheWrite;
        pt.costUsd += u.costUsd;
      }
      if (pt.at)
        series.push(pt);
    }
    const runs = this.runs.read(ctx.statsDirs).filter((r) => r.startedAt <= row.lastEventAt && (r.alive ? Date.now() : r.updatedAt) >= row.startedAt);
    const hash = dbHash(agg.dbFile);
    const kb = this.knowledgeDbs(ctx).find((k) => k.summary.hash === hash)?.summary ?? null;
    return {
      ok: true,
      row,
      parent: row.parentId ? byId.get(row.parentId) ?? null : null,
      children: rows.filter((r) => r.parentId === id).sort((a, b) => a.startedAt - b.startedAt),
      opencode: oc ? {
        title: oc.title,
        tokensInput: oc.tokensInput,
        tokensOutput: oc.tokensOutput,
        tokensReasoning: oc.tokensReasoning,
        tokensCacheRead: oc.tokensCacheRead,
        tokensCacheWrite: oc.tokensCacheWrite,
        cost: oc.cost,
        createdAt: oc.createdAt,
        updatedAt: oc.updatedAt,
        summaryFiles: oc.summaryFiles,
        summaryAdditions: oc.summaryAdditions,
        summaryDeletions: oc.summaryDeletions
      } : null,
      usageSeries: series,
      compactions: resumes.map((r) => r.at).sort((a, b) => a - b),
      contextDrops: drops,
      timeline: timeline.slice(opts.offset, opts.offset + opts.limit),
      timelineTotal,
      files: ranked(counts.files),
      errors: ranked(counts.errors),
      skills: ranked(counts.skills),
      refs: ranked(counts.refs),
      decisions: newest(lists.decisions, opts.topN * 2),
      prompts: newest(lists.prompts, opts.topN * 2),
      resumes: resumes.sort((a, b) => a.at - b.at),
      runs: runs.slice(0, 20),
      knowledge: kb
    };
  }
  insights(ctx, filter, topN) {
    const { showContent, redactPaths } = ctx.settings.privacy;
    const key = JSON.stringify([filter, topN, showContent, redactPaths, this.events.version, ctx.settings.filters]);
    const hit = this.insightCache.get(key);
    if (hit && Date.now() - hit.at < 30000)
      return hit.payload;
    const rows = this.filtered(ctx, filter);
    const wanted = new Set(rows.map((r) => r.id));
    const sessions = this.events.sessions();
    const perDb = new Map;
    const dbTotals = new Map;
    for (const s of sessions)
      for (const f of s.dbFiles)
        dbTotals.set(f, (dbTotals.get(f) ?? 0) + 1);
    for (const s of sessions) {
      if (!wanted.has(s.id) || !s.types || Object.keys(s.types).every((t) => t === "agent_usage"))
        continue;
      for (const f of s.dbFiles) {
        const e = perDb.get(f) ?? { ids: [], all: false };
        e.ids.push(s.id);
        perDb.set(f, e);
      }
    }
    for (const [file, e] of perDb)
      e.all = e.ids.length === dbTotals.get(file);
    const [lo, hi] = rangeMs(filter.from, filter.to);
    const timeClause = (Number.isFinite(lo) ? ` AND created_at >= '${sqliteUtc(lo)}'` : "") + (Number.isFinite(hi) ? ` AND created_at < '${sqliteUtc(hi)}'` : "");
    const tallies = {
      files: new Map,
      errors: new Map,
      skills: new Map,
      refs: new Map,
      commands: new Map,
      retries: new Map,
      intents: new Map
    };
    const bump = (m, label, c) => {
      if (label)
        m.set(label, (m.get(label) ?? 0) + c);
    };
    for (const [file, e] of perDb) {
      try {
        withDb(file, (db) => {
          const idClause = e.all ? "" : ` AND session_id IN (${e.ids.map(() => "?").join(",")})`;
          const params = e.all ? [] : e.ids;
          const res = db.prepare(`SELECT type, substr(trim(data), 1, 200) d, count(*) c FROM session_events
                         WHERE type IN ('file_read','file_write','file_edit','error_tool','skill','external_ref','env','retry_detected','intent')
                         ${idClause}${timeClause} GROUP BY type, d`).all(...params);
          for (const r of res) {
            const type = str(r.type), d = str(r.d), c = int(r.c);
            switch (type) {
              case "file_read":
              case "file_write":
              case "file_edit":
                bump(tallies.files, redactPaths ? redactPath(d) : d, c);
                break;
              case "error_tool":
                if (showContent)
                  bump(tallies.errors, d.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 160) ?? "", c);
                break;
              case "skill":
                bump(tallies.skills, d || "(unnamed)", c);
                break;
              case "external_ref":
                for (const p of d.split(/,\s*/))
                  bump(tallies.refs, p.trim(), c);
                break;
              case "env":
                if (showContent)
                  bump(tallies.commands, commandHead(d), c);
                break;
              case "retry_detected":
                bump(tallies.retries, d.replace(/\d+ times/, "N times"), c);
                break;
              case "intent":
                bump(tallies.intents, d, c);
                break;
            }
          }
        });
      } catch {}
    }
    const top = (m) => [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, topN);
    const models = new Map, agents = new Map;
    for (const r of rows) {
      if (r.model)
        bump(models, r.model, Math.max(1, r.usage.steps));
      if (r.agent)
        bump(agents, r.agent, 1);
    }
    const payload = {
      ok: true,
      files: top(tallies.files),
      errors: top(tallies.errors),
      skills: top(tallies.skills),
      refs: top(tallies.refs),
      commands: top(tallies.commands),
      retries: top(tallies.retries),
      intents: top(tallies.intents),
      models: top(models),
      agents: top(agents),
      contentHidden: !showContent
    };
    this.insightCache.set(key, { at: Date.now(), payload });
    if (this.insightCache.size > 32)
      this.insightCache.delete(this.insightCache.keys().next().value);
    return payload;
  }
  runsPayload(ctx, filter, offset, limit) {
    const all = this.runs.read(ctx.statsDirs);
    const live = pickLive(all);
    const runs = all.filter((r) => runInRange(r, filter));
    const days = new Map;
    let sandboxDominated = 0;
    for (const r of runs) {
      const day = dayKey(r.startedAt || r.updatedAt);
      const d = days.get(day) ?? { day, runs: 0, calls: 0, bytesReturned: 0, bytesIndexed: 0, bytesSandboxed: 0 };
      d.runs++;
      d.calls += r.calls;
      d.bytesReturned += r.bytesReturned;
      d.bytesIndexed += r.bytesIndexed;
      d.bytesSandboxed += r.bytesSandboxed;
      days.set(day, d);
      const kept = r.bytesIndexed + r.bytesSandboxed + r.cacheBytesSaved;
      if (kept > 0 && r.bytesSandboxed / kept > 0.9)
        sandboxDominated++;
    }
    return {
      ok: true,
      live,
      liveRuns: liveRuns(all),
      aggregate: aggregateRuns(runs),
      runs: runs.slice(offset, offset + limit),
      total: runs.length,
      daily: [...days.values()].sort((a, b) => a.day < b.day ? -1 : 1),
      sandboxDominated
    };
  }
  knowledgeDbs(ctx) {
    return this.knowledge.read(ctx.contentDirs, (h) => this.events.projectForHash(h));
  }
  knowledgePayload(ctx, filter, offset, limit, sort) {
    const project = filter.project ? normDir(filter.project) : null;
    const [lo, hi] = rangeMs(filter.from, filter.to);
    const q = filter.q?.toLowerCase();
    const dbs = this.knowledgeDbs(ctx).filter((k) => !project || k.summary.projectDir && normDir(k.summary.projectDir) === project);
    const sources = dbs.flatMap((k) => k.sources.filter((s) => (!s.indexedAt || s.indexedAt >= lo && s.indexedAt < hi) && (!q || s.label.toLowerCase().includes(q))));
    const kinds = new Map;
    const daily = new Map;
    for (const s of sources) {
      const k = kinds.get(s.kind) ?? { count: 0, value: 0 };
      k.count++;
      k.value += s.chunks;
      kinds.set(s.kind, k);
      if (s.indexedAt) {
        const day = dayKey(s.indexedAt);
        const d = daily.get(day) ?? { day, sources: 0, chunks: 0 };
        d.sources++;
        d.chunks += s.chunks;
        daily.set(day, d);
      }
    }
    sources.sort(sort === "chunks" ? (a, b) => b.chunks - a.chunks : (a, b) => b.indexedAt - a.indexedAt);
    const { redactPaths } = ctx.settings.privacy;
    const totals = { dbs: dbs.length, bytes: 0, sources: 0, chunks: 0, codeChunks: 0 };
    for (const k of dbs) {
      totals.bytes += k.summary.bytes;
      totals.sources += k.summary.sources;
      totals.chunks += k.summary.chunks;
      totals.codeChunks += k.summary.codeChunks;
    }
    return {
      ok: true,
      dbs: dbs.map((k) => k.summary),
      totals,
      kinds: [...kinds].map(([label, v]) => ({ label, count: v.count, value: v.value })).sort((a, b) => b.count - a.count),
      sources: sources.slice(offset, offset + limit).map((s) => redactPaths && s.filePath ? { ...s, filePath: redactPath(s.filePath) } : s),
      sourcesTotal: sources.length,
      daily: [...daily.values()].sort((a, b) => a.day < b.day ? -1 : 1)
    };
  }
  brief(ctx, sessionId, directory) {
    const { byId } = this.rows(ctx);
    const rows = this.filtered(ctx, {});
    const session = sessionId ? byId.get(sessionId) ?? null : null;
    let contextTrail = [];
    if (session) {
      const agg = this.events.get(session.id);
      if (agg) {
        const n = stepCount(agg.steps);
        for (let i = Math.max(0, n - 40);i < n; i++)
          contextTrail.push(promptSize(stepAt(agg.steps, i).u));
      }
    }
    let project = null;
    const dir = directory ?? session?.projectDir ?? null;
    if (dir) {
      const key = normDir(dir);
      for (const r of rows) {
        if (normDir(r.projectDir) !== key)
          continue;
        project ??= { dir: r.projectDir, name: r.projectName, sessions: 0, events: 0, steps: 0, tokens: 0, lastEventAt: 0 };
        project.sessions++;
        project.events += r.tally.events - r.tally.steps;
        project.steps += r.usage.steps;
        project.tokens += sumPrompt(r.usage) + r.usage.tokensOut;
        project.lastEventAt = Math.max(project.lastEventAt, r.lastEventAt);
      }
    }
    const runs = this.runs.read(ctx.statsDirs);
    return { ok: true, session, contextTrail, project, live: pickLive(runs), liveRuns: liveRuns(runs), progress: this.events.progress };
  }
  status(ctx) {
    const runs = this.runs.read(ctx.statsDirs);
    const sessions = this.events.sessions();
    let events = 0;
    for (const s of sessions)
      for (const c of Object.values(s.types))
        events += c;
    let knowledgeSources = 0;
    try {
      for (const k of this.knowledgeDbs(ctx))
        knowledgeSources += k.summary.sources;
    } catch {
      knowledgeSources = 0;
    }
    return {
      ok: true,
      generatedAt: Date.now(),
      progress: this.events.progress,
      discovery: ctx.report,
      totals: { sessions: sessions.length, events, runs: runs.length, knowledgeSources },
      live: pickLive(runs),
      liveRuns: liveRuns(runs)
    };
  }
}
function runInRange(r, filter) {
  if (!filter.from && !filter.to)
    return true;
  const [lo, hi] = rangeMs(filter.from, filter.to);
  const end = r.alive ? Date.now() : r.updatedAt || r.startedAt;
  return (r.startedAt || end) < hi && end >= lo;
}
function commandHead(cmd) {
  const first = cmd.trim().split(/\s*(?:\||&&|;)\s*/)[0] ?? "";
  const words = first.split(/\s+/).filter(Boolean);
  if (!words.length)
    return "";
  const bin = words[0].replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "");
  const sub = words[1] && /^[a-z][\w:-]*$/i.test(words[1]) ? ` ${words[1]}` : "";
  return (bin + sub).slice(0, 60);
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("[context-mode] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR || "";
var engine = new Engine({ cacheDir: dataDir ? path7.join(dataDir, "event-index") : null });
var MAX_BODY = 256 * 1024;
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length)
        return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
var topN = (b) => clampInt(b.topN, 3, 100, 10);
var routes = {
  "/v1/status": async (b) => engine.status(await engine.prepare(normalizeSettings(b.settings))),
  "/v1/overview": async (b) => engine.overview(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), topN(b)),
  "/v1/sessions": async (b) => engine.sessionsPage(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), typeof b.sort === "string" ? b.sort : "last", b.dir === "asc" ? "asc" : "desc", clampInt(b.offset, 0, 1e6, 0), clampInt(b.limit, 1, 500, 50)),
  "/v1/session": async (b) => {
    const ctx = await engine.prepare(normalizeSettings(b.settings));
    const id = typeof b.id === "string" ? b.id.slice(0, 200) : "";
    const types = Array.isArray(b.types) ? b.types.filter((t) => typeof t === "string").slice(0, 40) : null;
    const detail = id ? engine.detail(ctx, id, { offset: clampInt(b.offset, 0, 1e6, 0), limit: clampInt(b.limit, 1, 500, 150), types, topN: topN(b) }) : null;
    return detail ?? { ok: false, error: "session not found", code: "NOT_FOUND" };
  },
  "/v1/insights": async (b) => engine.insights(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), topN(b)),
  "/v1/runs": async (b) => engine.runsPayload(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), clampInt(b.offset, 0, 1e6, 0), clampInt(b.limit, 1, 500, 50)),
  "/v1/knowledge": async (b) => engine.knowledgePayload(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), clampInt(b.offset, 0, 1e6, 0), clampInt(b.limit, 1, 500, 50), b.sort === "chunks" ? "chunks" : "recent"),
  "/v1/brief": async (b) => engine.brief(await engine.prepare(normalizeSettings(b.settings)), typeof b.sessionId === "string" ? b.sessionId : null, typeof b.directory === "string" ? b.directory : null)
};
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    const route = routes[url.pathname];
    if (!route || req.method !== "POST") {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    send(res, 200, await route(await readBody(req)));
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[context-mode] listening on 127.0.0.1:${port} (node ${process.versions.node}; saved index ${dataDir ? "on" : "off"})`);
});
var stopping = false;
function stop() {
  if (stopping)
    return;
  stopping = true;
  server.close();
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  engine.dispose().finally(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
