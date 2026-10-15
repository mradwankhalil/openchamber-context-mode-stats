// service/main.ts
import http from "node:http";

// service/stats.ts
import * as fs2 from "node:fs/promises";
import * as os2 from "node:os";
import * as path2 from "node:path";

// service/pricing.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
var MODELS_DEV_URL = "https://models.dev/api.json";
var RATES_TTL_MS = 24 * 3600000;
var MIX_TTL_MS = 5 * 60000;
var DROP_TOKENS = new Set([
  "latest",
  "preview",
  "thinking",
  "instruct",
  "chat",
  "the"
]);
function tokenize(text) {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !DROP_TOKENS.has(t)));
}
function scoreOverlap(a, b) {
  let score = 0;
  for (const t of a)
    if (b.has(t))
      score += t.length > 3 ? 2 : 1;
  return score;
}
function parseModelRef(raw) {
  if (typeof raw !== "string" || !raw.trim())
    return null;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const o = parsed;
        if (typeof o.id === "string" && o.id) {
          return { provider: typeof o.providerID === "string" ? o.providerID : "", model: o.id };
        }
      }
    } catch {}
    return null;
  }
  const slash = text.indexOf("/");
  return slash > 0 ? { provider: text.slice(0, slash), model: text.slice(slash + 1) } : { provider: "", model: text };
}
function versionRuns(text) {
  return text.match(/\d+/g) ?? [];
}

