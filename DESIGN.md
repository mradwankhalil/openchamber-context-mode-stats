# Design

This document explains how the extension works and why it looks the way it does: what
context-mode actually stores, what those numbers can and cannot support, how the service
turns them into answers, and the visual system of the panel.

## 1. What context-mode v1 stores for OpenCode

The readers target the formats present in upstream context-mode 1.0.169. This is the
context-mode **v1 engine**, independently of whether OpenCode itself is V1 or V2. The
context-mode v2 engine rewrite uses different locations/tables/accounting and is not supported.
The extension reads existing stores; it does not install the integration that produces them.

context-mode has two halves in OpenCode, and they can write to different places.

| Store | Written by | Location (default) | What is in it |
|---|---|---|---|
| Session event DBs | the OpenCode **plugin** (hooks) | `%APPDATA%\opencode\context-mode\sessions\<hash>[__<wt>].db` on Windows, `$XDG_CONFIG_HOME/opencode/…` or `~/.config/opencode/…` elsewhere | `session_meta` (one row per OpenCode session), `session_events` (prompts, file ops, errors, git, skills, references, shell commands, decisions, model-step usage), `session_resume` (compaction snapshots) |
| Run stats files | the **MCP server** | `~/.config/opencode/context-mode/sessions/stats-pid-<ppid>.json` | per-process counters: tool calls, bytes returned / indexed / read in the sandbox, cache hits, `tokens_saved` |
| Knowledge-base DBs | the MCP server | `~/.config/opencode/context-mode/content/<hash>.db` | FTS5 index; the `sources` table lists what was indexed and how many chunks it produced |
| OpenCode DB (optional) | OpenCode | `~/.local/share/opencode/opencode.db` | session titles, parent (subagent) links, agent, model, OpenCode's own token totals |

`<hash>` is a hash of the project directory; `__<wt>` marks a git worktree. Upstream v1's
override is `CONTEXT_MODE_DIR`, with `sessions` and `content` beneath it. The extension does
not read that override from an agent's shell. Its shared root setting expects the standard
`context-mode/{sessions,content}` layout; for an arbitrarily named root, set the individual
session/stat/content folders. OpenCode enrichment selects one database, not every profile.

### Facts discovered while building this (they shape the code)

1. **Historical local capture duplicated usage across DBs.** An older locally patched OpenCode
   V2 `StepEnded` writer handled broadcast events without project ownership checks. On the author's machine a single session's
   136 steps appeared in 15 DBs; about 300k step rows held 71k real steps. The service merges a
   session across DBs and de-duplicates steps on (time, input, output, cache read, cache write).
   This is not proof of universal upstream fan-out. Matching samples are not stable step IDs:
   legitimate identical samples can merge, and the reader does not repair writer ownership.
2. **`tokens_saved` is a byte-based estimate, not measured savings.** In context-mode v1's source,
   `tokens_saved = (bytes_indexed + bytes_sandboxed + cache_bytes_saved) / 4`, and
   `bytes_sandboxed` counts every byte sandboxed code reads from disk or the network. A script
   that reads a 100 MB SQLite file to count rows adds 25M "saved" tokens. One process on the
   author's machine reported 3.3 billion tokens saved from 76 calls. The panel shows this figure
   only as a hatched, labelled estimate and explains it on the Runs view.
3. **Two MCP servers can share one stats file.** Stock v1 normally names it after the parent
   process id (a session-ID override can produce other names, which this reader does not discover).
   When OpenCode starts two context-mode servers under one parent, both write
   `stats-pid-<ppid>.json` and overwrite each other, so the "live" numbers flip between them.
   The service remembers only runs it actually observes during its own lifetime. Unseen
   overwrites are unrecoverable and this memory is lost on restart. Parent-PID existence plus
   freshness is an approximate live indicator, not proof of the child server's identity.
4. **Recorded prompt size is a capture-dependent context signal.** `tokens_in + cache_read +
   cache_create` gives the recorded sample's input-plus-cache size. Its maximum and series are
   the displayed peak and curve, not proof of the actual peak when samples are absent.
   Stock OpenCode V1 capture records message updates, not necessarily one row per model call.
   A per-step producer improves granularity; a drop after a large prompt can indicate a
   compaction, a reset, or a smaller side call.

## 2. What the data supports

Recorded data, shown as plain figures when available, rather than independently measured
activity from every host/provider:

- sessions, projects, subagents (with OpenCode's DB), prompts, events by type, errors and
  resolutions, retry loops, decisions, blockers, constraints, compactions, resume snapshots;
- usage samples and their recorded tokens: read (input + cache), generated, cache share, peak
  and latest sample size; cost as stored by the producer. Upstream may price tokens when native
  cost is absent, and message-update cost may be cumulative. The reader does not preserve cost
  provenance or difference cumulative updates; these totals are not audited billing;
- files read and edited, shell commands, skills, references, intents, models, agents;
- context-mode's own tool calls and the bytes they returned into context, indexed, or read in
  the sandbox; knowledge-base sources, chunks, sizes.

The estimate explicitly marked by the interface:

- context-mode's `tokens_saved`. No dollar value is derived from it.

Missing capture and unsupported tables can return empty lists or zero counters; some DB read
errors are internally retained or skipped rather than exposed in every view. Such displays do
not prove zero activity/cost. Missing SQLite is reported in Settings → Locations, but there is
not yet a comprehensive schema/capability warning for every unavailable field. Model labels,
titles and subagent links need matching optional OpenCode DB columns, not merely usage rows.

Basic readers need no author-specific fork. New native OpenCode V2 capture needs a compatible
V2 adapter; stock context-mode 1.0.169's V1 plugin does not supply that API. The local adapter
adds native step-ended capture, with bounded early-event retention; it is not shipped by this
extension and does not make the context-mode v2 engine's stores compatible.

Not available from these stores, so not shown: a per-call log of context-mode tools (the
`tool_calls` table exists but stays empty), and which chat a context-mode tool call came from
(run files are per process, not per session).

## 3. Architecture

```
panel (sandboxed iframe) ── host.serviceRequest ──▶ OpenChamber ──▶ local service (Node, 127.0.0.1)
     views, charts, settings                                         discovery → stores → engine
     settings in host.storage                                        read-only SQLite (node:sqlite)
```

- **The service inherits no environment** (OpenChamber passes only PATH, HOME, temp and OS
  variables). Every request therefore carries the panel's settings: location overrides, data
  filters, privacy. Discovery works from the home folder and OS conventions.
- **Index once, then incrementally.** `EventIndex` reads every session DB into compact per-session,
  per-day aggregates (steps packed in a `Float64Array`) and re-reads a DB only when its file or WAL
  changes. The first scan yields to the event loop every few DBs and reports progress; requests
  answer from the partial index meanwhile. Only sessions touched by a changed DB are re-merged.
- **Targeted SQL for depth.** Session detail and ranked insights query just the DBs involved,
  with privacy applied in the service so hidden text never leaves it.
- **Read-only.** Every database is opened read-only and closed after use.
- **Host runtime.** SQLite is loaded from OpenChamber's service runtime, not a separately
  installed Node on PATH. The constructor uses `readOnly` and `timeout`: Node 22.16+ on the
  22.x line or Node 24+ with `node:sqlite` enabled covers those options. Node 22.5 alone is not
  sufficient evidence of unflagged availability or the documented timeout behavior.

Files: `service/discover.ts` (locations), `service/events.ts` (session index and merge),
`service/runs.ts` (run files), `service/knowledge.ts` (FTS sources), `service/opencode.ts`
(OpenCode enrichment), `service/engine.ts` (queries), `service/main.ts` (HTTP routes),
`service/types.ts` (wire types shared with the panel).

## 4. Interface

**Structure: a filter-bar explorer.** One sticky filter bar (date range, project, search) scopes
every view, and every number answers to it. Views: **Sessions** (statement, daily activity,
sortable ledger → session detail), **Insights** (weekday × hour heatmap, event mix, projects,
heaviest sessions, models, files, commands, errors, skills, references, retries, intents),
**Runs** (live servers, measured byte flow, the estimate explained, run ledger), **Knowledge**
(databases, kinds, indexing per day, sources), **Settings**. The same page serves the rail panel,
the full-screen page and the chat's Work Status card.

**Statements instead of KPI cards.** Totals read left to right in grouped rows (Activity,
Context, Signals, context-mode), large tabular figures with their unit beside them, each with an
info hover that defines it. It scales from a 360 px rail to a full page without a card grid.

**Visual system.**

- Colour comes from OpenChamber's theme tokens (`--oc-*`), so the panel follows every theme.
  The host's primary colour marks selection, live state and measured bars.
- Estimates have their own hue (magenta-violet, independent of any host accent), a dotted
  underline, an `est.` tag, and hatching in charts. Colour is never the only signal.
- Event categories use fixed hues tuned per light/dark theme (`--t-*`).
- Type: the host's UI font; base 15 px (configurable 14–18 px); figures in tabular numerals;
  headings 1.14–1.45 rem. Monospace only for paths, ids, commands and tool names.
- Ledgers: hairline rules, sticky headers under the filter bar, sort on every column, a
  one-line summary replacing number columns in narrow panels.
- Charts are hand-drawn SVG with exact hover readouts and keyboard focus: daily columns
  (click a day to filter to it), the context curve with compaction and drop markers, the
  weekday × hour heatmap, split bars, ranked bars.
- Motion only conveys state (progress, refresh spinner) and respects reduced motion.

**Privacy.** "Show event text" off removes prompts, errors, decisions and commands at the
service; "Shorten file paths" keeps only the last segment. The eye button in the header toggles
event text for screen sharing.

## 5. Settings

| Group | Setting | Default |
|---|---|---|
| Locations | context-mode data folder (sets all three stores) | auto |
| | session event DB folders, run stats folders, knowledge-base folders (one per line) | auto |
| | OpenCode database | auto |
| Privacy | show event text · shorten file paths | on · off |
| Data | hide test sessions · include subagents · exclude projects (regex) · show context-mode's estimate | on · on · – · on |
| Display | text size · refresh interval · opening view · default range · items in ranked lists · rows per page · timeline page · ledger columns | 15 px · 5 s · Sessions · 7 days · 10 · 40 · 120 · six columns |

Settings live in OpenChamber's extension storage, so they survive updates and follow the
OpenChamber instance.
