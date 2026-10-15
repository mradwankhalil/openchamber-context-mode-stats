/**
 * Context Mode Stats — OpenChamber extension panel.
 *
 * One page serves two surfaces:
 *  - `panel`: the rail side panel with the full report.
 *  - `status`: the compact section in the chat's Work Status panel.
 *
 * The page is a thin view. The extension's local service reads the
 * context-mode stats files and returns the numbers; this file only renders
 * them. Charts are hand-rolled SVG/divs — no dependencies.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk"
import type { HostReadyContext } from "@openchamber/sdk"
import { applyHostReady, mountBanner, mountButton } from "@openchamber/sdk/ui"
import type { BannerHandle, ButtonHandle } from "@openchamber/sdk/ui"
import type { AllTime, DayPoint, LiveProcess, StatsPayload, ToolStat } from "../service/stats"

const POLL_MS = 4000
const DAILY_WINDOW = 30
const TOP_TOOLS = 8

const host = connectHost()
const rootElement = document.querySelector<HTMLElement>("#root")
if (!rootElement) {
    throw new Error("Missing #root")
}
const root = rootElement

type Notice = {
    tone: "info" | "success" | "warning" | "error"
    title: string
    body?: string
}

type MetricRow = {
    label: string
    value: string
    tone?: "success"
}

let mounted = false
let surface: "panel" | "status" = "panel"
let payload: StatsPayload | null = null
let notice: Notice | null = null
let pollTimer: number | null = null
let fetchSeq = 0
let lastStatusHeight = -1

let refs: {
    subtitle: HTMLElement
    notice: HTMLElement
    liveMeta: HTMLElement
    liveMetrics: HTMLElement
    liveDonut: HTMLElement
    liveTools: HTMLElement
    liveHint: HTMLElement
    allTimeMetrics: HTMLElement
    allTimeDonut: HTMLElement
    allTimeTools: HTMLElement
    dailyChart: HTMLElement
    dailyMeta: HTMLElement
    refresh: ButtonHandle
} | null = null

let statusRefs: {
    saved: HTMLElement
    ratio: HTMLElement
    sub: HTMLElement
} | null = null

let noticeHandle: BannerHandle | null = null

// ---------------------------------------------------------------- dom helpers

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

// -------------------------------------------------------------------- charts

/** Donut chart. Segments share 100% of the ring; center shows `centerLabel`. */
function donut(
    segments: { label: string; value: number; className: string }[],
    centerValue: string,
    centerLabel: string,
): SVGSVGElement {
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
    const size = 120
    const stroke = 18
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const svgNS = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(svgNS, "svg")
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`)
    svg.setAttribute("class", "cm-donut")

    const track = document.createElementNS(svgNS, "circle")
    track.setAttribute("cx", String(size / 2))
    track.setAttribute("cy", String(size / 2))
    track.setAttribute("r", String(radius))
    track.setAttribute("class", "cm-donut-track")
    track.setAttribute("stroke-width", String(stroke))
    track.setAttribute("fill", "none")
    svg.appendChild(track)

    if (total > 0) {
        let offset = 0
        for (const seg of segments) {
            const frac = Math.max(0, seg.value) / total
            if (frac <= 0) continue
            const arc = document.createElementNS(svgNS, "circle")
            arc.setAttribute("cx", String(size / 2))
            arc.setAttribute("cy", String(size / 2))
            arc.setAttribute("r", String(radius))
            arc.setAttribute("class", `cm-donut-seg ${seg.className}`)
            arc.setAttribute("stroke-width", String(stroke))
            arc.setAttribute("fill", "none")
            arc.setAttribute("stroke-dasharray", `${frac * circumference} ${circumference}`)
            arc.setAttribute("stroke-dashoffset", String(-offset * circumference))
            arc.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`)
            const title = document.createElementNS(svgNS, "title")
            title.textContent = `${seg.label}: ${(frac * 100).toFixed(1)}%`
            arc.appendChild(title)
            svg.appendChild(arc)
            offset += frac
        }
    }

    const valueText = document.createElementNS(svgNS, "text")
    valueText.setAttribute("x", String(size / 2))
    valueText.setAttribute("y", String(size / 2 - 2))
    valueText.setAttribute("class", "cm-donut-value")
    valueText.setAttribute("text-anchor", "middle")
    valueText.textContent = centerValue
    const labelText = document.createElementNS(svgNS, "text")
    labelText.setAttribute("x", String(size / 2))
    labelText.setAttribute("y", String(size / 2 + 14))
    labelText.setAttribute("class", "cm-donut-label")
    labelText.setAttribute("text-anchor", "middle")
    labelText.textContent = centerLabel
    svg.appendChild(valueText)
    svg.appendChild(labelText)
    return svg
}

