# Reconciling incremental ingest — design

Date: 2026-07-09

## Problem

Today ingest is **insert-only**. On every run it re-fetches the last ~50 messages
of every conversation, turns relevant ones into tasks, and dedups solely by an
exact `channel:ts` fingerprint. It never updates, completes, or closes anything.

Consequences:

- A follow-up on an existing topic (a new `ts`) creates a *second* task instead
  of updating the first.
- A message saying I finished something has no effect — the task stays open.
- A task whose PR has merged stays open indefinitely.
- There is no record of *when* a task last changed or *who* changed it.

## Goal

Ingest should look at **everything new since the last run** and *reconcile* it
against the existing tasklist:

- **New** work → new task.
- **Update** to existing work → folded into the existing task (posted as such).
- **Completion** signal → existing task marked done.
- **Merged PR** → associated task closed (marked done).
- Every task shows **when it was last updated and by whom**.

## Decisions (locked)

1. **Correlation: thread-primary, LLM fallback.** A new Slack message is linked
   to an existing task deterministically by Slack thread identity
   (`thread_ts`); only messages with no thread match are handed to LLM judgment
   against the current open tasks.
2. **Watermark: global high-water-mark.** One number in `meta` holds `max(ts)`
   seen last run. Next run fetches `oldest = HWM − overlap` for every channel.
   Justification: Slack `ts` is wall-clock-monotonic, so a genuinely new message
   always has a larger `ts` than anything seen during the prior run — a global
   mark cannot starve a quiet channel. A small overlap window re-scans the
   boundary to catch edits/late arrivals; the existing fingerprint dedup absorbs
   the re-scan. Rejected: per-channel marks (growing state, precision is
   illusory here) and deriving the cutoff from a run's `started_at` (breaks on
   failed runs, conflates "when we ran" with "what we saw", forces a
   UTC-string→epoch-float conversion).
3. **PR merge: `gh` check during ingest → `done`.** For every open task with a
   `pr_url`, ingest runs `gh pr view <url> --json state,mergedAt`; if merged, the
   task is set `status='done'` — the same bucket the digest already reports as
   completed. Rejected: a distinct `closed` status (would force UI + digest to
   learn a third status) and Slack-signal-only detection (misses silent merges).

## Data model changes (`src/store.js`)

New columns on `tasks` (added via the existing idempotent `ALTER TABLE` loop):

| Column             | Type   | Meaning                                                            |
|--------------------|--------|--------------------------------------------------------------------|
| `source_thread_ts` | `TEXT` | Slack thread anchor for correlation. Falls back to `source_ts` for un-threaded root messages. |
| `updated_by`       | `TEXT` | Actor of the last change: `me` \| `slack` \| `agent`. Defaults to `me`. |

New `meta` key:

- `ingest_hwm` — global high-water-mark, the `max(ts)` seen on the last
  successful run. Absent on first run (treated as "scan a bootstrap window").

Store function changes:

- `upsertTask` accepts and persists `source_thread_ts` and `updated_by`
  (default `slack` for ingest-originated inserts).
- `patchTask` accepts an optional `updated_by` and writes it alongside the
  existing `updated_at = datetime('now')` bump. Default `me`.
- `addComment` accepts an optional `updated_by` (default = the comment
  `author`) and sets it on the parent task's `updated_by` when it bumps
  `updated_at`.
- New `findOpenTaskByThread(db, thread_ts)` — returns the open task whose
  `source_thread_ts` matches, or `null`. This is the deterministic correlation
  path.

`fingerprint` is **unchanged** (still `channel:ts`). It remains the guard that
prevents re-inserting the *same* message during the overlap re-scan. Thread
correlation is a separate, higher-level match performed by the ingest agent, not
by the fingerprint.

## Ingest prompt rewrite (`src/prompts.js`)

`ingestPrompt` changes from insert-only to reconcile-oriented:

1. **Read current state.** `GET /api/tasks?status=open` so the agent knows what
   already exists, and read the current `ingest_hwm`.
2. **Fetch the window.** For each conversation,
   `conversations.history?oldest={HWM − overlap}`. For threads that saw activity,
   also pull `conversations.replies`. On first run (no HWM), use a bootstrap
   lookback window.
3. **Filter for relevance** — unchanged from the current prompt: direct
   @-mentions/DMs, @channel/@here in channels I'm in, and messages in my domain
   per `context.md`. Skip FYI/social/bot noise.
4. **Reconcile each relevant message** via the decision tree:
   - **Thread match** (`thread_ts` equals an existing task's `source_thread_ts`)
     → *update*: `POST /api/tasks/:id/comments` with `author:"slack"`. If the
     message signals I finished the task (e.g. "done", "shipped", "thanks,
     closing") → also `PATCH status:"done"`.
   - **No thread match** → ask: does this relate to an open task? If yes → treat
     as an update (same as above). If no → **new task**: `POST /api/tasks`
     carrying `title`, `detail`, `source_channel`, `source_ts`,
     `source_thread_ts`, `source_permalink`, `priority`.
5. **PR-merge sweep.** For every open task with a `pr_url`, run
   `gh pr view <url> --json state,mergedAt`. If merged → `PATCH status:"done"`
   and post a "PR merged — closing" comment (`author:"slack"`).
6. **Advance the watermark.** Write `ingest_hwm = max(ts)` seen this run, then
   emit the one-line JSON summary (counts: new / updated / completed / closed).

Constraints carried over: uses `SLACK_USER_TOKEN` + `curl` + `gh` only; must not
call any Anthropic API; builds JSON payloads without relying on `jq`.

## API surface (`src/routes.js`)

- `POST /api/tasks/:id/comments` accepts an optional `updated_by` (default = the
  comment `author`). Ingest passes `"slack"`; agent comment runs pass `"agent"`.
- `PATCH /api/tasks/:id` accepts an optional `updated_by` (default `me`). Ingest
  passes `"slack"`.
- Watermark access without direct DB reach:
  - `GET /api/meta/ingest_hwm` → `{ value }`.
  - `PUT /api/meta/ingest_hwm` with `{ value }` → persists it.

## UI (`public/index.html`)

Add one metadata line per task rendered from `updated_at` + `updated_by`:

```
updated {HH:MM} · by {who}
```

`slack` / `agent` / `me` get distinct styling, mirroring how comment authors are
already styled.

## Config (`src/config.js`)

- `INGEST_OVERLAP_MS` (default ~600000 = 10 min) — how far below the HWM to
  start the re-scan.
- `INGEST_BOOTSTRAP_MS` — lookback window used on the first run when no HWM
  exists yet.

## Non-goals (YAGNI)

- No per-channel watermarks.
- No new `closed` status distinct from `done`.
- No historical backfill beyond the overlap / bootstrap window.
- No edit-diffing beyond the overlap re-scan.

## Testing

- `store` unit tests: new columns default correctly; `patchTask`/`addComment`
  set `updated_by`; `findOpenTaskByThread` matches only open tasks on
  `source_thread_ts`; `upsertTask` persists the thread anchor and still dedups by
  fingerprint on the overlap re-scan.
- API tests: `updated_by` accepted and defaulted on PATCH and comments; meta
  watermark GET/PUT round-trips.
- Integration: a simulated ingest that (a) inserts a new task, (b) folds a
  thread reply into it as a `slack` comment, (c) marks it done on a completion
  signal, and (d) closes a `pr_url` task on a merged-PR `gh` result — using the
  claude stub.
