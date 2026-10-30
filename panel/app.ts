/** The contract every view renders against. Implemented in main.ts. */

import type { HostClient } from "@openchamber/sdk"
import type { StatusPayload } from "../service/types.ts"
import type { Api } from "./api.ts"
import type { UiSettings, ViewState } from "./state.ts"

export interface App {
    host: HostClient
    api: Api
    settings: UiSettings
    view: ViewState
    status: StatusPayload | null
    /** The chat OpenChamber has open, when it reports one. */
    current: { sessionId: string | null; directory: string | null }
    /** Patch view state and re-render (scroll resets unless `keepScroll`). */
    go(patch: Partial<ViewState>, opts?: { keepScroll?: boolean }): void
    saveSettings(next: UiSettings): Promise<void>
    refresh(): void
    copy(text: string, what: string): void
    toast(message: string, kind?: "info" | "success" | "error"): void
}

/** Views render into `el` and may be re-run on every refresh; `isStale` turns true once a newer render started. */
export type ViewRenderer = (app: App, el: HTMLElement, isStale: () => boolean) => Promise<void>