function donutLegend(
    segments: { label: string; value: number; className: string }[],
    format: (value: number) => string,
): HTMLElement {
    const legend = el("div", "cm-legend")
    for (const seg of segments) {
        const row = el("div", "cm-legend-row")
        row.append(
            el("span", `cm-legend-dot ${seg.className}`),
            el("span", "cm-legend-label", seg.label),
            el("span", "cm-legend-value", format(seg.value)),
        )
        legend.appendChild(row)
    }
    return legend
}

/** Horizontal bar list for ranked data (per-tool/per-command). */
function hbarChart(
    rows: { label: string; value: number; display: string }[],
): HTMLElement {
    const wrap = el("div", "cm-hbars")
    const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
    for (const row of rows) {
        const item = el("div", "cm-hbar")
        const head = el("div", "cm-hbar-head")
        head.append(
            el("span", "cm-hbar-label", row.label),
            el("span", "cm-hbar-value", row.display),
        )
        const track = el("div", "cm-hbar-track")
        const fill = el("div", "cm-hbar-fill")
        fill.style.width = max > 0 ? `${Math.max(2, (row.value / max) * 100)}%` : "0%"
        track.appendChild(fill)
        item.append(head, track)
        wrap.appendChild(item)
    }
    return wrap
}

/** Column chart for the daily savings series. */
function columnChart(points: DayPoint[]): HTMLElement {
    const wrap = el("div", "cm-cols")
    const shown = points.slice(-DAILY_WINDOW)
    const max = shown.reduce((m, p) => Math.max(m, p.tokensSaved), 0)
    const svgNS = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(svgNS, "svg")
    svg.setAttribute("class", "cm-cols-svg")
    const width = Math.max(120, shown.length * 14)
    const height = 72
    const barWidth = 10
    svg.setAttribute("viewBox", `0 0 ${width} ${height + 16}`)
    svg.setAttribute("preserveAspectRatio", "none")

    shown.forEach((point, i) => {
        const frac = max > 0 ? point.tokensSaved / max : 0
        const barHeight = Math.max(point.tokensSaved > 0 ? 2 : 0, frac * (height - 6))
        const rect = document.createElementNS(svgNS, "rect")
        rect.setAttribute("x", String(i * 14 + 2))
        rect.setAttribute("y", String(height - barHeight))
        rect.setAttribute("width", String(barWidth))
        rect.setAttribute("height", String(barHeight))
        rect.setAttribute("rx", "2")
        rect.setAttribute("class", "cm-col")
        const title = document.createElementNS(svgNS, "title")
        title.textContent = `${point.day}: ~${formatTokens(point.tokensSaved)} tokens saved · ${plural(point.calls, "call")}`
        rect.appendChild(title)
        svg.appendChild(rect)
    })

    // x-axis labels: first, middle, last day (MM-DD)
    const labelIndices = [...new Set([0, Math.floor((shown.length - 1) / 2), shown.length - 1])]
    for (const i of labelIndices) {
        const point = shown[i]
        if (!point) continue
        const text = document.createElementNS(svgNS, "text")
        text.setAttribute("x", String(i * 14 + 2))
        text.setAttribute("y", String(height + 12))
        text.setAttribute("class", "cm-col-label")
        text.textContent = point.day.slice(5)
        svg.appendChild(text)
    }

    wrap.appendChild(svg)
    return wrap
}

// -------------------------------------------------------------------- mounting

function section(title: string): { sectionEl: HTMLElement; meta: HTMLElement } {
    const sectionEl = el("section", "cm-section")
    const header = el("div", "cm-section-header")
    const meta = el("span", "cm-section-meta", "")
    header.append(el("span", undefined, title), meta)
    sectionEl.appendChild(header)
    return { sectionEl, meta }
}

