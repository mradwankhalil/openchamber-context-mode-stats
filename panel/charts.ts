/**
 * Hand-drawn charts (SVG + divs, no dependencies). Every chart has a hover
 * readout with exact values, so nothing is encoded by colour or length alone.
 */

import { h, s } from "./dom.ts"
import { count, dateTime, dayLabel } from "./format.ts"

// ------------------------------------------------------------------ tooltip

let tip: HTMLDivElement | null = null

function tooltip(): HTMLDivElement {
    if (!tip) {
        tip = h("div.tip", { role: "tooltip" })
        document.body.appendChild(tip)
    }
    return tip
}

export function showTip(x: number, y: number, content: Node | string): void {
    const t = tooltip()
    t.replaceChildren(typeof content === "string" ? document.createTextNode(content) : content)
    t.style.display = "block"
    const pad = 12
    const w = t.offsetWidth, hh = t.offsetHeight
    const left = Math.min(window.innerWidth - w - 6, Math.max(6, x + pad))
    const top = y + pad + hh > window.innerHeight ? y - hh - pad : y + pad
    t.style.left = `${left}px`
    t.style.top = `${Math.max(6, top)}px`
}

export function hideTip(): void {
    if (tip) tip.style.display = "none"
}

export function tipRows(title: string, rows: [string, string][]): HTMLElement {
    return h("div", null,
        h("div.tip-title", null, title),
        ...rows.map(([k, v]) => h("div.tip-row", null, h("span", null, k), h("b", null, v))))
}

/** Attach hover + keyboard-focus readouts to an element. */
export function hoverable(el: Element, content: () => Node | string): void {
    el.addEventListener("pointermove", (e) => showTip((e as PointerEvent).clientX, (e as PointerEvent).clientY, content()))
    el.addEventListener("pointerleave", hideTip)
    el.addEventListener("focus", () => {
        const r = (el as Element).getBoundingClientRect()
        showTip(r.left + r.width / 2, r.top + r.height / 2, content())
    })
    el.addEventListener("blur", hideTip)
}

// ------------------------------------------------------------ daily columns

export interface ColumnDatum {
    day: string
    value: number
    /** Second segment stacked above `value` (e.g. estimate). */
    extra?: number
    detail: [string, string][]
}

/** Daily columns with a baseline, a max label and sparse day labels. Fills its container width. */
export function dailyColumns(data: ColumnDatum[], opts: { height?: number; unit?: (n: number) => string; onPick?: (day: string) => void; extraHatched?: boolean } = {}): HTMLElement {
    const unit = opts.unit ?? count
    const height = opts.height ?? 132
    const wrap = h("div.cols")
    const max = Math.max(1, ...data.map((d) => d.value + (d.extra ?? 0)))
    const n = data.length
    const W = Math.max(n * 10, 100)
    const H = 100
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "cols-svg", style: `height:${height}px`, role: "img", "aria-label": "Daily chart" })
    svg.appendChild(s("defs", {}, s("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
        s("rect", { width: 4, height: 4, class: "hatch-bg" }), s("line", { x1: 0, y1: 0, x2: 0, y2: 4, class: "hatch-line" }))))
    for (const f of [0.5, 1]) svg.appendChild(s("line", { x1: 0, x2: W, y1: H - f * (H - 4), y2: H - f * (H - 4), class: "grid" }))
    const bw = W / n
    data.forEach((d, i) => {
        const x = i * bw + bw * 0.15
        const w = Math.max(0.6, bw * 0.7)
        const vh = (d.value / max) * (H - 4)
        const eh = ((d.extra ?? 0) / max) * (H - 4)
        const g = s("g", { class: "col", tabindex: 0 })
        g.appendChild(s("rect", { x: i * bw, y: 0, width: bw, height: H, class: "col-hit" }))
        if (vh > 0) g.appendChild(s("rect", { x, y: H - vh, width: w, height: Math.max(vh, 0.8), class: "col-bar" }))
        if (eh > 0) g.appendChild(s("rect", { x, y: H - vh - eh, width: w, height: eh, class: opts.extraHatched ? "col-extra hatched" : "col-extra" }))
        hoverable(g, () => tipRows(dayLabel(d.day, true), d.detail))
        if (opts.onPick) g.addEventListener("click", () => opts.onPick?.(d.day))
        svg.appendChild(g)
    })
    const axis = h("div.cols-axis")
    // First, middle and last day; every day only when there are few enough to never collide.
    const marks = n <= 1 ? [0] : n <= 3 ? data.map((_, i) => i) : n <= 12 ? [0, Math.round((n - 1) / 2), n - 1] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1]
    for (const i of marks) {
        const d = data[i]
        if (!d) continue
        const lab = h("span", { style: `left:${((i + 0.5) / n) * 100}%` }, dayLabel(d.day))
        axis.appendChild(lab)
    }
    wrap.append(h("div.cols-max", null, unit(max)), svg, axis)
    return wrap
}

