# Tasklist Agent — Design

**Date:** 2026-07-09
**Status:** Approved (pending spec review)
**Location:** `~/projects/tasklist-agent` (standalone; unrelated to bluerobins2026)

## 1. Purpose

A personal, local task dashboard that reads my Slack activity, turns it into a
deduplicated task list I can view/check-off/comment on in the browser at
`http://tasklist`, lets me get help from Claude on any task, and pushes a daily
digest to Discord.

**Hard constraint: no Anthropic API budget.** All LLM reasoning runs through the
**Claude Code CLI in headless mode (`claude -p`)**, which bills against my existing
Claude Code subscription — never the paid API. Slack's Web API and Discord webhooks
are free.

## 2. Architecture

A single always-on **Node + Express** server (`server.js`), bound to `127.0.0.1`,
managed by a macOS **launchd** LaunchAgent (auto-start on login, auto-restart on
crash). It owns a **SQLite** store and serves one static HTML page. The server has
**no LLM logic of its own** — whenever reasoning is needed it *spawns `claude -p`*,
and those headless runs talk back to the server over the localhost JSON API.

```
Browser ── http://tasklist ──▶ Express ──▶ SQLite (tasks, comments, runs, meta)
                                  │
                                  ├─ node-cron (30-min ingest, daily digest)
                                  └─ spawns → claude -p ──curl──▶ Slack Web API (user token)
                                                        ──curl──▶ localhost API (write tasks/comments)
                                                        ──curl──▶ Discord webhook (digest)
```

Why this shape (alternatives considered):

- **Standalone Node service calling the paid API** — cleanest code, but costs API
  money. Ruled out by the budget constraint.
- **Pure Claude Code scheduled routines, no web app** — free, but no live browser
  dashboard to check off / comment in. Misses the core ask.
- **Local web server + `claude -p` as the brain** — free, gives the browser
  dashboard, Claude Code is the reasoning engine on demand. **Chosen.**

## 3. Tech stack

- Node + Express, SQLite (better-sqlite3, WAL mode), one static HTML/JS page
  (`fetch` + polling; no framework).
- `node-cron` for scheduling.
- Minimal dependencies on purpose — the codebase must be small enough for `claude -p`
  to reason about easily.

## 4. Data model (SQLite, WAL)

- `tasks(id, title, detail, source_channel, source_ts, source_permalink,
  fingerprint UNIQUE, status[open|done], priority, created_at, updated_at)`
- `comments(id, task_id, author[me|agent|system], body, created_at)`
- `runs(id, kind[ingest|reply|digest], task_id NULLABLE, status[running|ok|failed],
  started_at, finished_at, log)` — tracks every `claude -p` invocation so the UI can
  show spinners and failures.
- `meta(key, value)` — per-channel ingest cursors, ingest/reply locks, last-run
  timestamps.

**Dedup:** `fingerprint = sha1(source_channel + ':' + source_ts + ':' + slug(title))`.
Re-running ingest never duplicates a task. A task already marked `done` is **not**
resurrected if it reappears in a later ingest.

## 5. HTTP API (localhost-only)

- `GET  /api/tasks?status=open|done|all` — list.
- `GET  /api/tasks/:id` — task + comment thread + active-run status.
- `POST /api/tasks` — upsert by fingerprint (used by ingest). Body: title, detail,
  source_channel, source_ts, source_permalink, priority.
- `PATCH /api/tasks/:id` — change status (open/done), edit title/detail/priority.
- `POST /api/tasks/:id/comments` — add a comment. `{author:"me", body, ask_agent:bool}`.
  When `author=me` and `ask_agent` is true (or body contains `@claude`), the server
  opens a `runs` row and spawns a reply run.
- `GET  /api/status` — last ingest/digest run status + timestamps (for the UI banner).

## 6. The three Claude Code triggers

Every trigger spawns `claude -p` with:
- `--output-format json` and a restricted tool set (Bash for curl; Read/Write only
  where needed).
- Env: `SLACK_USER_TOKEN`, `TASKLIST_API=http://127.0.0.1:<port>`, plus for digest
  `DISCORD_WEBHOOK_URL`.
