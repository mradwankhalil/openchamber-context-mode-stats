# Changelog

All notable changes to Context Mode for OpenChamber. Versions follow
[semantic versioning](https://semver.org/); the version in `package.json` is the one
OpenChamber shows in Settings → Extensions.

## Unreleased

### Added

- **context-mode v2 stores.** Project DBs under `~/.context-mode/projects/` are found
  automatically and shown as sessions, timelines, insights and knowledge bases. v2 records no
  token counts or run-stat files, so Runs and usage curves stay empty for that data.

## 1.1.0 — 2026-11-17

Opening the panel after a restart is now fast. Before 1.1.0 the extension's service rebuilt
its whole index from every context-mode session database each time it started, and
OpenChamber stops idle extension services after ten minutes, so reopening the panel
repeated a full scan. On a machine with 2,060 session databases that took 25–55 seconds.
The first answer covered only eight databases, so the current chat could be missing for a
while.

### Added

- **Saved index.** The service keeps the figures it derives from each session database in
  the extension's own data folder (`OPENCHAMBER_SERVICE_DATA_DIR`, provided by the host and
  removed with the extension). A restarted service answers from it at once and re-reads
  only the databases that changed, including changes that touched only the write-ahead log.
  A database that disappeared drops out. On the 2,060-database machine a restart is ready
  in about 1.1 s, with every session in the first answer, against 4.7 s and 36 sessions
  before.
- The saved index holds counts, session ids and each session's project folder: no
  prompts, errors, commands or file paths from events. It is ignored and rebuilt when it
  is unreadable, truncated, from another version or time zone, or malformed. It is written
  atomically under unique temporary names, so two running copies of the service, or a
  crash mid-write, cost at most a cache miss. Each copy only prunes entries for its own
  session folders.
- **Newest first.** When databases have to be read, the most recently written ones come
  first, so the chat in use appears early. A changed database keeps showing its saved
  figures, marked as stale, until it has been re-read.
- **Startup polling.** While the index is still loading, the panel refreshes every 1–5
  seconds for up to two minutes, never slower than your saved refresh interval. Then it
  returns to that interval. "Manual only" stays manual.
- The progress line shows real counts ("682 of 2,060 session databases, newest first"),
  how many came from the saved index, and how old any stale figures are. There is no
  invented percentage.
- `scripts/bench-startup.ts`: a cold-start and restart benchmark of the built service.
- Dev harness: a per-frame count of open service requests, a "Switch session" button,
  `?slow=<ms>` to delay answers and `?panel=<path>` to load another build.

### Changed

- "context-mode server not running" is now **"No recent context-mode activity report"**.
  context-mode writes its stats report after it answers a tool call, so a missing report
  does not prove the server failed to start.
- When a refresh fails, the panel keeps the last figures on screen and says when they
  were last updated.
- Indexing yields to the service's HTTP server every 30 ms instead of every eight
  databases, so status and health stay responsive during a long scan.
- The service saves the index when it is asked to stop.

### Fixed

- Renders no longer overlap. Navigation, chat switches and automatic refreshes go through
  one queue, and the page has at most one service request open at a time. A newer request
  replaces the waiting one, and the latest view wins.
- Automatic refresh no longer stops for good when a user action finishes before an older
  scheduled refresh.
- Merged session figures no longer depend on the order databases were read in.
- A run-stats file that another context-mode server overwrote with a same-size report
  within one file-time tick could be missed, losing that run. Files written in the last
  two seconds are now always re-read.
- Flaky tests: one clock per test fixture; responsiveness measured in yields, not
  wall-clock time; the date-range test no longer fails in the first hour after midnight.

### Upgrading

The first start after updating reads every session database once, newest first, and saves
the index. Later starts reuse it. Hosts that do not provide `OPENCHAMBER_SERVICE_DATA_DIR`
keep the index in memory, as 1.0 did. After installing, restart the extension's service or
OpenChamber so the new bundle runs.

## 1.0.0 — 2026-10-15

First release: Sessions, Session detail, Insights, Runs and Knowledge views; the Work Status
card; settings for locations, privacy, data and display. Read-only over context-mode v1
stores and OpenCode's database. The compatibility and capture documentation was revised on
2026-10-30.
