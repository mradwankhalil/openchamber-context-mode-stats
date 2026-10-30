/** Tiny DOM builder. `h("div.cls", {attrs}, ...children)`. */

type Child = Node | string | number | null | undefined | false | Child[]
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>

export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}`, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
    const [tag, ...classes] = spec.split(".") as [K, ...string[]]
    const el = document.createElement(tag)
    if (classes.length) el.className = classes.join(" ")
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined || v === false) continue
            if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v)
            else if (k === "class") el.className = `${el.className} ${v}`.trim()
            else if (k === "text") el.textContent = String(v)
            else if (k === "style") el.setAttribute("style", String(v))
            else el.setAttribute(k, v === true ? "" : String(v))
        }
    }
    append(el, children)
    return el
}

export function append(el: Node, children: Child[]): void {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue
        if (Array.isArray(c)) append(el, c)
        else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c)
    }
}

export function clear(el: Element): void {
    while (el.firstChild) el.removeChild(el.firstChild)
}

export function replace(el: Element, ...children: Child[]): void {
    clear(el)
    append(el, children)
}

const SVG = "http://www.w3.org/2000/svg"

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...children: (SVGElement | string | null | undefined | false)[]): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v))
    for (const c of children) {
        if (!c) continue
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    }
    return el
}

/** Drawn icons, one stroke weight (1.6 on a 20 grid). */
const ICONS: Record<string, string> = {
    refresh: "M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.6h-3.6",
    settings: "M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM16 10a6 6 0 0 0-.1-1l1.7-1.3-1.6-2.8-2 .8a6 6 0 0 0-1.7-1L12 2.6H8.8l-.3 2.1a6 6 0 0 0-1.7 1l-2-.8-1.6 2.8L4.9 9a6 6 0 0 0 0 2l-1.7 1.3 1.6 2.8 2-.8a6 6 0 0 0 1.7 1l.3 2.1H12l.3-2.1a6 6 0 0 0 1.7-1l2 .8 1.6-2.8L15.9 11c.1-.3.1-.7.1-1Z",
    back: "M12.5 4.5 7 10l5.5 5.5",
    close: "M5 5l10 10M15 5 5 15",
    eye: "M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5Zm7.5 2.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z",
    eyeOff: "M3 3l14 14M8.3 5.2A7.6 7.6 0 0 1 10 5c4.8 0 7.5 5 7.5 5a12.6 12.6 0 0 1-2.2 2.8M12 15.3a7.3 7.3 0 0 1-2 .3c-4.8 0-7.5-5-7.5-5A12.4 12.4 0 0 1 5.4 7.2M8.5 8.5a2.2 2.2 0 0 0 3 3",
    copy: "M7 7h9v9H7zM4 13V4h9",
    info: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 9v5M10 6.2v.1",
    search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM13.5 13.5 17 17",
    folder: "M2.5 5.5v9.5h15V7.3H9.6L8 5.5H2.5Z",
    check: "M4.5 10.5 8 14l7.5-8",
    warn: "M10 3 18 17H2L10 3ZM10 8v4M10 14.6v.1",
    external: "M11 3.5h5.5V9M16.5 3.5 9 11M14 12v4.5H3.5V6H8",
    chevron: "M7 4.5 12.5 10 7 15.5",
    pulse: "M2.5 10h3.2l2-4.5 3.6 9 2-4.5h4.2",
    up: "M6 12.5 10 8l4 4.5",
    down: "M6 8l4 4.5L14 8",
}

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
    return s("svg", { viewBox: "0 0 20 20", width: size, height: size, class: "ic", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" },
        s("path", { d: ICONS[name] ?? ICONS.info }))
}

/** A button that is only an icon, with an accessible name and tooltip. */
export function iconButton(name: string, label: string, onClick: () => void, extraClass = ""): HTMLButtonElement {
    const b = h("button.icon-btn", { type: "button", "aria-label": label, title: label, class: extraClass })
    b.appendChild(icon(name))
    b.addEventListener("click", onClick)
    return b
}
