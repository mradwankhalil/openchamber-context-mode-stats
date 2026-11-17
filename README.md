# Context Mode for OpenChamber

An [OpenChamber](https://github.com/openchamber/openchamber) extension that shows compatible
[context-mode v1](https://github.com/mksglu/context-mode) data recorded for **OpenCode**: per chat session,
per project, across days, and across observed context-mode server runs.

It reads context-mode's own databases and stats files (and, optionally, OpenCode's database for
session titles and models), never writes to them, and labels context-mode's savings estimate.

**No local fork is required to read compatible v1 data.** This extension is a reader, not a
capture plugin or installer. The views below show fields only when an installed integration
recorded them. Missing capture, incompatible schemas and some read failures currently appear
as empty lists or zero counters; those displays do **not** prove zero activity, tokens or cost.

## What you get

**Sessions.** A statement of the filtered set (sessions, projects, prompts, recorded usage/token
samples, cache share, recorded peak context, errors, retry loops, decisions,
compactions, context-mode tool traffic), a daily activity chart with six metrics (click a day to
filter to it), and a sortable ledger of sessions with title, project, model and subagent links.

**Session detail.** The context curve: available recorded prompt-size samples, with compactions and
sudden drops marked. Then the timeline of everything context-mode captured (filterable by type),
prompts, files touched, recurring errors, decisions and constraints, subagents, the context-mode
runs that overlapped the session, its knowledge base and its resume snapshots.

**Insights.** When you work (weekday × hour), what happened (event mix), projects, heaviest
sessions, models, most-touched files, shell commands, recurring errors, skills, references
(issues and PRs), retry loops and intents.

**Runs.** Observed context-mode server runs: tool calls by tool, bytes returned into context, bytes
indexed instead, bytes read inside the sandbox, and context-mode's own "tokens saved" estimate,
hatched and explained.

**Knowledge.** context-mode's FTS knowledge bases: databases per project, what was indexed (command
output, fetched pages, files), sources and chunks per day, every source.

**In the chat.** A Work Status card for the open chat: latest and largest recorded prompt sizes,
the last 40 usage samples, prompts, tokens, errors, compactions, and observed server traffic.

Everything follows one filter bar (date range, project, search), the OpenChamber theme, and
your text size.

## What the numbers mean

| Number | Meaning |
|---|---|
| Model steps | Recorded `agent_usage` samples, de-duplicated across databases. They represent model calls only when the capture integration records one sample per call. |
| Tokens read | Recorded input + cache read + cache write, summed over available samples. Missing capture means incomplete totals. |
| Peak context | The largest recorded input-plus-cache sample. It can miss the actual session peak when samples are absent. |
| From cache | Cache read ÷ tokens read. |
| Recorded cost | Upstream `cost_usd`, when present; it may be native cost, a pricing estimate, or a cumulative message-update snapshot. Not an audited bill. |
| Returned to context | Bytes context-mode reports returning into the conversation. |
| Indexed | Indexed bytes reported by context-mode. |
| Read in the sandbox | File/network bytes read by sandboxed code, as reported by context-mode; not necessarily bytes avoided in the model context. |
| Tokens "saved" (est.) | context-mode's estimate: (indexed + sandbox reads + cache) ÷ 4. Not measured LLM tokens or dollars saved. |

Every figure has an info hover with its definition, and Settings → About the numbers lists them
all. [DESIGN.md](DESIGN.md) documents the stores and the reasoning in full.

Usage samples are **not audited billing**. Stock OpenCode V1 capture records message updates,
not necessarily one event per model call; its costs can be cumulative across updates. An
upstream writer can also estimate cost from model pricing when native cost is absent. The
extension cannot distinguish those estimates or correct every producer's accounting semantics.
Matching-sample deduplication does not use a stable step ID and can merge identical samples.

## Install

1. In OpenChamber open **Settings → Extensions** and add this repository (or a local clone).
2. Approve the dialog. It asks to **run a local service**: that is the process that reads the
   databases. Nothing else is requested.
3. Open the brain icon on the extensions rail, or **Extension pages → Context Mode** for a full
   page. The **Context Mode** section appears in the chat's Work Status panel.

## Requirements and compatibility

- **OpenChamber 2.0.4 or newer**, extension API v1, with permission to run a local service.
  The repository includes built JavaScript: installing the extension does not require Bun,
  a source build, or the author's context-mode fork.
