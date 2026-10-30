/**
 * Development host: serves the package, runs the built service the way
 * OpenChamber does (loopback port + bearer token), and proxies the harness's
 * service calls to it. Open http://127.0.0.1:<port>/dev/harness.html.
 *
 *   bun run build && node dev/server.ts [--port 5178]
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createReadStream, statSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const argPort = process.argv.indexOf("--port")
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : 5178

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
    })
    s.on("error", reject)
})

const servicePort = await freePort()
const token = randomBytes(16).toString("hex")
const child = spawn(process.execPath, ["--no-warnings", path.join(root, "service", "main.js")], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token },
    stdio: ["ignore", "inherit", "inherit"],
})
child.on("exit", (code) => {
    console.error(`[dev] service exited with ${code}`)
    process.exit(1)
})
process.on("exit", () => child.kill())

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png",
}

http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname.startsWith("/svc/")) {
        const chunks: Buffer[] = []
        req.on("data", (c: Buffer) => chunks.push(c))
        req.on("end", () => {
            const up = http.request({
                host: "127.0.0.1", port: servicePort, path: url.pathname.slice(4), method: req.method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            }, (r) => {
                res.writeHead(r.statusCode ?? 502, { "content-type": "application/json" })
                r.pipe(res)
            })
            up.on("error", (e) => {
                res.writeHead(502, { "content-type": "application/json" })
                res.end(JSON.stringify({ ok: false, error: e.message, code: "SERVICE_FAILED" }))
            })
            up.end(Buffer.concat(chunks))
        })
        return
    }
    const rel = decodeURIComponent(url.pathname === "/" ? "/dev/harness.html" : url.pathname)
    const file = path.join(root, rel)
    if (!file.startsWith(root) || rel.includes("node_modules")) {
        res.writeHead(403).end()
        return
    }
    const st = statSync(file, { throwIfNoEntry: false })
    if (!st?.isFile()) {
        res.writeHead(404).end("not found")
        return
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" })
    createReadStream(file).pipe(res)
}).listen(port, "127.0.0.1", () => {
    console.log(`[dev] harness http://127.0.0.1:${port}/dev/harness.html  (service on ${servicePort})`)
})