// ------------------------------------------------------------- context area

export interface AreaPoint {
    at: number
    value: number
    detail: [string, string][]
}

/** Context size over a session: area + line, compaction pins, drop ticks, hover crosshair. */
export function contextArea(points: AreaPoint[], marks: { at: number; kind: "compaction" | "drop" }[], opts: { height?: number } = {}): HTMLElement {
    const wrap = h("div.area")
    if (points.length < 2) {
        wrap.appendChild(h("p.muted", null, points.length ? "One model step recorded." : "No model steps recorded for this session."))
        return wrap
    }
    const H = 100, W = 400
    const t0 = points[0].at, t1 = points[points.length - 1].at
    const span = Math.max(1, t1 - t0)
    const max = Math.max(1, ...points.map((p) => p.value))
    // Even spacing by step index reads better than wall time (sessions idle for hours).
    const xOf = (i: number) => (i / (points.length - 1)) * W
    const yOf = (v: number) => H - (v / max) * (H - 6)
    const line = points.map((p, i) => `${i ? "L" : "M"}${xOf(i).toFixed(2)},${yOf(p.value).toFixed(2)}`).join(" ")
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "area-svg", style: `height:${opts.height ?? 170}px`, role: "img", "aria-label": "Context size per model step" })
    for (const f of [0.25, 0.5, 0.75, 1]) svg.appendChild(s("line", { x1: 0, x2: W, y1: yOf(max * f), y2: yOf(max * f), class: "grid" }))
    svg.appendChild(s("path", { d: `${line} L${W},${H} L0,${H} Z`, class: "area-fill" }))
    svg.appendChild(s("path", { d: line, class: "area-line", "vector-effect": "non-scaling-stroke" }))
    const idxAt = (at: number) => {
        let lo = 0, hi = points.length - 1
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (points[mid].at < at) lo = mid + 1
            else hi = mid
        }
        return lo
    }
    for (const m of marks) {
        if (m.at < t0 || m.at > t1 + 60_000) continue
        const x = xOf(idxAt(m.at))
        svg.appendChild(s("line", { x1: x, x2: x, y1: 0, y2: H, class: m.kind === "compaction" ? "mark-compaction" : "mark-drop", "vector-effect": "non-scaling-stroke" }))
    }
    const cursor = s("line", { x1: 0, x2: 0, y1: 0, y2: H, class: "cursor", "vector-effect": "non-scaling-stroke", visibility: "hidden" })
    svg.appendChild(cursor)
    svg.addEventListener("pointermove", (e) => {
        const r = svg.getBoundingClientRect()
        const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))
        const p = points[Math.max(0, Math.min(points.length - 1, i))]
        cursor.setAttribute("x1", String(xOf(i)))
        cursor.setAttribute("x2", String(xOf(i)))
        cursor.setAttribute("visibility", "visible")
        showTip(e.clientX, e.clientY, tipRows(dateTime(p.at), p.detail))
    })
    svg.addEventListener("pointerleave", () => {
        cursor.setAttribute("visibility", "hidden")
        hideTip()
    })
    wrap.append(
        h("div.area-y", null, h("span", null, count(max)), h("span", null, count(max / 2)), h("span", null, "0")),
        h("div.area-plot", null, svg, h("div.area-x", null, h("span", null, dateTime(t0)), h("span", null, `${points.length} points · ${spanText(span)}`), h("span", null, dateTime(t1)))),
    )
    return wrap
}