class PricingEngine {
  cacheFile;
  dbPaths;
  rates = null;
  ratesLoadedAt = 0;
  mixCache = new Map;
  constructor(opts) {
    const home = os.homedir();
    this.cacheFile = opts?.cacheFile ?? process.env.STATS_PRICING_CACHE ?? path.join(home, ".config", "openchamber", "context-mode-stats-pricing.json");
    const xdgData = process.env.XDG_DATA_HOME;
    this.dbPaths = opts?.dbPaths ?? [
      ...process.env.OPENCODE_DB_PATH ? [process.env.OPENCODE_DB_PATH] : [],
      ...xdgData && xdgData.trim() ? [path.join(xdgData.trim(), "opencode", "opencode.db")] : [],
      path.join(home, ".local", "share", "opencode", "opencode.db"),
      path.join(home, ".opencode-v2", "data", "opencode.db")
    ];
  }
  async price(windowStart, windowEnd, tokensSaved) {
    try {
      if (!(tokensSaved > 0))
        return null;
      const mix = await this.getMix(windowStart, windowEnd);
      if (mix.length === 0)
        return null;
      await this.loadRates();
      const priced = this.applyRates(mix);
      const totalWeight = priced.reduce((s, m) => s + m.weight, 0);
      if (totalWeight <= 0)
        return null;
      let weightedInput = 0;
      let weightedCache = 0;
      let coveredWeight = 0;
      for (const m of priced) {
        if (m.inputRate === null)
          continue;
        coveredWeight += m.weight;
        weightedInput += m.share * m.inputRate;
        weightedCache += m.share * (m.cacheRate ?? m.inputRate);
      }
      if (coveredWeight <= 0)
        return null;
      const coverage = coveredWeight / totalWeight;
      const scale = 1 / coverage;
      return {
        dollarsMin: tokensSaved / 1e6 * weightedCache * scale,
        dollarsMax: tokensSaved / 1e6 * weightedInput * scale,
        coverage,
        mix: priced,
        windowStart,
        windowEnd
      };
    } catch {
      return null;
    }
  }
  async getMix(windowStart, windowEnd) {
    const cacheKey = `${Math.floor(windowStart / 60000)}:${Math.floor(windowEnd / 60000)}`;
    const cached = this.mixCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MIX_TTL_MS)
      return cached.mix;
    const dbPath = await this.freshestDb();
    if (!dbPath)
      return [];
    const mix = this.queryMix(dbPath, windowStart, windowEnd);
    this.mixCache.set(cacheKey, { at: Date.now(), mix });
    return mix;
  }
  async freshestDb() {
    let best = null;
    let bestMtime = -1;
    for (const p of this.dbPaths) {
      try {
        const stat2 = await fs.stat(p);
        if (stat2.isFile() && stat2.mtimeMs > bestMtime) {
          bestMtime = stat2.mtimeMs;
          best = p;
        }
      } catch {}
    }
    return best;
  }
  queryMix(dbPath, startMs, endMs) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session')").all().map((r) => r.name).filter((n) => typeof n === "string");
      const byKey = new Map;
      const seenIds = new Set;
      for (const table of ["session_v2", "session"]) {
        if (!tables.includes(table))
          continue;
        const rows = db.prepare(`SELECT id, model, tokens_input, tokens_cache_read
                         FROM ${table}
                         WHERE time_created <= ? AND time_updated >= ?`).all(endMs, startMs);
        for (const row of rows) {
          if (typeof row.id === "string") {
            if (seenIds.has(row.id))
              continue;
            seenIds.add(row.id);
          }
          const weight = (typeof row.tokens_input === "number" ? row.tokens_input : 0) + (typeof row.tokens_cache_read === "number" ? row.tokens_cache_read : 0);
          if (!(weight > 0))
            continue;
          const ref = parseModelRef(row.model);
          if (!ref)
            continue;
          const key = ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
          const existing = byKey.get(key);
          if (existing) {
            existing.weight += weight;
          } else {
            byKey.set(key, {
              key,
              provider: ref.provider,
              model: ref.model,
              weight,
              share: 0,
              inputRate: null,
              cacheRate: null,
              matched: null
            });
          }
        }
      }
      const entries = [...byKey.values()];
      const total = entries.reduce((sum, e) => sum + e.weight, 0);
      for (const e of entries)
        e.share = total > 0 ? e.weight / total : 0;
      entries.sort((a, b) => b.weight - a.weight);
      return entries;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  async loadRates() {
    if (this.rates && Date.now() - this.ratesLoadedAt < RATES_TTL_MS)
      return;
    try {
      const stat2 = await fs.stat(this.cacheFile);
      if (Date.now() - stat2.mtimeMs < RATES_TTL_MS) {
        const raw2 = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
        const parsed2 = this.parseRates(raw2);
        if (parsed2.length > 0) {
          this.rates = parsed2;
          this.ratesLoadedAt = Date.now();
          return;
        }
      }
    } catch {}
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok)
      throw new Error(`models.dev HTTP ${res.status}`);
    const raw = await res.json();
    const parsed = this.parseRates(raw);
    if (parsed.length === 0)
      throw new Error("models.dev payload had no priced models");
    this.rates = parsed;
    this.ratesLoadedAt = Date.now();
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(raw));
      await fs.rename(tmp, this.cacheFile);
    } catch {}
  }
  parseRates(raw) {
    if (typeof raw !== "object" || raw === null)
      return [];
    const out = [];
    for (const [providerId, provider] of Object.entries(raw)) {
      if (typeof provider !== "object" || provider === null)
        continue;
      const models = provider.models;
      if (typeof models !== "object" || models === null)
        continue;
      for (const [modelId, model] of Object.entries(models)) {
        if (typeof model !== "object" || model === null)
          continue;
        const m = model;
        const cost = m.cost;
        const inputRate = typeof cost?.input === "number" ? cost.input : null;
        if (inputRate === null || !(inputRate > 0))
          continue;
        const cacheRate = typeof cost?.cache_read === "number" && cost.cache_read > 0 ? cost.cache_read : null;
        out.push({
          id: `${providerId}/${modelId}`,
          tokens: tokenize(`${providerId} ${modelId} ${typeof m.name === "string" ? m.name : ""}`),
          inputRate,
          cacheRate
        });
      }
    }
    return out;
  }
  applyRates(mix) {
    if (!this.rates)
      return mix;
    for (const entry of mix) {
      const want = tokenize(`${entry.model} ${entry.provider}`);
      const wantVersions = versionRuns(entry.model);
      let best = null;
      let bestScore = 0;
      for (const rate of this.rates) {
        let score = scoreOverlap(want, rate.tokens);
        const rateVersions = versionRuns(rate.id);
        if (wantVersions.length > 0 && rateVersions.length > 0) {
          if (wantVersions[0] === rateVersions[0]) {
            score += 2;
            if (wantVersions.length > 1 && wantVersions[1] === rateVersions[1])
              score += 1;
          } else {
            score -= 3;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = rate;
        }
      }
      if (best && bestScore >= 2) {
        entry.inputRate = best.inputRate;
        entry.cacheRate = best.cacheRate;
        entry.matched = best.id;
      }
    }
    return mix;
  }
}

