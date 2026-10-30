# Product

<!-- impeccable:product-schema 1 -->

> Recorded from the owner's written brief (2026-10-30). The owner delegated every open
> decision ("your best recommendation I will follow"); facts marked *(inferred)* came from
> that delegation, not from a direct answer.

## Platform

web

## Users

People who run OpenCode inside OpenChamber with the
[context-mode](https://github.com/mksglu/context-mode) plugin and MCP server installed.
They are developers who run many agent chats and subagents a day, across many projects and
worktrees, and want to know what context-mode is actually doing for them: what it captured,
what it kept out of the model's context, where tokens go, and which sessions are heavy.

The panel is opened in a side rail next to a live chat, so it is read at a glance while
work is in flight, and occasionally expanded to full screen for a review of past runs.

## Product Purpose

An OpenChamber extension that turns every data store context-mode writes for OpenCode into
an honest, readable dashboard:

- per chat session (OpenCode `ses_…` ids) and per project;
- across runs (each context-mode MCP server process) and across days;
- live, for the process serving the current chat.

Success: a user can answer "what is context-mode doing, for which session, and is it worth
it" without reading source code, and never sees a number whose meaning is unexplained.

## Positioning

It reads context-mode's own stores directly (session event databases, per-process stats
files, FTS knowledge bases) and, optionally, OpenCode's own database for session titles,
models and token usage. It separates **measured** values from **estimates**: context-mode's
`tokens_saved` is `(indexed + sandbox-read + cache bytes) / 4`, a counterfactual upper bound,
and is always labelled as such.

## Operating Context

- Runs inside OpenChamber (desktop or web) as an extension: a sandboxed iframe panel, a Work
  Status section in the chat, and a local Node service spawned by the host.
- The service does not inherit the host environment, so every location is discovered from
  the home directory and OS conventions, and can be overridden in the extension's own
  Settings view (stored in OpenChamber extension storage).
- Must not be tied to the author's machine: it ships as a public repository.

## Capabilities and Constraints

- OpenCode only *(owner answer)*. Claude Code and other harness stores are ignored.
- Data sources: `stats-pid-*.json` (per MCP process), session event DBs (`<hash>.db`,
  `session_events` / `session_meta` / `session_resume` / `tool_calls`), content FTS DBs
  (`sources` table), and OpenCode's `opencode.db` (`session_v2`, `session`, `project`).
- Read-only. Never writes to any context-mode or OpenCode store.
- Event content (prompts, decisions, errors, file paths) can be shown *and* hidden; the
  owner asked for both options *(owner answer)*.
- Dollar figures derived from `tokens_saved` are not shown *(owner delegated; recommended)*.
- Bigger type than the previous version: body 15–16px, headline numbers 22px+ *(owner answer)*.
- Every list length ("top N") and every location is configurable in Settings *(owner answer)*.

## Brand Commitments

- Icon: the owner's pixel brain (`icon.svg`, from `brain-icon.svg`).
- Lives inside OpenChamber's theme; uses the host's theme tokens.

## Evidence on Hand

Real local data on the author's machine (not shipped): ~1,400 session DBs with ~330k events
and ~5,600 sessions, ~500 stats files, 7 content DBs. No screenshots or testimonials exist
and none may be invented.

## Product Principles

1. Measured first, estimates labelled. Never present a counterfactual as a fact.
2. Every number answers "of what, since when, for which session".
3. Glanceable in a narrow rail; deep on demand.
4. Works on any machine: discover, then let the user correct.
5. Privacy is a switch the user controls, not a default we assume.

## Accessibility & Inclusion

Readable at a glance: larger base type, high contrast via host tokens, keyboard-reachable
controls, no meaning carried by color alone.
