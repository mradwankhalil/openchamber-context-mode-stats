# Context Mode Stats for OpenChamber

An OpenChamber extension that shows what
[context-mode](https://www.npmjs.com/package/context-mode) is saving you: the
live process stats, scoped totals (all time / single process / day range),
per-tool breakdowns and a daily savings series — in the extensions rail panel
and in the chat's Work Status panel.

```
Live process                          Aggregate  [All time | Today | 7d | 30d | process…]
──────────────────────────            ──────────────────────────
Tokens saved     ~310K                Tokens saved     ~21.6B
Kept out         1.1 MB (66%)         Est. value       $2,570 – $40,970
Tool calls       170                  Model mix        deepseek-v4.1-flash 44%, …
[donut: kept out vs returned]         [donut + top tools bar chart]

Tokens saved per day
[column chart]
```

## What it reads

The per-process stats files context-mode writes to
`<config>/opencode/context-mode/sessions/stats-pid-*.json`. Every candidate
store location is scanned (XDG config home, `~/.config`, `.opencode-v2`) and
files are deduped by pid + session start, so mirror stores never double-count.
To pin one directory, set `CONTEXT_MODE_STATS_DIR` for the service.

## Scope selector

The aggregate section header is a picker: **All time**, **Today**, **Last 7
days**, **Last 30 days**, or any individual context-mode process. Metrics,
donut, tool bars and the daily series all follow the selection.

## How dollar figures are computed

context-mode's own flat $5/1M estimate is **not** shown. Instead the service
prices saved tokens at your models' real rates:

- **Model mix** — OpenCode's `opencode.db` (opened read-only) records every
  session's model and token usage; the mix for the selected window is weighted
  by input-side tokens (input + cache read), because kept-out bytes would have
  been prompt tokens.
- **Rates** — [models.dev](https://models.dev) `api.json`, cached on disk for
  24 h at `~/.config/openchamber/context-mode-stats-pricing.json`.

Saved tokens are prompt-side, so the value is a range: the lower bound prices
every saved token at cache-read rates, the upper bound at full input rates.
Hover the figure for the basis and rate coverage. If the database is missing
or no model matches a rate, dollar rows are simply omitted. Set
`OPENCODE_DB_PATH` to point at a specific database file.

## Install

In OpenChamber, open **Settings → Extensions**, add this repo (or a local
folder path), and approve the dialog — it includes **Run a local service**,
which is what reads the stats. The chart icon then appears on the extensions
rail; the "Context Mode" section is available in the chat's Work Status panel
section list.

## Develop

OpenChamber never compiles an extension: `panel/main.js` and
`service/main.js` are built and committed. Rebuild and commit them with every
change.

```
bun install
bun run build      # bundles panel/main.js and service/main.js
bun run typecheck
node scripts/smoke.mjs
```