function mountPanel(): void {
    const panel = el("div", "cm cm-panel")

    const header = el("div", "cm-header")
    const heading = el("div", "cm-heading")
    const title = el("div", "cm-title", "Context Mode")
    const subtitle = el("div", "cm-subtitle", "")
    heading.append(title, subtitle)
    const actions = el("div", "cm-actions")
    const refresh = mountButton(actions, {
        label: "Refresh",
        variant: "ghost",
        size: "xs",
        onClick: () => void refreshStats(),
    })
    header.append(heading, actions)

    const noticeEl = el("div", "cm-notice")
    const body = el("div", "cm-body")

    // Live process
    const live = section("Live process")
    const liveMetrics = el("div", "cm-metrics")
    const liveDonut = el("div", "cm-chart")
    const liveTools = el("div", "cm-subsection")
    const liveHint = el("div", "cm-hint")
    live.sectionEl.append(liveMetrics, liveDonut, liveTools, liveHint)

    // All-time
    const allTime = section("All-time")
    const allTimeMetrics = el("div", "cm-metrics")
    const allTimeDonut = el("div", "cm-chart")
    const allTimeTools = el("div", "cm-subsection")
    allTime.sectionEl.append(allTimeMetrics, allTimeDonut, allTimeTools)

    // Daily series
    const daily = section("Tokens saved per day")
    const dailyChart = el("div", "cm-chart")
    daily.sectionEl.appendChild(dailyChart)

    body.append(live.sectionEl, allTime.sectionEl, daily.sectionEl)
    panel.append(header, noticeEl, body)
    root.replaceChildren(panel)

    refs = {
        subtitle,
        notice: noticeEl,
        liveMeta: live.meta,
        liveMetrics,
        liveDonut,
        liveTools,
        liveHint,
        allTimeMetrics,
        allTimeDonut,
        allTimeTools,
        dailyChart,
        dailyMeta: daily.meta,
        refresh,
    }
}

function mountStatus(): void {
    const status = el("div", "cm cm-status")
    const main = el("div", "cm-status-main")
    const saved = el("span", "cm-status-saved", "Context Mode")
    const ratio = el("span", "cm-status-ratio")
    ratio.hidden = true
    main.append(saved, ratio)
    const sub = el("div", "cm-status-sub", "")
    status.append(main, sub)
    root.replaceChildren(status)
    statusRefs = { saved, ratio, sub }
}

// -------------------------------------------------------------------- fetching

async function refreshStats(): Promise<void> {
    const seq = ++fetchSeq
    refs?.refresh.update({ loading: true })
    try {
        const result = await host.serviceRequest({ method: "GET", path: "/stats" })
        if (seq !== fetchSeq) return
        if (result.status !== 200) {
            throw new Error(`stats service responded with HTTP ${result.status}`)
        }
        payload = JSON.parse(result.body) as StatsPayload
        notice = null
    } catch (error) {
        if (seq !== fetchSeq) return
        notice = describeError(error)
    } finally {
        if (seq === fetchSeq) {
            refs?.refresh.update({ loading: false })
            render()
        }
    }
}

function describeError(error: unknown): Notice {
    if (error instanceof HostRequestError) {
        switch (error.code) {
            case "NO_SERVICE":
                return {
                    tone: "warning",
                    title: "Local service not approved",
                    body: "Open Settings → Extensions, select Context Mode Stats, and allow its local service. Then retry.",
                }
            case "DISABLED":
                return {
                    tone: "info",
                    title: "Context Mode Stats is paused",
                    body: "Enable the extension in Settings → Extensions.",
                }
            case "SERVICE_FAILED":
            case "HOST_TIMEOUT":
                return {
                    tone: "error",
                    title: "Stats service is not responding",
                    body: "Retry, or restart OpenChamber if it keeps failing.",
                }
            default:
                return { tone: "error", title: "Could not load stats", body: error.message }
        }
    }
    return {
        tone: "error",
        title: "Could not load stats",
        body: error instanceof Error ? error.message : String(error),
    }
}

function startPolling(): void {
    if (pollTimer !== null) return
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refreshStats()
    }, POLL_MS)
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void refreshStats()
    })
}

// -------------------------------------------------------------------- render

