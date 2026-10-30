/** Number, byte, token, time and duration formatting. One place, one voice. */

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

/** 1234 → "1,234"; 12_345_678 → "12.3M". */
export function count(n: number): string {
    if (!Number.isFinite(n)) return "–"
    const a = Math.abs(n)
    if (a < 10_000) return nf0.format(n)
    if (a < 1e6) return `${nf1.format(n / 1e3)}K`
    if (a < 1e9) return `${nf1.format(n / 1e6)}M`
    return `${nf1.format(n / 1e9)}B`
}

export const full = (n: number): string => (Number.isFinite(n) ? nf0.format(n) : "–")

export function bytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B"
    const units = ["B", "KB", "MB", "GB", "TB"]
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${i === 0 ? nf0.format(v) : nf1.format(v)} ${units[i]}`
}

export function pct(part: number, whole: number): string {
    if (!whole) return "–"
    const p = (part / whole) * 100
    return p > 0 && p < 1 ? "<1%" : `${nf0.format(p)}%`
}

export function usd(n: number): string {
    if (!n) return "$0"
    if (n < 0.01) return "<$0.01"
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 }).format(n)
}

export function duration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "–"
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h}h ${m % 60}m`
    return `${Math.floor(h / 24)}d ${h % 24}h`
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

export function ago(ms: number, now = Date.now()): string {
    if (!ms) return "–"
    const d = (ms - now) / 1000
    const a = Math.abs(d)
    if (a < 45) return "just now"
    if (a < 3600) return rtf.format(Math.round(d / 60), "minute")
    if (a < 86_400) return rtf.format(Math.round(d / 3600), "hour")
    if (a < 86_400 * 30) return rtf.format(Math.round(d / 86_400), "day")
    return date(ms)
}

export function date(ms: number): string {
    if (!ms) return "–"
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
}

export function dateTime(ms: number): string {
    if (!ms) return "–"
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function time(ms: number): string {
    if (!ms) return "–"
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** "2026-10-29" → "Oct 29". */
export function dayLabel(day: string, withWeekday = false): string {
    const [y, m, d] = day.split("-").map(Number)
    const dt = new Date(y, m - 1, d)
    return dt.toLocaleDateString(undefined, withWeekday ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" })
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${full(n)} ${n === 1 ? one : many}`
}

export function shortId(id: string): string {
    return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export function localDay(ms = Date.now()): string {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function addDays(day: string, delta: number): string {
    const [y, m, d] = day.split("-").map(Number)
    return localDay(new Date(y, m - 1, d + delta).getTime())
}
