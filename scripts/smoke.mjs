/**
 * Smoke test for the built service.
 *
 * Starts `service/main.js` against a temporary stats directory (with pricing
 * disabled via an unreachable db), then checks the auth gate, `/health`,
 * `/stats` aggregation and scope filtering.
 *
 * Run after `bun run build`:  node scripts/smoke.mjs
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { createServer } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serviceEntry = path.join(root, "service", "main.js")

async function freePort() {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
}

function dayKey(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${m}-${day}`
}

const statsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-stats-smoke-"))

const now = Date.now()
const yesterday = now - 86400e3

await fs.writeFile(
    path.join(statsDir, "stats-pid-1234.json"),
    JSON.stringify({
        schemaVersion: 2,
        updated_at: now,
        session_start: now - 60_000,
        uptime_ms: 60_000,
        total_calls: 42,
        bytes_returned: 100_000,
        bytes_indexed: 50_000,
        bytes_sandboxed: 200_000,
        cache_hits: 3,
        cache_bytes_saved: 10_000,
        kept_out: 400_000,
        total_processed: 500_000,
        reduction_pct: 80,
        tokens_saved: 100_000,
        by_tool: {
            ctx_execute: { calls: 30, bytes: 300_000 },
            ctx_search: { calls: 12, bytes: 100_000 },
        },
    }),
)
await fs.writeFile(
    path.join(statsDir, "stats-pid-9999.json"),
    JSON.stringify({
        schemaVersion: 2,
        updated_at: yesterday,
        session_start: yesterday - 3600e3,
        uptime_ms: 3600e3,
        total_calls: 10,
        bytes_returned: 10_000,
        bytes_indexed: 0,
        bytes_sandboxed: 40_000,
        cache_hits: 0,
        cache_bytes_saved: 0,
        kept_out: 40_000,
        total_processed: 50_000,
        reduction_pct: 80,
        tokens_saved: 10_000,
        by_tool: { ctx_search: { calls: 10, bytes: 40_000 } },
    }),
)
await fs.writeFile(path.join(statsDir, "stats-pid-broken.json"), "{not json")

const port = await freePort()
const token = "smoke-token"
const child = spawn(process.execPath, [serviceEntry], {
    env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: token,
        CONTEXT_MODE_STATS_DIR: statsDir,
        // keep pricing hermetic: no real db, no network cache reuse
        OPENCODE_DB_PATH: path.join(statsDir, "does-not-exist.db"),
        STATS_PRICING_CACHE: path.join(statsDir, "no-cache.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
child.stderr.on("data", (chunk) => {
    stderr += chunk
})

try {
    const base = `http://127.0.0.1:${port}`

    let up = false
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(`${base}/health`)
            up = true
            break
        } catch {
            await new Promise((r) => setTimeout(r, 100))
        }
    }
    if (!up) throw new Error("service did not start:\n" + stderr)

    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401, "health without token must be 401")

    const headers = { authorization: `Bearer ${token}` }

    const health = await fetch(`${base}/health`, { headers })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    // ---- unscoped
    const stats = await fetch(`${base}/stats`, { headers })
    assert.equal(stats.status, 200)
    const body = await stats.json()
    assert.equal(body.ok, true)
    assert.equal(body.live.pid, "1234")
    assert.equal(body.live.totalCalls, 42)
    assert.equal(body.live.tokensSaved, 100_000)
    assert.equal(body.live.tools.length, 2)
    assert.equal(body.scope.kind, "all")
    assert.equal(body.scoped.processes, 2, "broken file must be skipped")
    assert.equal(body.scoped.tokensSaved, 110_000)
    assert.equal(body.scoped.tools[0].name, "ctx_execute")
    assert.equal(body.processes.length, 2)
    assert.equal(body.processes[0].pid, "1234", "newest first")
    assert.ok(Array.isArray(body.daily) && body.daily.length === 2)

    // ---- pid scope
    const pidStats = await fetch(`${base}/stats?pid=9999`, { headers })
    const pidBody = await pidStats.json()
    assert.equal(pidBody.scope.kind, "process")
    assert.equal(pidBody.scoped.processes, 1)
    assert.equal(pidBody.scoped.tokensSaved, 10_000)
    assert.equal(pidBody.daily.length, 1)

    // ---- range scope (today only)
    const today = dayKey(new Date())
    const rangeStats = await fetch(`${base}/stats?from=${today}&to=${today}`, { headers })
    const rangeBody = await rangeStats.json()
    assert.equal(rangeBody.scope.kind, "range")
    assert.equal(rangeBody.scoped.processes, 1, "only today's process")
    assert.equal(rangeBody.scoped.tokensSaved, 100_000)

    // ---- range excluding everything
    const old = "2020-01-01"
    const emptyStats = await fetch(`${base}/stats?from=${old}&to=${old}`, { headers })
    const emptyBody = await emptyStats.json()
    assert.equal(emptyBody.scoped, null, "no processes in range")

    const missing = await fetch(`${base}/nope`, { headers })
    assert.equal(missing.status, 404)

    console.log("smoke ok: auth, /health, /stats, scopes (all/pid/range/empty), malformed-file skip")
} finally {
    child.kill("SIGTERM")
    await fs.rm(statsDir, { recursive: true, force: true })
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) {
        console.error(stderr)
    }
}
