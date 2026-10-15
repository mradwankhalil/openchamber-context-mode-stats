# Context Mode Stats for OpenChamber

An OpenChamber extension that shows what
[context-mode](https://www.npmjs.com/package/context-mode) is saving you: the
live process stats, all-time totals, per-tool breakdowns and a daily savings
series — in the extensions rail panel and in the chat's Work Status panel.

```
Live process                          All-time
──────────────────────────            ──────────────────────────
Tokens saved     ~310K                Tokens saved     ~21.6B
Est. $ saved     $1.55                Est. $ saved     $108,272
Kept out         1.1 MB (66%)         Kept out         76.2 GB
Tool calls       170                  Tool calls       13,239
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
