/** Shared view pieces: statements, sections, pagers, tones, glossary. */

import { h, icon } from "./dom.ts"
import { hideTip, showTip } from "./charts.ts"

// ----------------------------------------------------------------- glossary

/** What every number means. Shown in hovers and in Settings → About the numbers. */
export const GLOSSARY: Record<string, string> = {
    sessions: "OpenCode chat sessions (ids starting with ses_) that context-mode recorded at least one event for. Subagent sessions are separate sessions with a parent.",
    prompts: "Messages you sent (user_prompt events).",
    steps: "Model steps: one per model call, from context-mode's agent_usage events. De-duplicated, because context-mode writes each step into every project database the session touched.",
    tokensRead: "Prompt tokens the model read across all steps: input + cache read + cache write, summed per step. This is the real context traffic.",
    tokensOut: "Tokens the model generated.",
    cacheHit: "Share of prompt tokens served from the provider's prompt cache (cache read ÷ prompt tokens).",
    peak: "The largest single prompt (input + cache) of any step: how full the context window got.",
    errors: "Tool errors context-mode captured (error_tool). Resolved counts error_resolved events.",
    retries: "Loops context-mode detected: the same tool called repeatedly with similar input.",
    decisions: "Decisions, blockers and constraints context-mode extracted from the conversation.",
    compactions: "Times the session's context was compacted and context-mode built a resume snapshot.",
    events: "Everything context-mode captured except model steps: prompts, file operations, errors, git, skills, references, shell commands, rules.",
    runs: "One run per context-mode MCP server process. Its counters start at zero whenever the app that launched it restarts.",
    calls: "Calls to context-mode's own tools (ctx_execute, ctx_search, ctx_batch_execute, …).",
    returned: "Bytes those tools put into the model's context. Measured.",
    indexed: "Bytes written into the FTS knowledge base instead of the context. Measured.",
    sandboxed: "Bytes that sandboxed code read from disk or the network. Measured, but it counts every byte a script touches (a 100 MB database read to count rows counts 100 MB).",
    estSaved: "context-mode's own estimate: (indexed + sandbox reads + cache) ÷ 4. It assumes all of that would otherwise have entered the context, so treat it as an upper bound, not a saving.",
    knowledge: "context-mode's FTS5 knowledge base, one database per project: what was indexed and how many searchable chunks it produced.",
}

export function info(key: string): HTMLButtonElement {
    const b = h("button.info", { type: "button", "aria-label": GLOSSARY[key] ?? key })
    b.appendChild(icon("info", 14))
    const text = GLOSSARY[key] ?? key
    b.addEventListener("pointerenter", (e) => showTip(e.clientX, e.clientY, text))
    b.addEventListener("pointermove", (e) => showTip(e.clientX, e.clientY, text))
    b.addEventListener("pointerleave", hideTip)
    b.addEventListener("focus", () => {
        const r = b.getBoundingClientRect()
        showTip(r.left, r.bottom, text)
    })
    b.addEventListener("blur", hideTip)
    return b
}

// ---------------------------------------------------------------- statement

export interface StItem {
    value: string
    label: string
    tone?: "est" | "good" | "bad"
    glossary?: string
    title?: string
}

/** Grouped rows of measured values, read left to right like a sentence. */
export function statement(rows: [string, (StItem | null | false)[]][]): HTMLElement {
    const el = h("div.statement")
    for (const [head, items] of rows) {
        const list = items.filter((x): x is StItem => !!x)
        if (!list.length) continue
        el.appendChild(h("div.st-row", null,
            h("div.st-head", null, head),
            h("div.st-items", null, ...list.map((it) =>
                h("span.st-item", { class: it.tone ?? "", title: it.title ?? null },
                    h("b", null, it.value),
                    h("span", null, it.label),
                    it.tone === "est" ? h("span.est-tag", null, "est.") : null,
                    it.glossary ? info(it.glossary) : null)))))
    }
    return el
}

// ------------------------------------------------------------------ section

export function section(title: string, hint?: string | Node | null, ...body: (Node | null | false)[]): HTMLElement {
    return h("section.section", null,
        h("div.section-head", null, h("h2", null, title), hint ? h("span.hint", null, hint) : null),
        ...body)
}

export function card(...body: (Node | null | false)[]): HTMLElement {
    return h("div.chart-card", null, ...body)
}