function render(): void {
    if (surface === "status") {
        renderStatus()
        return
    }
    if (!refs) return

    refs.subtitle.textContent = "context-mode savings"
    renderNotice()

    const live = payload?.live ?? null
    const allTime = payload?.allTime ?? null
    const daily = payload?.daily ?? []

    // ---- live
    refs.liveMeta.textContent = live
        ? payload?.liveStale
            ? `pid ${live.pid} · idle`
            : `pid ${live.pid} · active`
        : ""
    renderMetrics(refs.liveMetrics, live ? liveRows(live) : [])
    renderBytesDonut(refs.liveDonut, live ? liveSegments(live) : null)
    renderToolBars(refs.liveTools, live?.tools ?? [])
    setHint(refs.liveHint, liveHintContent(live))

    // ---- all-time
    renderMetrics(refs.allTimeMetrics, allTime ? allTimeRows(allTime) : [])
    renderBytesDonut(refs.allTimeDonut, allTime ? allTimeSegments(allTime) : null)
    renderToolBars(refs.allTimeTools, allTime?.tools ?? [])

    // ---- daily
    refs.dailyMeta.textContent =
        daily.length > 0 ? `last ${Math.min(daily.length, DAILY_WINDOW)} of ${plural(daily.length, "day")}` : ""
    refs.dailyChart.replaceChildren()
    if (daily.length > 0) refs.dailyChart.appendChild(columnChart(daily))
    else refs.dailyChart.hidden = true
}

function renderNotice(): void {
    if (!refs) return
    noticeHandle?.dispose()
    noticeHandle = null
    refs.notice.replaceChildren()
    if (!notice) return
    const showRetry = notice.tone === "error" || notice.tone === "warning"
    noticeHandle = mountBanner(refs.notice, {
        tone: notice.tone,
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
        ...(showRetry ? { action: { label: "Retry", onClick: () => void refreshStats() } } : {}),
    })
}

function renderStatus(): void {
    if (!statusRefs) return
    const live = payload?.live ?? null
    const allTime = payload?.allTime ?? null

    if (notice) {
        statusRefs.saved.textContent = "Context Mode"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = notice.title
        statusRefs.sub.classList.add("cm-status-error")
    } else if (payload?.reason === "storage-missing") {
        statusRefs.saved.textContent = "Context Mode"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = "stats folder not found"
        statusRefs.sub.classList.add("cm-status-error")
    } else if (live || allTime) {
        const tokens = live?.tokensSaved ?? 0
        statusRefs.saved.textContent = `~${formatTokens(tokens)} tokens saved`
        statusRefs.ratio.hidden = false
        statusRefs.ratio.textContent = `${live?.reductionPct ?? 0}% kept out`
        const bits: string[] = []
        if (live) bits.push(plural(live.totalCalls, "call"))
        if (allTime) bits.push(`all-time ~${formatTokens(allTime.tokensSaved)}`)
        statusRefs.sub.textContent = bits.join(" · ")
        statusRefs.sub.classList.remove("cm-status-error")
    } else {
        statusRefs.saved.textContent = "Context Mode"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = "No stats recorded yet"
        statusRefs.sub.classList.remove("cm-status-error")
    }

    syncStatusHeight()
}

function renderMetrics(container: HTMLElement, rows: MetricRow[]): void {
    container.replaceChildren(
        ...rows.map((row) => {
            const item = el("div", "cm-metric")
            const label = el("span", "cm-metric-label", row.label)
            const value = el("span", "cm-metric-value", row.value)
            if (row.tone) value.dataset.tone = row.tone
            item.append(label, value)
            return item
        }),
    )
    container.hidden = rows.length === 0
}

type BytesSegments = { label: string; value: number; className: string }[]

function renderBytesDonut(container: HTMLElement, segments: BytesSegments | null): void {
    container.replaceChildren()
    if (!segments) {
        container.hidden = true
        return
    }
    const total = segments.reduce((sum, s) => sum + s.value, 0)
    if (total <= 0) {
        container.hidden = true
        return
    }
    container.hidden = false
    const kept = segments.find((s) => s.className === "cm-seg-kept")?.value ?? 0
    const pct = Math.round((kept / total) * 100)
    const chart = el("div", "cm-donut-wrap")
    chart.appendChild(donut(segments, `${pct}%`, "kept out"))
    chart.appendChild(donutLegend(segments, formatBytes))
    container.appendChild(chart)
}

function renderToolBars(container: HTMLElement, tools: ToolStat[]): void {
    container.replaceChildren()
    if (tools.length === 0) {
        container.hidden = true
        return
    }
    container.hidden = false
    const top = tools.slice(0, TOP_TOOLS)
    container.appendChild(el("div", "cm-subsection-title", "Top tools by bytes"))
    container.appendChild(
        hbarChart(
            top.map((t) => ({
                label: t.name,
                value: t.bytes,
                display: `${formatBytes(t.bytes)} · ${plural(t.calls, "call")}`,
            })),
        ),
    )
}

