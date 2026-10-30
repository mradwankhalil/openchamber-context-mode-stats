/**
 * Context Mode for OpenChamber — local service.
 *
 * Spawned by the OpenChamber host (manifest `contributes.service`) on
 * 127.0.0.1 and reachable only through the host proxy. Read-only over
 * context-mode's OpenCode stores and OpenCode's database.
 *
 * Every data route is POST with a JSON body carrying the panel's settings
 * (the service inherits no environment, so locations and privacy travel with
 * each request) plus the route's own parameters:
 *
 *   GET  /health
 *   POST /v1/status      { settings }
 *   POST /v1/overview    { settings, filter, topN }
 *   POST /v1/sessions    { settings, filter, sort, dir, offset, limit }
 *   POST /v1/session     { settings, id, offset, limit, types, topN }
 *   POST /v1/insights    { settings, filter, topN }
 *   POST /v1/runs        { settings, filter, offset, limit }
 *   POST /v1/knowledge   { settings, filter, offset, limit, sort }
 *   POST /v1/brief       { settings, sessionId, directory }
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Engine } from "./engine.ts"
import { normalizeFilter, normalizeSettings } from "./settings.ts"
import { clampInt } from "./util.ts"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[context-mode] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

const engine = new Engine()
const MAX_BODY = 256 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
    res.end(payload)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []
        req.on("data", (c: Buffer) => {
            size += c.length
            if (size > MAX_BODY) {
                reject(new Error("body too large"))
                req.destroy()
                return
            }
            chunks.push(c)
        })
        req.on("end", () => {
            if (!chunks.length) return resolve({})
            try {
                const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
                resolve(typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
            } catch {
                reject(new Error("invalid JSON body"))
            }
        })
        req.on("error", reject)
    })
}

const topN = (b: Record<string, unknown>) => clampInt(b.topN, 3, 100, 10)

const routes: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
    "/v1/status": async (b) => engine.status(await engine.prepare(normalizeSettings(b.settings))),
    "/v1/overview": async (b) => engine.overview(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), topN(b)),
    "/v1/sessions": async (b) => engine.sessionsPage(
        await engine.prepare(normalizeSettings(b.settings)),
        normalizeFilter(b.filter),
        typeof b.sort === "string" ? b.sort : "last",
        b.dir === "asc" ? "asc" : "desc",
        clampInt(b.offset, 0, 1_000_000, 0),
        clampInt(b.limit, 1, 500, 50),
    ),
    "/v1/session": async (b) => {
        const ctx = await engine.prepare(normalizeSettings(b.settings))
        const id = typeof b.id === "string" ? b.id.slice(0, 200) : ""
        const types = Array.isArray(b.types) ? b.types.filter((t): t is string => typeof t === "string").slice(0, 40) : null
        const detail = id ? engine.detail(ctx, id, { offset: clampInt(b.offset, 0, 1_000_000, 0), limit: clampInt(b.limit, 1, 500, 150), types, topN: topN(b) }) : null
        return detail ?? { ok: false, error: "session not found", code: "NOT_FOUND" }
    },
    "/v1/insights": async (b) => engine.insights(await engine.prepare(normalizeSettings(b.settings)), normalizeFilter(b.filter), topN(b)),
    "/v1/runs": async (b) => engine.runsPayload(
        await engine.prepare(normalizeSettings(b.settings)),
        normalizeFilter(b.filter),
        clampInt(b.offset, 0, 1_000_000, 0),
        clampInt(b.limit, 1, 500, 50),
    ),
    "/v1/knowledge": async (b) => engine.knowledgePayload(
        await engine.prepare(normalizeSettings(b.settings)),
        normalizeFilter(b.filter),
        clampInt(b.offset, 0, 1_000_000, 0),
        clampInt(b.limit, 1, 500, 50),
        b.sort === "chunks" ? "chunks" : "recent",
    ),
    "/v1/brief": async (b) => engine.brief(
        await engine.prepare(normalizeSettings(b.settings)),
        typeof b.sessionId === "string" ? b.sessionId : null,
        typeof b.directory === "string" ? b.directory : null,
    ),
}

const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
        send(res, 401, { ok: false, error: "unauthorized" })
        return
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    try {
        if (req.method === "GET" && url.pathname === "/health") {
            send(res, 200, { ok: true })
            return
        }
        const route = routes[url.pathname]
        if (!route || req.method !== "POST") {
            send(res, 404, { ok: false, error: "not found" })
            return
        }
        send(res, 200, await route(await readBody(req)))
    } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[context-mode] listening on 127.0.0.1:${port} (node ${process.versions.node})`)
})