// -------------------------------------------------------------------- pager

export function pager(offset: number, limit: number, total: number, go: (offset: number) => void): HTMLElement {
    const end = Math.min(total, offset + limit)
    const prev = h("button.btn", { type: "button", disabled: offset <= 0 }, icon("back", 14), "Previous")
    const next = h("button.btn", { type: "button", disabled: end >= total }, "Next", icon("chevron", 14))
    prev.addEventListener("click", () => go(Math.max(0, offset - limit)))
    next.addEventListener("click", () => go(offset + limit))
    return h("div.pager", null,
        h("span", null, total ? `${(offset + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}` : "No rows"),
        h("div.btns", null, prev, next))
}

// --------------------------------------------------------------------- tones

const TYPE_TONE: [RegExp, string][] = [
    [/^agent_usage$/, "--t-steps"],
    [/^(user_prompt|intent|role|data)$/, "--t-prompts"],
    [/^file_/, "--t-files"],
    [/^(error|retry)/, "--t-errors"],
    [/^(decision|blocker|constraint)/, "--t-decisions"],
    [/^git/, "--t-git"],
    [/^(skill|rule)/, "--t-skills"],
    [/^external_ref$/, "--t-refs"],
    [/^(env|cwd|bash)/, "--t-shell"],
    [/(compaction|snapshot)/, "--t-compaction"],
]

export function typeTone(type: string): string {
    for (const [re, tone] of TYPE_TONE) if (re.test(type)) return tone
    return "--t-other"
}

export const GROUP_TONE: Record<string, string> = {
    "model steps": "--t-steps",
    "prompts & intent": "--t-prompts",
    files: "--t-files",
    "errors & retries": "--t-errors",
    "decisions & constraints": "--t-decisions",
    git: "--t-git",
    "skills & rules": "--t-skills",
    references: "--t-refs",
    "shell & env": "--t-shell",
    compaction: "--t-compaction",
    other: "--t-other",
}

/** Readable names for raw event types. */
export const TYPE_LABEL: Record<string, string> = {
    agent_usage: "Model step",
    user_prompt: "Prompt",
    intent: "Intent",
    role: "Role",
    data: "Task data",
    file_read: "File read",
    file_write: "File written",
    file_edit: "File edited",
    file_search: "Search",
    file_glob: "Glob",
    error_tool: "Tool error",
    error_resolved: "Error resolved",
    retry_detected: "Retry loop",
    decision: "Decision",
    blocker: "Blocker",
    blocker_resolved: "Blocker resolved",
    constraint_discovered: "Constraint",
    git: "Git",
    git_commit: "Commit",
    skill: "Skill",
    rule: "Rule file",
    rule_content: "Rule content",
    external_ref: "Reference",
    env: "Shell command",
    cwd: "Directory",
    bash_outcome: "Shell outcome",
    compaction_summary: "Compaction",
    "snapshot-built": "Snapshot",
}

export const typeLabel = (t: string): string => TYPE_LABEL[t] ?? t.replace(/_/g, " ")

/** Event-type chips for the timeline filter. */
export const TIMELINE_FILTERS: { id: string; label: string; types: string[] }[] = [
    { id: "prompts", label: "Prompts", types: ["user_prompt", "intent", "role", "data"] },
    { id: "files", label: "Files", types: ["file_read", "file_write", "file_edit", "file_search", "file_glob"] },
    { id: "errors", label: "Errors", types: ["error_tool", "error_resolved", "retry_detected"] },
    { id: "decisions", label: "Decisions", types: ["decision", "blocker", "blocker_resolved", "constraint_discovered"] },
    { id: "git", label: "Git", types: ["git", "git_commit"] },
    { id: "shell", label: "Shell", types: ["env", "cwd", "bash_outcome"] },
    { id: "skills", label: "Skills & rules", types: ["skill", "rule", "rule_content"] },
    { id: "refs", label: "References", types: ["external_ref"] },
    { id: "steps", label: "Model steps", types: ["agent_usage"] },
]

export function emptyState(title: string, body: string, action?: { label: string; onClick: () => void }): HTMLElement {
    const btn = action ? h("button.btn.primary", { type: "button" }, action.label) : null
    if (btn && action) btn.addEventListener("click", action.onClick)
    return h("div.explain", null, h("h3", null, title), h("p", null, body), btn)
}