- **Compatible context-mode v1 stores.** The readers target the session/content/stat formats
  present in upstream **1.0.169** (the latest stable v1 observed on 2026-10-30). Compatibility
  depends on the stored tables and fields, not the word “v1” alone. Older formats are not all
  certified.
- **context-mode v2 stores (read-only, partial).** Project DBs at
  `~/.context-mode/projects/<key>/context.db` (checked against v2.2.0) are found automatically
  and read as both session events and knowledge bases. v2 records no token counts and no
  run-stat files, so Runs and per-step usage curves stay empty; model steps are counted.
- **SQLite in OpenChamber's service runtime** for Sessions, Knowledge and optional OpenCode
  metadata. The reader uses `node:sqlite` with read-only and busy-timeout options: use
  **Node 22.16+ on the 22.x line, or Node 24+**, with that module enabled. Node 22.5 introduced
  SQLite behind a flag; unflagged availability began at 22.13 / 23.4. Installing another Node
  version on PATH does not replace a desktop app's bundled service runtime. Settings → Locations
  reports runtime/SQLite availability. Run-stat JSON can still be read without SQLite.
- **A working capture integration for new data.** Installing this extension does not enable
  hooks, migrate databases or reconstruct activity that was never recorded.

There are three separate version numbers: **context-mode engine v1/v2**, **OpenCode host
V1/V2**, and **OpenChamber extension API v1**. They are not interchangeable.

| What you want | Is stock context-mode v1 enough? | Special local fixes required? |
|---|---|---|
| Read existing compatible Sessions, timelines and knowledge bases | Yes, when those files contain the needed data. | No. |
| Runs and Knowledge from a working v1 MCP server | Yes, when its files use the supported formats and are discoverable. | No. |
| New events from OpenCode V1 | Its working stock v1 capture plugin can supply them. | No author-specific fix required. |
| New native events from **OpenCode V2** | Upstream 1.0.169's native plugin does not supply the V2 setup/hooks API. A compatible V2 adapter is needed. | Depends on your capture integration; this extension does not install that adapter. |
| Per-completed-step usage/context curves | Requires a producer that records per-step usage; message-update samples are not an exact substitute. | The author's local V2 adapter adds native step-ended capture, but is not a prerequisite for basic v1 readers. |
| context-mode **engine v2** databases | Not needed: v2 project DBs are read directly (sessions, timelines, insights, knowledge). | No. Runs and token usage are absent because v2 does not record them. |

Models, titles, agents and parent/subagent links additionally depend on optional columns in
OpenCode's database. Missing usage is not reconstructed from host totals. No custom OpenCode
database is required for the basic views; absent metadata simply reduces enrichment.

The fixture suite checks parsing, discovery, filtering, privacy and compatible synthetic
schemas. It does not certify every provider, desktop runtime, platform or context-mode release.

## Startup and the saved index

The extension's service starts when you open the panel or a chat's Work Status card, and
OpenChamber stops it after ten idle minutes. To avoid re-reading every context-mode session
database on each start, the service saves what it derives from them and reuses it.

- **What is saved.** For each session database: the session ids, each session's project
  folder, per-day and per-hour event counts, and the numbers of each model step (time, tokens,
  cost). No event text: prompts, errors, decisions, commands and file paths stay in
  context-mode's own databases, which are only ever read.
- **Where.** In the extension's own data folder, which OpenChamber provides as
  `OPENCHAMBER_SERVICE_DATA_DIR` and deletes when the extension is removed, under
  `event-index/` (64 small JSON files, roughly 15 MB for 2,000 databases). Hosts that do not
  provide the folder keep the index in memory only, as 1.0 did.
- **When it is trusted.** An entry is used only for the exact database it was made from, and
  only while that database's size and modification time, and those of its write-ahead log,
  are unchanged. Anything unreadable, truncated, written by another version, made in another
  time zone or malformed is ignored and rebuilt. Writes are atomic, so a crash or a second
  running copy of the service costs at most a cache miss, never a wrong number.
- **What you see while it loads.** The first start after installing or updating reads every
  database once, newest first, so the chat in use appears early. The progress line shows real
  counts, for example "682 of 2,060 session databases, newest first". Later starts load the
  saved index and re-read only what changed. Databases that changed since the save keep
  their saved figures, marked as stale, until they are re-read.
- **How fast.** On a machine with 2,060 session databases, a restart was ready in about
  1.1 s with every session in the first answer; 1.0 needed 4.7 s and showed 36 sessions
  first. A first-ever start still reads everything, which took 25–55 s on that machine
  depending on how warm the disk cache was.