function spanText(ms: number): string {
    const m = Math.round(ms / 60000)
    return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`
}

// ------------------------------------------------------------------ heatmap

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Weekday × hour activity. Monday first. */
export function weekHeatmap(matrix: number[][], label = "events"): HTMLElement {
    const max = Math.max(1, ...matrix.flat())
    const grid = h("div.heat", { role: "img", "aria-label": `${label} by weekday and hour` })
    grid.appendChild(h("span.heat-corner"))
    for (let hr = 0; hr < 24; hr++) grid.appendChild(h("span.heat-hour", null, hr % 6 === 0 ? String(hr).padStart(2, "0") : ""))
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
        grid.appendChild(h("span.heat-day", null, DOW[d]))
        for (let hr = 0; hr < 24; hr++) {
            const v = matrix[d]?.[hr] ?? 0
            const cell = h("span.heat-cell", { style: `--v:${v ? (0.12 + 0.88 * Math.sqrt(v / max)).toFixed(3) : 0}`, tabindex: -1 })
            hoverable(cell, () => tipRows(`${DOW[d]} ${String(hr).padStart(2, "0")}:00–${String(hr + 1).padStart(2, "0")}:00`, [[label, count(v)]]))
            grid.appendChild(cell)
        }
    }
    return grid
}

// --------------------------------------------------------------- rank bars

export interface RankDatum {
    label: string
    value: number
    display?: string
    sub?: string
    title?: string
    onClick?: () => void
}

export function rankBars(rows: RankDatum[], opts: { empty?: string; mono?: boolean } = {}): HTMLElement {
    if (!rows.length) return h("p.muted.empty-line", null, opts.empty ?? "Nothing recorded in this range.")
    const max = Math.max(1, ...rows.map((r) => r.value))
    const list = h("ol.rank")
    for (const r of rows) {
        const label = h("span.rank-label", { title: r.title ?? r.label, class: opts.mono ? "mono" : "" }, r.label)
        const li = h("li.rank-row", null,
            h("div.rank-head", null, label, h("span.rank-value", null, r.display ?? count(r.value))),
            h("div.rank-track", null, h("div.rank-fill", { style: `width:${Math.max(1.5, (r.value / max) * 100)}%` })),
            r.sub ? h("div.rank-sub", null, r.sub) : null)
        if (r.onClick) {
            li.classList.add("clickable")
            li.tabIndex = 0
            li.addEventListener("click", r.onClick)
            li.addEventListener("keydown", (e) => { if (e.key === "Enter") r.onClick?.() })
        }
        list.appendChild(li)
    }
    return list
}

// --------------------------------------------------------------- split bar

export interface Part {
    label: string
    value: number
    tone: string
    hatched?: boolean
    note?: string
}

/** One 100% bar with a legend underneath. */
export function splitBar(parts: Part[], format: (n: number) => string = count): HTMLElement {
    const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0)
    const bar = h("div.split", { role: "img", "aria-label": parts.map((p) => `${p.label} ${format(p.value)}`).join(", ") })
    const legend = h("ul.legend")
    for (const p of parts) {
        if (p.value <= 0) continue
        const seg = h("span.split-seg", { style: `flex:${p.value};--tone:var(${p.tone})`, class: p.hatched ? "hatched" : "" })
        hoverable(seg, () => tipRows(p.label, [["value", format(p.value)], ["share", `${((p.value / (total || 1)) * 100).toFixed(1)}%`], ...(p.note ? [["", p.note] as [string, string]] : [])]))
        bar.appendChild(seg)
        legend.appendChild(h("li", null,
            h("span.swatch", { style: `--tone:var(${p.tone})`, class: p.hatched ? "hatched" : "" }),
            h("span.legend-label", null, p.label),
            h("span.legend-value", null, format(p.value)),
            h("span.legend-share", null, total ? `${Math.round((p.value / total) * 100)}%` : "")))
    }
    return h("div.split-wrap", null, bar, legend)
}

// ------------------------------------------------------------------- trail

/** Bars for the last N model steps' prompt size, for the Work Status card. */
export function trail(values: number[], height = 30): HTMLElement {
    const max = Math.max(1, ...values)
    const wrap = h("div.trail", { style: `height:${height}px`, role: "img", "aria-label": "Context size of recent model steps" })
    values.forEach((v, i) => {
        const b = h("span", { style: `height:${Math.max(6, (v / max) * 100)}%`, class: i === values.length - 1 ? "now" : "" })
        hoverable(b, () => tipRows(`Step ${values.length - i === 1 ? "(latest)" : `−${values.length - i - 1}`}`, [["prompt tokens", count(v)]]))
        wrap.appendChild(b)
    })
    return wrap
}
