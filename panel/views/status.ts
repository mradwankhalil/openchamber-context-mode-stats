/** The compact card in the chat's Work Status panel: this chat's context, at a glance. */

import type { BriefPayload } from "../../service/types.ts"
import type { App } from "../app.ts"
import { trail } from "../charts.ts"
import { h, replace } from "../dom.ts"
import { bytes, count, duration, full } from "../format.ts"

export async function renderStatus(app: App, el: HTMLElement, isStale: () => boolean): Promise<void> {
    const b = await app.api<BriefPayload>("/v1/brief", { sessionId: app.current.sessionId, directory: app.current.directory })
    if (isStale()) return
    const s = b.session
    const lives = b.liveRuns
    const sum = (f: (r: (typeof lives)[number]) => number) => lives.reduce((a, r) => a + f(r), 0)
    const liveLine = lives.length
        ? h("div.status-line", null,
            h("span", null, "context-mode ", h("b", null, full(sum((r) => r.calls))), " calls"),
            h("span", null, h("b", null, bytes(sum((r) => r.bytesReturned))), " returned"),
            h("span", null, h("b", null, bytes(sum((r) => r.bytesIndexed))), " indexed"),
            h("span", null, "up ", duration(Math.max(...lives.map((r) => r.uptimeMs)))))
        : h("div.status-line", null, "context-mode server not running")
    if (b.progress.phase === "scanning" && !s) {
        replace(el, h("div.status", null, h("div.status-line", null, `Indexing context-mode history… ${full(b.progress.done)} / ${full(b.progress.total)}`), liveLine))
        return
    }
    if (!s) {
        replace(el, h("div.status", null,
            h("div.status-line", null, app.current.sessionId ? "No context-mode events for this chat yet." : "Open a chat to see its context."),
            b.project ? h("div.status-line", null, h("span", null, h("b", null, full(b.project.sessions)), " sessions in this project"), h("span", null, h("b", null, count(b.project.tokens)), " tokens")) : null,
            liveLine))
        return
    }
    const latest = s.usage.lastContext
    replace(el, h("div.status", null,
        h("div.status-top", null,
            h("b", null, "This chat"),
            h("span.status-ctx", { title: "Prompt size of the latest model step, and the largest so far" }, "context ", h("b", null, count(latest)), ` · peak ${count(s.usage.peakContext)}`)),
        b.contextTrail.length > 1 ? trail(b.contextTrail, 34) : null,
        h("div.status-line", null,
            h("span", null, h("b", null, full(s.tally.prompts)), " prompts"),
            h("span", null, h("b", null, full(s.usage.steps)), " steps"),
            h("span", null, h("b", null, count(s.usage.tokensIn + s.usage.cacheRead + s.usage.cacheWrite)), " tokens read"),
            s.tally.errors ? h("span", null, h("b", { style: "color:var(--oc-error-text)" }, full(s.tally.errors)), " errors") : null,
            s.tally.compactions ? h("span", null, h("b", null, full(s.tally.compactions)), " compactions") : null,
            s.childCount ? h("span", null, h("b", null, full(s.childCount)), " subagents") : null),
        liveLine))
}
