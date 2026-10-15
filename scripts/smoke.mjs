/**
 * Smoke test for the built service.
 *
 * Starts `service/main.js` against a temporary stats directory, then checks
 * the auth gate, `/health` and `/stats`.
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

const statsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-stats-smoke-"))

await fs.writeFile(
    path.join(statsDir, "stats-pid-1234.json"),
    JSON.stringify({
        schemaVersion: 2,
        updated_at: Date.now(),
        session_start: Date.now() - 60_000,
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
        dollars_saved_session: 0.5,
        by_tool: {
            ctx_execute: { calls: 30, bytes: 300_000 },
            ctx_search: { calls: 12, bytes: 100_000 },
        },
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
    },
    stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
child.stderr.on("data", (chunk) => {
    stderr += chunk
})

try {
    const base = `http://127.0.0.1:${port}`

    // wait for the server to accept connections
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

    // auth gate
    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401, "health without token must be 401")

    const headers = { authorization: `Bearer ${token}` }

    const health = await fetch(`${base}/health`, { headers })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const stats = await fetch(`${base}/stats`, { headers })
    assert.equal(stats.status, 200)
    const body = await stats.json()
    assert.equal(body.ok, true)
    assert.equal(body.live.pid, "1234")
    assert.equal(body.live.totalCalls, 42)
    assert.equal(body.live.tokensSaved, 100_000)
    assert.equal(body.live.tools.length, 2)
    assert.equal(body.allTime.processes, 1, "broken file must be skipped")
    assert.equal(body.allTime.tokensSaved, 100_000)
    assert.equal(body.allTime.tools[0].name, "ctx_execute")
    assert.ok(Array.isArray(body.daily) && body.daily.length === 1)

    const missing = await fetch(`${base}/nope`, { headers })
    assert.equal(missing.status, 404)

    console.log("smoke ok: auth, /health, /stats, aggregation, malformed-file skip")
} finally {
    child.kill("SIGTERM")
    await fs.rm(statsDir, { recursive: true, force: true })
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) {
        console.error(stderr)
    }
}
