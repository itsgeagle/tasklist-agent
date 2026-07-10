# Run observability + lean context — design

**Date:** 2026-07-10
**Status:** approved (design)

## Problem

Two related seams in the current run/agent model:

1. **You can't watch most of what the agent does.** `spawnAgent` already emits a live
   trace over `runbus` for *every* run kind, but the plumbing only exposes it for
   ingest/digest: the SSE endpoint hard-rejects anything but those two kinds
   (`routes.js` `JOBS` guard), and `runbus` keys streams by *kind*, not by a specific
   run. So a `@claude` reply or a per-task diagnose/execute is "just a blank screen."
   The kind-keying also means two tasks running the same kind concurrently would
   collide on one stream. And the trace is in-memory only — a finished (or
   pre-restart) run can't be reopened.

2. **The reply flow rediscovers data the server already has.** `replyPrompt` tells the
   agent to `curl` the task and its comment thread itself, spending its first turns
   (and tokens) fetching what lives in SQLite two feet away. Prompts also each
   re-teach the same rules (Bash+curl+gh only, no Anthropic API, no jq → python3, the
   comment-POST recipe), duplicated across five prompt builders.

Goal: make **every** run watchable live *and* replayable after the fact, keyed by the
run itself; and stop paying agent turns to fetch context the server can inline.

## Approach

Make **`runId` the single identity** for a run's lifecycle, streaming, and trace —
superseding the kind-keyed model from the 2026-07-09 live-run-streaming design (which
explicitly deferred cross-restart persistence). `runbus` keys by `runId`; every
published event is teed to a durable **per-run JSONL trace file**; the SSE endpoint
serves a specific run (live buffer + tail while active, file replay once finished).
The UI's existing console component is generalized to subscribe to any `runId`,
reachable from every task and every job.

Separately, assemble reply/diagnose context **server-side** and inline it into the
prompt, and factor the duplicated prompt boilerplate into shared constants.

These are independent workstreams (observability vs. context) and can land in either
order; the spec treats them as one feature because they share the "rethink the run
model" framing the work started from.

## Components

### `src/runbus.js` — key by `runId`

- `begin(runId)`, `publish(runId, ev)`, `end(runId, status)`, `subscribe(runId, cb)`,
  `snapshot(runId)` — same shapes as today, but the key is the run id, not a stream
  kind. Drop `streamKey()` (no longer needed).
- In-memory bounded buffer (MAX 500) stays — it backs the **live** path only.
- State remains per-process (single always-on server).

### `src/trace.js` (new) — durable per-run trace

- `open(runId)` → opens an append stream to `data/traces/<runId>.jsonl`.
- `append(runId, ev)` → writes `JSON.stringify(ev) + '\n'`.
- `close(runId)` → closes the stream.
- `read(runId)` → returns the parsed event array (for finished-run replay); returns
  `[]` if the file is missing.
- `prune(keepRuns = 500)` → deletes trace files for runs older than the most recent
  `keepRuns`, called opportunistically on run creation so disk can't grow unbounded.
- `data/traces/` is created on demand; `data/` already exists.

### `src/agent.js` — tee events to `runbus` + trace, keyed by `runId`

- `const key = runId` (drop the `streamKey` call). `runbus.begin(runId)` +
  `trace.open(runId)` after `createRun`.
- Every event currently sent to `runbus.publish` is *also* `trace.append`ed. A tiny
  `emit(ev)` local does both, so the `reset`/`start`/`text`/`tool`/`result`/`stderr`/
  `done`/`end` paths stay in lockstep.
- `finish(status)` → `runbus.end(runId, status)` + `trace.close(runId)`.
- Cost/metric capture from the `result` event is unchanged.
- Event detail level is unchanged (curated summaries — not the raw firehose).

### `src/store.js` — run queries for the API

- `runsForTask(db, taskId)` → recent runs for a task (id, kind, status, cost_usd,
  cost_estimated, started_at, finished_at), newest first.
- `activeRuns(db)` → all runs with `status='running'` (id, kind, task_id, started_at).
- `getRun(db, runId)` → single run row (meta) or null.
- (No schema change: `runs` already has kind, task_id, status, cost, timestamps, and
  boot-reconcile already flips orphaned `running` rows to `failed`.)

### `src/routes.js` — run-scoped endpoints

