# Context Mode for OpenChamber

An [OpenChamber](https://github.com/openchamber/openchamber) extension that shows everything
[context-mode](https://github.com/mksglu/context-mode) records for **OpenCode**: per chat session,
per project, across days, and live for the context-mode servers running right now.

It reads context-mode's own databases and stats files (and, optionally, OpenCode's database for
session titles and models), never writes to them, and labels the one number context-mode only
estimates.

## What you get

**Sessions.** A statement of the filtered set (sessions, projects, prompts, model steps, tokens
the model read and generated, cache share, peak context, errors, retry loops, decisions,
compactions, context-mode tool traffic), a daily activity chart with six metrics (click a day to
filter to it), and a sortable ledger of sessions with title, project, model and subagent links.

**Session detail.** The context curve: prompt size of every model step, with compactions and
sudden drops marked. Then the timeline of everything context-mode captured (filterable by type),
prompts, files touched, recurring errors, decisions and constraints, subagents, the context-mode
runs that overlapped the session, its knowledge base and its resume snapshots.

**Insights.** When you work (weekday × hour), what happened (event mix), projects, heaviest
sessions, models, most-touched files, shell commands, recurring errors, skills, references
(issues and PRs), retry loops and intents.

**Runs.** Each context-mode MCP server: tool calls by tool, bytes returned into context, bytes
indexed instead, bytes read inside the sandbox, and context-mode's own "tokens saved" estimate,
hatched and explained.

**Knowledge.** context-mode's FTS knowledge bases: databases per project, what was indexed (command
output, fetched pages, files), sources and chunks per day, every source.

**In the chat.** A Work Status card for the open chat: current and peak context, the last 40
steps' prompt sizes, prompts, steps, tokens, errors, compactions, and the live server's traffic.

Everything follows one filter bar (date range, project, search), the OpenChamber theme, and
your text size.

## What the numbers mean

| Number | Meaning |
|---|---|
| Model steps | One per model call (context-mode's `agent_usage` events), de-duplicated across databases. |
| Tokens read | Input + cache read + cache write, summed over steps: what the model actually read. |
| Peak context | The largest single prompt of any step: how full the context window got. |
| From cache | Cache read ÷ tokens read. |
| Returned to context | Bytes context-mode's tools put into the conversation. Measured. |
| Indexed | Bytes written to the knowledge base instead of the conversation. Measured. |
| Read in the sandbox | Bytes code run by `ctx_execute` read from disk or the network. Measured. |
| Tokens "saved" (est.) | context-mode's formula: (indexed + sandbox reads + cache) ÷ 4. It counts every byte a script touches as if it would have entered the context, so treat it as an upper bound. |

Every figure has an info hover with its definition, and Settings → About the numbers lists them
all. [DESIGN.md](DESIGN.md) documents the stores and the reasoning in full.

## Install

1. In OpenChamber open **Settings → Extensions** and add this repository (or a local clone).
2. Approve the dialog. It asks to **run a local service**: that is the process that reads the
   databases. Nothing else is requested.
3. Open the brain icon on the extensions rail, or **Extension pages → Context Mode** for a full
   page. The **Context Mode** section appears in the chat's Work Status panel.

Requirements: OpenChamber 2.0.4 or newer, context-mode installed for OpenCode. Session and
knowledge-base views need `node:sqlite`, which current OpenChamber builds ship (Node 22.5+).

## Settings

- **Locations.** Every store is found automatically from your home folder and shown with its
  status, file count, size and last update. If something is missing, set the context-mode data
  folder (the same thing `CONTEXT_MODE_DATA_DIR` points at), individual folders for session
  databases, run stats files and knowledge bases, or the path to OpenCode's `opencode.db`.
- **Privacy.** Show or hide event text (prompts, errors, decisions, commands); shorten file
  paths. The eye button in the header toggles event text for screen sharing.
- **Data.** Hide test sessions, include or exclude subagents, exclude projects by pattern, show
  or hide context-mode's estimate.
- **Display.** Text size (14–18 px), refresh interval, opening view, default range, items in
  every ranked list, rows per page, timeline page size, and which ledger columns to show.

## Develop

OpenChamber runs the built files as they are, so `panel/main.js` and `service/main.js` are
committed. Rebuild them with every change.

```sh
bun install
bun run build       # panel/main.js and service/main.js
bun run typecheck
bun run test        # node --test against fixture databases
bun run smoke       # read-only run against the stores on this machine
bun run dev         # http://127.0.0.1:5178 — the real panel and service in a fake host
```

The dev harness emulates the OpenChamber host (theme, storage, service proxy) and offers rail,
page and Work Status layouts in dark and light. `#view=runs`, `#range=30d` or
`#session=ses_…` in the panel URL open a view directly.

## Notes on context-mode

Building this surfaced behaviour worth knowing when you read context-mode's own numbers:

- each model-step usage event is written into every project database the session's plugin has
  open, so naive sums count steps many times over;
- two context-mode servers started by the same parent process write the same
  `stats-pid-<ppid>.json` and overwrite each other's counters;
- `tokens_saved` counts sandbox file and network reads as saved context.

## License

MIT