// service/stats.ts
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
  const home = os2.homedir();
  const candidates = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) {
    candidates.push(path2.join(xdg.trim(), "opencode", "context-mode", "sessions"));
  }
  candidates.push(path2.join(home, ".config", "opencode", "context-mode", "sessions"));
  candidates.push(path2.join(home, ".opencode-v2", "config", "opencode", "context-mode", "sessions"));
  return [...new Set(candidates)];
}
function parseStatsFile(pid, raw) {
  if (!isRecord(raw))
    return null;
  const tools = [];
  if (isRecord(raw.by_tool)) {
    for (const [name, stat2] of Object.entries(raw.by_tool)) {
      if (!isRecord(stat2))
        continue;
      tools.push({ name, calls: num(stat2.calls), bytes: num(stat2.bytes) });
    }
    tools.sort((a, b) => b.bytes - a.bytes);
  }
  return {
    pid,
    sessionStart: num(raw.session_start),
    updatedAt: num(raw.updated_at),
    uptimeMs: num(raw.uptime_ms),
    totalCalls: num(raw.total_calls),
    bytesReturned: num(raw.bytes_returned),
    bytesIndexed: num(raw.bytes_indexed),
    bytesSandboxed: num(raw.bytes_sandboxed),
    cacheHits: num(raw.cache_hits),
    cacheBytesSaved: num(raw.cache_bytes_saved),
    keptOut: num(raw.kept_out),
    totalProcessed: num(raw.total_processed),
    reductionPct: num(raw.reduction_pct),
    tokensSaved: num(raw.tokens_saved),
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
function dayStartMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match)
    return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}
var LIVE_WINDOW_MS = 60000;

class StatsStore {
  storageDirs;
  pricing;
  constructor(storageDirs, pricing) {
    this.storageDirs = storageDirs;
    this.pricing = pricing ?? new PricingEngine;
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
        entries = await fs2.readdir(dir);
      } catch {
        continue;
      }
      foundAny = true;
      for (const entry of entries) {
        const match = /^stats-pid-(.+)\.json$/.exec(entry);
        if (!match)
          continue;
        try {
          const raw = JSON.parse(await fs2.readFile(path2.join(dir, entry), "utf8"));
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
  aggregate(files) {
    if (files.length === 0)
      return null;
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
    return acc;
  }
  async getStats(scope = {}) {
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
        scoped: null,
        scope: { kind: "all", label: "All time" },
        pricing: null,
        processes: [],
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
        tools: newest.tools
      };
    }
    const processes = sorted.map((f) => ({
      pid: f.pid,
      startedAt: f.sessionStart,
      updatedAt: f.updatedAt,
      totalCalls: f.totalCalls,
      tokensSaved: f.tokensSaved
    }));
    let scopedFiles = files;
    let scopeEcho = { kind: "all", label: "All time" };
    let windowStart = 0;
    let windowEnd = generatedAt;
    if (scope.pid) {
      scopedFiles = files.filter((f) => f.pid === scope.pid);
      const p = scopedFiles[0];
      scopeEcho = {
        kind: "process",
        label: p ? `Process ${p.pid}` : `Process ${scope.pid} (not found)`
      };
      if (p) {
        windowStart = p.sessionStart;
        windowEnd = p.updatedAt > p.sessionStart ? p.updatedAt : generatedAt;
      }
    } else if (scope.from || scope.to) {
      const fromMs = scope.from ? dayStartMs(scope.from) : null;
      const toMs = scope.to ? dayStartMs(scope.to) : null;
      const startMs = fromMs ?? 0;
      const endMs = toMs !== null ? toMs + 86399999 : generatedAt;
      scopedFiles = files.filter((f) => f.sessionStart >= startMs && f.sessionStart <= endMs);
      scopeEcho = {
        kind: "range",
        label: scope.from && scope.to ? `${scope.from} → ${scope.to}` : scope.from ? `Since ${scope.from}` : `Until ${scope.to}`
      };
      windowStart = startMs;
      windowEnd = endMs;
    } else {
      const starts = files.map((f) => f.sessionStart).filter((s) => s > 0);
      windowStart = starts.length > 0 ? Math.min(...starts) : 0;
    }
    const scoped = this.aggregate(scopedFiles);
    const pricing = scoped ? await this.pricing.price(windowStart, windowEnd, scoped.tokensSaved) : null;
    const dayMap = new Map;
    for (const f of scopedFiles) {
      if (f.sessionStart <= 0)
        continue;
      const key = dayKey(f.sessionStart);
      const point = dayMap.get(key) ?? {
        day: key,
        tokensSaved: 0,
        calls: 0,
        bytesProcessed: 0,
        sessions: 0
      };
      point.tokensSaved += f.tokensSaved;
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
      scoped,
      scope: scopeEcho,
      pricing,
      processes,
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
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
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
      const scope = {};
      const pid = (url.searchParams.get("pid") ?? "").trim();
      const from = (url.searchParams.get("from") ?? "").trim();
      const to = (url.searchParams.get("to") ?? "").trim();
      if (pid)
        scope.pid = pid;
      else {
        if (DAY_RE.test(from))
          scope.from = from;
        if (DAY_RE.test(to))
          scope.to = to;
      }
      sendJson(res, 200, await store.getStats(scope));
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