- The `claude` binary is resolved from `CLAUDE_BIN` (default `claude`), so tests can
  point at a stub that emits canned JSON and never touches the subscription.

### 6.1 Ingest — every 30 minutes (cron)

Prompt gives Claude the Slack + local-API contract. It:
1. Lists my conversations via `users.conversations`
   (`types=public_channel,private_channel,im,mpim`).
2. For each, pulls new history since the stored cursor
   (`conversations.history?oldest=<cursor>`); uses `search.messages` for @-mentions.
3. Resolves permalinks (`chat.getPermalink`).
4. Extracts action items (each with its source channel + message ts).
5. `POST`s each to `/api/tasks` (server dedups by fingerprint).
6. Advances the per-channel cursor in `meta`.

Requires **Slack user-token scopes**: `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`,
`mpim:read`, `users:read`, `search:read`.

### 6.2 Reply — on demand

Posting a comment with `ask_agent`/`@claude` spawns a detached `claude -p` scoped to
that one task. It fetches the task + thread from the API, can search Slack and draft
responses, reasons, then `POST`s an `author=agent` comment and marks the run `ok`.
The page polls `/api/tasks/:id` every ~2s and renders new agent comments; a spinner
shows while the run is live.

### 6.3 Digest — daily (cron)

`claude -p` summarizes open/done tasks + Slack highlights into a Discord-formatted
message; the server (or the run) `POST`s it to `DISCORD_WEBHOOK_URL`. Webhook chosen
over the Discord MCP for robustness in unattended runs; MCP is a documented
alternative.

## 7. Hostname `http://tasklist`

Node runs unprivileged on port `8787`. A one-time `sudo ./setup.sh`:
1. Adds `127.0.0.1 tasklist` to `/etc/hosts`.
2. Installs a `pf` redirect `tcp 80 → 8787` so plain `http://tasklist` works.

Fallback if the pf step is skipped: `http://tasklist:8787`.

## 8. Process management (launchd)

`~/Library/LaunchAgents/com.aaryan.tasklist.plist` with `RunAtLoad` + `KeepAlive`,
running `node server.js`, logging stdout/stderr to `logs/`. `setup.sh` loads it;
a `teardown.sh` unloads and removes the pf/hosts entries.

## 9. Error handling & safety

- Server binds `127.0.0.1` only — the API is never exposed on the network.
- Secrets live in a gitignored `.env`: `SLACK_USER_TOKEN`, `DISCORD_WEBHOOK_URL`,
  `PORT`, `CLAUDE_BIN`.
- Slack rate-limit / token-expiry errors and `claude -p` failures or timeouts (5-min
  kill) are logged to `runs` and surfaced as a UI banner + per-task retry button.
- Single-writer server. An ingest lock and per-task reply locks in `meta` prevent
  overlapping runs.

## 10. Testing

- `node:test` units: fingerprint/slug, task upsert + dedup, cursor advance, digest
  formatting.
- Integration: boot the server on an ephemeral port with a **stub `claude`**
  (`CLAUDE_BIN`) and assert the resulting store state (ingest + reply flows) — no
  subscription usage.
- Manual: one live ingest against a real Slack test channel; confirm a task appears,
  a reply run responds, and a digest posts to Discord.

## 11. One-time setup (user)

1. Create a Slack app in the workspace → add the **User Token Scopes** in §6.1 →
   install to workspace → copy the `xoxp-…` token.
2. Create a Discord webhook in the target channel → copy the URL.
3. Run `./setup.sh` (writes `.env`, hosts + pf, installs launchd agent, starts the
   server) → open `http://tasklist`.

## 12. Build phases

1. **Dashboard + ingestion** — web app at `http://tasklist`, SQLite store, 30-min
   `claude -p` ingest → tasks. View, check off, comment (comments stored only).
   Usable on its own.
2. **Agent replies** — comment/"ask" wakes a `claude -p` run that responds in the
   task thread and can take actions.
3. **Daily Discord digest push.**

## 13. Out of scope (YAGNI)

- Multi-user / auth (single local user).
- Mobile app (dashboard is responsive HTML; Discord digest covers phone).
- Real-time Slack streaming (30-min pull is enough).
- Notion/Todoist/etc. integrations.
