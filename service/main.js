// service/main.ts
import http from "node:http";

// service/stats.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function resolveStorageDirs() {
  const override = process.env.CONTEXT_MODE_STATS_DIR;
  if (override && override.trim())
    return [override.trim()];
  const home = os.homedir();
  const candidates = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) {
    candidates.push(path.join(xdg.trim(), "opencode", "context-mode", "sessions"));
  }
  candidates.push(path.join(home, ".config", "opencode", "context-mode", "sessions"));
  candidates.push(path.join(home, ".opencode-v2", "config", "opencode", "context-mode", "sessions"));
  return [...new Set(candidates)];
}
function parseStatsFile(pid, raw) {
  if (!isRecord(raw))
    return null;
  const tools = [];
  if (isRecord(raw.by_tool)) {
    for (const [name, stat] of Object.entries(raw.by_tool)) {
      if (!isRecord(stat))
        continue;
      tools.push({ name, calls: num(stat.calls), bytes: num(stat.bytes) });
    }
    tools.sort((a, b) => b.bytes - a.bytes);
  }
  const totalCalls = num(raw.total_calls);
  const totalProcessed = num(raw.total_processed);
  return {
    pid,
    sessionStart: num(raw.session_start),
    updatedAt: num(raw.updated_at),
    uptimeMs: num(raw.uptime_ms),
    totalCalls,
    bytesReturned: num(raw.bytes_returned),
    bytesIndexed: num(raw.bytes_indexed),
    bytesSandboxed: num(raw.bytes_sandboxed),
    cacheHits: num(raw.cache_hits),
    cacheBytesSaved: num(raw.cache_bytes_saved),
    keptOut: num(raw.kept_out),
    totalProcessed,
    reductionPct: num(raw.reduction_pct),
    tokensSaved: num(raw.tokens_saved),
    dollarsSaved: num(raw.dollars_saved_session),
    tools
  };
}
function dayKey(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
var LIVE_WINDOW_MS = 60000;

class StatsStore {
  storageDirs;
  constructor(storageDirs) {
    this.storageDirs = storageDirs;
  }
  storageDir = "";
  async readAll() {
    const byKey = new Map;
    let foundAny = false;
    let freshestDir = "";
    let freshestUpdate = -1;
    for (const dir of this.storageDirs) {
      let entries;
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      foundAny = true;
      for (const entry of entries) {
        const match = /^stats-pid-(.+)\.json$/.exec(entry);
        if (!match)
          continue;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8"));
          const parsed = parseStatsFile(match[1], raw);
          if (!parsed)
            continue;
          if (parsed.updatedAt > freshestUpdate) {
            freshestUpdate = parsed.updatedAt;
            freshestDir = dir;
          }
          const key = `${parsed.pid}@${parsed.sessionStart}`;
          const existing = byKey.get(key);
          if (!existing || parsed.updatedAt > existing.updatedAt) {
            byKey.set(key, parsed);
          }
        } catch {}
      }
    }
    if (!foundAny)
      return null;
    this.storageDir = freshestDir;
    return [...byKey.values()];
  }
  async getStats() {
    const generatedAt = Date.now();
    const files = await this.readAll();
    if (files === null) {
      return {
        ok: true,
        storageDir: this.storageDirs[0] ?? "",
        storageDirs: this.storageDirs,
        generatedAt,
        reason: "storage-missing",
        live: null,
        liveStale: false,
        allTime: null,
        daily: []
      };
    }
    let live = null;
    let liveStale = false;
    const sorted = [...files].sort((a, b) => b.updatedAt - a.updatedAt);
    const newest = sorted[0];
    if (newest && newest.updatedAt > 0) {
      liveStale = generatedAt - newest.updatedAt > LIVE_WINDOW_MS;
      live = {
        pid: newest.pid,
        startedAt: newest.sessionStart,
        updatedAt: newest.updatedAt,
        uptimeMs: newest.uptimeMs,
        totalCalls: newest.totalCalls,
        bytesReturned: newest.bytesReturned,
        bytesIndexed: newest.bytesIndexed,
        bytesSandboxed: newest.bytesSandboxed,
        cacheHits: newest.cacheHits,
        cacheBytesSaved: newest.cacheBytesSaved,
        keptOut: newest.keptOut,
        totalProcessed: newest.totalProcessed,
        reductionPct: newest.reductionPct,
        tokensSaved: newest.tokensSaved,
        dollarsSaved: newest.dollarsSaved,
        tools: newest.tools
      };
    }
    let allTime = null;
    if (files.length > 0) {
      const toolMap = new Map;
      const acc = {
        processes: files.length,
        totalCalls: 0,
        bytesReturned: 0,
        bytesIndexed: 0,
        bytesSandboxed: 0,
        cacheHits: 0,
        cacheBytesSaved: 0,
        keptOut: 0,
        totalProcessed: 0,
        tokensSaved: 0,
        dollarsSaved: 0,
        tools: []
      };
      for (const f of files) {
        acc.totalCalls += f.totalCalls;
        acc.bytesReturned += f.bytesReturned;
        acc.bytesIndexed += f.bytesIndexed;
        acc.bytesSandboxed += f.bytesSandboxed;
        acc.cacheHits += f.cacheHits;
        acc.cacheBytesSaved += f.cacheBytesSaved;
        acc.keptOut += f.keptOut;
        acc.totalProcessed += f.totalProcessed;
        acc.tokensSaved += f.tokensSaved;
        acc.dollarsSaved += f.dollarsSaved;
        for (const t of f.tools) {
          const existing = toolMap.get(t.name);
          if (existing) {
            existing.calls += t.calls;
            existing.bytes += t.bytes;
          } else {
            toolMap.set(t.name, { name: t.name, calls: t.calls, bytes: t.bytes });
          }
        }
      }
      acc.tools = [...toolMap.values()].sort((a, b) => b.bytes - a.bytes);
      allTime = acc;
    }
    const dayMap = new Map;
    for (const f of files) {
      if (f.sessionStart <= 0)
        continue;
      const key = dayKey(f.sessionStart);
      const point = dayMap.get(key) ?? {
        day: key,
        tokensSaved: 0,
        dollarsSaved: 0,
        calls: 0,
        bytesProcessed: 0,
        sessions: 0
      };
      point.tokensSaved += f.tokensSaved;
      point.dollarsSaved += f.dollarsSaved;
      point.calls += f.totalCalls;
      point.bytesProcessed += f.totalProcessed;
      point.sessions += 1;
      dayMap.set(key, point);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    return {
      ok: true,
      storageDir: this.storageDir,
      storageDirs: this.storageDirs,
      generatedAt,
      live,
      liveStale,
      allTime,
      daily
    };
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("[context-mode-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var store = new StatsStore(resolveStorageDirs());
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      sendJson(res, 200, await store.getStats());
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[context-mode-stats] listening on 127.0.0.1:${port} (stores: ${store.storageDirs.join(", ")})`);
});