While the index loads, the panel refreshes every 1–5 seconds for up to two minutes, never
slower than your refresh setting, and then returns to that setting. "Manual only" stays
manual. Each page has at most one request to the service open at a time; a newer request
(a navigation, a chat switch) replaces one that is still waiting, and the latest view wins.

"No recent context-mode activity report" means no running context-mode server has written
its stats report recently. context-mode writes that report after it answers a tool call, so
the message does not mean the server failed to start.

## Settings

- **Locations.** Standard OpenCode locations beneath your home folder are checked on Windows,
  macOS and Linux. Custom profiles, remote hosts and relocated stores may need explicit paths.
  Set individual session/stat/content folders and the optional OpenCode database in Settings.
  Upstream v1's storage override is **`CONTEXT_MODE_DIR`**, not `CONTEXT_MODE_DATA_DIR`; the
  extension does not read it from the agent's environment. The shared data-root setting expects
  the standard `context-mode/sessions` and `context-mode/content` layout. For an arbitrary root
  such as `/data/cm-data`, set `/data/cm-data/sessions` and `/data/cm-data/content` individually.
  OpenCode metadata comes from one selected database, not a merge of every profile.
- **Privacy.** Show or hide event text (prompts, errors, decisions, commands); shorten file
  paths. The eye button in the header toggles event text for screen sharing.
- **Data.** Hide test sessions, include or exclude subagents, exclude projects by pattern, show
  or hide context-mode's estimate.
- **Display.** Text size (14–18 px), refresh interval, opening view, default range, items in
  every ranked list, rows per page, timeline page size, and which ledger columns to show.

## Develop

OpenChamber runs the built files as they are, so `panel/main.js` and `service/main.js` are
committed. Rebuild them with source changes. Development also needs Bun and a Node version
that runs the TypeScript test/scripts directly; Node 24+ is recommended. These build tools are
not installation requirements for someone adding the published extension.

```sh
bun install
bun run build       # panel/main.js and service/main.js
bun run typecheck
bun run test        # node --test against fixture databases
bun run smoke       # read-only run against the stores on this machine
bun run dev         # http://127.0.0.1:5178 — the real panel and service in a fake host
node --no-warnings scripts/bench-startup.ts   # cold start and restart timings of the built service
```

`scripts/bench-startup.ts` starts the built service as a throwaway child with a temporary data
folder, twice: once with no saved index and once with it. It records the first health reply,
first status, first answer with sessions, ready time, health latency while indexing and how
many databases each start re-read. `--sessions <dir>` pins a session folder, `--runtime <exe>`
uses another runtime (for example OpenChamber's own, with `ELECTRON_RUN_AS_NODE` set), and
`--entry <main.js>` benchmarks another build. Session stores are only read.

The dev harness emulates the OpenChamber host (theme, storage, service proxy) and offers rail,
page and Work Status layouts in dark and light. `#view=runs`, `#range=30d` or
`#session=ses_…` in the panel URL open a view directly. Its header counts the service requests
each frame has open (and the most seen at once). **Switch session** sends a host chat change to
every frame. `?slow=<ms>` delays every service answer to widen races, and `?panel=<path>` loads
another build of the page for before/after checks. Set `OPENCHAMBER_SERVICE_DATA_DIR` before
`bun run dev` to exercise the saved index.

## Notes on context-mode

Building this surfaced behaviour worth knowing when you read context-mode's own numbers:

- some historical **locally patched OpenCode V2** installations wrote the same `StepEnded`
  usage record into several project databases. This extension deduplicates matching usage
  samples. That is not a claim that every upstream installation duplicates every model step;
- stock v1 servers normally name stats files after the parent PID; two with one parent can
  overwrite the same `stats-pid-<ppid>.json`. The extension remembers only
  snapshots it observes **during its service's lifetime**. It cannot recover unseen overwrites,
  and that in-memory history is lost when the service or OpenChamber restarts. Run counters are
  process-level, not exact per-chat accounting; only `stats-pid-*.json` filenames are discovered.
  The “live” indicator uses parent-PID existence and update freshness, not direct child-server identification;
- v1 `tokens_saved` counts sandbox file and network reads as saved context. It is an estimate,
  not measured LLM tokens or dollars saved;
- unsupported/missing tables and some read errors can yield empty or zero results. Check
  Locations and your capture setup before interpreting them as no activity;
- after updating the built extension, restart its background service or OpenChamber so the
  running service loads the new bundle. The first start after an update builds the saved
  index once (see *Startup and the saved index*). Changing this reader does not repair its
  data producer.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

MIT
