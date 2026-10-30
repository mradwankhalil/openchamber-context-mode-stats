/** Calls to the extension's local service through the host proxy. */

import { HostRequestError } from "@openchamber/sdk"
import type { HostClient } from "@openchamber/sdk"
import type { ServiceSettings } from "../service/types.ts"

export class ServiceError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
        super(message)
        this.code = code
    }
}

const FRIENDLY: Record<string, string> = {
    NO_SERVICE: "The extension's local service is not running. Approve “Run a local service” for this extension in Settings → Extensions.",
    DISABLED: "This extension is paused in Settings → Extensions.",
    SERVICE_FAILED: "The local service crashed or did not start. It restarts on the next refresh.",
    REQUEST_FAILED: "The local service did not answer in time. It may still be indexing.",
    HOST_TIMEOUT: "OpenChamber did not answer in time.",
    HOST_UNAVAILABLE: "This page is not running inside OpenChamber.",
    RESPONSE_TOO_LARGE: "The answer was too large. Lower the page size in Settings.",
}

export function friendly(error: unknown): { code: string; message: string } {
    if (error instanceof ServiceError) return { code: error.code, message: error.message }
    if (error instanceof HostRequestError) return { code: error.code, message: FRIENDLY[error.code] ?? error.message }
    return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) }
}

export function createApi(host: HostClient, settings: () => ServiceSettings) {
    return async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
        const res = await host.serviceRequest({ method: "POST", path, body: JSON.stringify({ ...body, settings: settings() }) })
        let payload: unknown = res.body
        if (typeof payload === "string") {
            try {
                payload = JSON.parse(payload)
            } catch {
                throw new ServiceError("BAD_RESPONSE", "The local service answered with something that is not JSON.")
            }
        }
        const p = payload as { ok?: boolean; error?: string; code?: string }
        if (res.status >= 400 || !p || p.ok === false) {
            throw new ServiceError(p?.code ?? `HTTP_${res.status}`, p?.error ?? `The local service answered ${res.status}.`)
        }
        return payload as T
    }
}

export type Api = ReturnType<typeof createApi>