function liveHintContent(live: LiveProcess | null): (Node | string)[] | null {
    if (payload === null) return ["Loading stats…"]
    if (payload.reason === "storage-missing") {
        return [
            "context-mode stats folder not found: ",
            el("code", undefined, payload.storageDir),
            ". If it stores data elsewhere, set CONTEXT_MODE_STATS_DIR for the service.",
        ]
    }
    if (!live) return ["No context-mode stats recorded yet."]
    return null
}

function setHint(node: HTMLElement, content: (Node | string)[] | null): void {
    if (!content || content.length === 0) {
        node.hidden = true
        node.replaceChildren()
        return
    }
    node.hidden = false
    node.replaceChildren(...content)
}

function syncStatusHeight(): void {
    if (surface !== "status") return
    const node = root.firstElementChild
    if (!(node instanceof HTMLElement)) return
    const height = Math.ceil(node.scrollHeight)
    if (height <= 0 || height === lastStatusHeight) return
    lastStatusHeight = height
    void host.setHeight(height).catch(() => {})
}

// -------------------------------------------------------------------- rows

function liveRows(live: LiveProcess): MetricRow[] {
    return [
        { label: "Tokens saved", value: `~${formatTokens(live.tokensSaved)}`, tone: "success" },
        { label: "Est. $ saved", value: formatDollars(live.dollarsSaved) },
        { label: "Kept out", value: `${formatBytes(live.keptOut)} (${live.reductionPct}%)` },
        { label: "Processed", value: formatBytes(live.totalProcessed) },
        { label: "Returned to context", value: formatBytes(live.bytesReturned) },
        { label: "Indexed", value: formatBytes(live.bytesIndexed) },
        { label: "Sandboxed", value: formatBytes(live.bytesSandboxed) },
        { label: "Tool calls", value: String(live.totalCalls) },
        { label: "Cache", value: `${plural(live.cacheHits, "hit")} · ${formatBytes(live.cacheBytesSaved)} saved` },
        { label: "Uptime", value: formatDuration(live.uptimeMs) },
    ]
}

function allTimeRows(allTime: AllTime): MetricRow[] {
    return [
        { label: "Tokens saved", value: `~${formatTokens(allTime.tokensSaved)}`, tone: "success" },
        { label: "Est. $ saved", value: formatDollars(allTime.dollarsSaved) },
        { label: "Kept out", value: formatBytes(allTime.keptOut) },
        { label: "Processed", value: formatBytes(allTime.totalProcessed) },
        { label: "Tool calls", value: String(allTime.totalCalls) },
        { label: "Processes", value: String(allTime.processes) },
        { label: "Cache", value: `${plural(allTime.cacheHits, "hit")} · ${formatBytes(allTime.cacheBytesSaved)} saved` },
    ]
}

function liveSegments(live: LiveProcess): BytesSegments {
    return [
        { label: "Returned to context", value: live.bytesReturned, className: "cm-seg-returned" },
        { label: "Kept out", value: live.keptOut, className: "cm-seg-kept" },
    ]
}

function allTimeSegments(allTime: AllTime): BytesSegments {
    return [
        { label: "Returned to context", value: allTime.bytesReturned, className: "cm-seg-returned" },
        { label: "Kept out", value: allTime.keptOut, className: "cm-seg-kept" },
    ]
}

// -------------------------------------------------------------------- format

function formatTokens(tokens: number): string {
    const value = Math.max(0, Math.round(tokens))
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}`.replace(/\.0$/, "") + "M"
    if (value >= 1000) return `${(value / 1000).toFixed(1)}`.replace(/\.0$/, "") + "K"
    return String(value)
}

function formatBytes(bytes: number): string {
    const value = Math.max(0, bytes)
    if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
    return `${Math.round(value)} B`
}

function formatDollars(dollars: number): string {
    if (!Number.isFinite(dollars) || dollars <= 0) return "$0.00"
    if (dollars < 0.01) return "<$0.01"
    return `$${dollars.toFixed(2)}`
}

function formatDuration(ms: number): string {
    const safe = Math.max(0, Math.round(ms))
    if (safe < 1000) return `${safe} ms`
    const totalSeconds = safe / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
    const wholeSeconds = Math.floor(totalSeconds)
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m ${wholeSeconds % 60}s`
}

function plural(count: number, noun: string): string {
    return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

// -------------------------------------------------------------------- wiring

host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    surface = ctx.surface === "status" ? "status" : "panel"
    if (!mounted) {
        mounted = true
        if (surface === "status") mountStatus()
        else mountPanel()
        startPolling()
    }
    void refreshStats()
})

host.onSessionLifecycle(() => {
    void refreshStats()
})