- `GET /api/runs/:runId/stream` (SSE): resolve the run.
  - If `status='running'` **and** present in `runbus` → replay the in-memory buffer +
    tail live, closing on `{t:'end'}` (today's behavior, now per run).
  - Else (finished / not in memory) → `trace.read(runId)` and write each event as a
    `data:` frame, then a synthetic `{t:'end', status}` and `res.end()`.
  - Unknown runId → 404. 15s `: hb` heartbeat; clean up on `req` `close`.
- `GET /api/runs/active` → `store.activeRuns` (drives the activity indicator and lets
  manual job triggers resolve their runId).
- `GET /api/tasks/:id/runs` → `store.runsForTask`.
- `GET /api/runs/:runId` → `store.getRun` (meta; 404 if absent).
- Remove the kind-keyed `GET /api/runs/:kind/stream` and its `JOBS` guard.

### `src/prompts.js` — server-assembled context + shared preamble

- `AGENT_RULES` constant: "Use Bash + curl + gh only. Do NOT use any Anthropic API.
  Do NOT use jq — build JSON with python3." Reused by all prompt builders.
- `postCommentRecipe(apiBase, taskId)` helper for the repeated comment-POST curl.
- `renderThread(db, taskId)` → compact text rendering of the task (title, detail,
  priority, source) + its comment thread (author · when · body), for inlining.
- `replyPrompt({ apiBase, db, task })`:
  - Keeps **full** `context.md` (`loadContext()`), per decision.
  - Inlines `renderThread(db, task.id)` — the agent gets the whole thread up front.
  - Removes the "fetch the task and its comment thread" discovery step; Slack reading
    stays *optional* ("you MAY read Slack if this task needs it"), no longer the
    default path. Agent reasons over the inlined thread and posts one comment.
- `diagnosePrompt` (in `agent-modes.js`) also receives the inlined thread so any
  context added via `@claude` before dispatch is visible. `agent-modes.js` mode
  builders take `db` so they can call `renderThread`.

### `src/dispatch.js` / `src/cron.js` — wiring

- `runReply` passes `db` into `replyPrompt`.
- `dispatch` passes `db` into the mode's diagnose prompt builder.
- No behavioral change to the state machine, locks, or cost accounting.

### `public/index.html` — generalized console

- The existing `#console` panel is generalized: `openConsole(runId, title)` opens
  `new EventSource('/api/runs/'+runId+'/stream')`. Same rendering (reset/start/tool/
  result/stderr/text/done line formatting).
- **Watch live:** each task with an active run (`agent_phase` in
  `diagnosing`/`executing`, or a running reply) shows a "Watch" control that resolves
  the task's current run via `/api/runs/active` (or `/api/tasks/:id/runs`) and opens
  the console.
- **Reopen past runs:** a "Runs" disclosure on the task lists recent runs
  (kind · status · cost · time) from `/api/tasks/:id/runs`; clicking one opens its
  persisted trace.
- **Activity indicator:** a lightweight affordance fed by `/api/runs/active` showing
  what's running now.
- Manual ingest/digest buttons: after triggering, resolve the run's `runId` from
  `/api/runs/active` (retry briefly until the running row appears — `/api/run/:job` is
  fire-and-forget so the row is created just after) and open the console on it.

### `bin/stub-claude.js`

Unchanged in output shape (still emits stream-json lines); the trace tee and runId
keying are transparent to it. Existing integration coverage carries over.

## Data flow (reply, after)

1. `me` posts `@claude …` → `POST /api/tasks/:id/comments` → `onCommentAgent` →
   `runReply(db, id)`.
2. `runReply` builds `replyPrompt({ apiBase, db, task })` — full context.md + inlined
   thread + shared preamble.
3. `spawnAgent` creates the run, `begin(runId)` + `trace.open(runId)`, streams events
   to `runbus` **and** `data/traces/<runId>.jsonl`.
4. Agent reasons over the inlined thread (no discovery curls) and POSTs one agent
   comment; run finishes → `end(runId, status)` + `trace.close(runId)`.
5. UI: the task's "Watch" opened the console live; afterward the run stays in "Runs"
   and its trace is replayable.

## Error handling

- Trace write failures are non-fatal: `trace.append` swallows errors (a dead trace
  file must never break a run or its live stream), mirroring `runbus`'s dead-subscriber
  tolerance.
- SSE on unknown/absent runId → 404; on a finished run with no trace file → replay an
  empty history + `end` (status from the run row) rather than erroring.
- `renderThread` on a missing task → empty block (dispatch/route guards already 404
  before spawning, so this is defensive only).

## Tests (`test/`)

- **runbus unit:** runId-keyed subscribe replays buffered events then streams new ones;
  `begin` resets; buffer cap holds; two run ids stay isolated.
- **trace unit:** `open`/`append`/`close` then `read` round-trips; `read` of a missing
  file → `[]`; `prune` keeps the most-recent N and deletes older.
- **agent tees:** run against the stub; assert `data/traces/<runId>.jsonl` exists with
  a `start` and `done`/`end`, and `runbus` saw the same; cost metrics still recorded.
- **routes:** `/api/runs/:runId/stream` for an active run streams live frames and ends;
  for a finished run replays the file then ends; unknown runId → 404.
  `/api/runs/active` and `/api/tasks/:id/runs` return the expected rows.
- **prompts:** `replyPrompt` includes the rendered thread and full context.md, and does
  **not** contain the old "fetch the task and its comment thread" discovery step;
  `AGENT_RULES` appears in ingest/reply/digest prompts; `renderThread` formatting.
- Existing ingest/digest/reply/dispatch tests migrated to the runId flow stay green.

## Out of scope (stay as roadmap items)

- Adaptive cadence and model-tiering rollout (Phase 0 remainder).
- New agent modes / auto-detect repo (Phase 2).
- Raw-firehose (untruncated) trace detail — traces stay curated.

## Related doc work (separate commit, not this feature)

Fold this feature into `docs/ROADMAP.md` as its own entry, and make the
earlier-agreed roadmap edits (per-phase done-criteria + a baseline cost target).
