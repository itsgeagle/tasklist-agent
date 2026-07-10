# tasklist-agent — improvement roadmap

Living backlog of ideas to make the dashboard more useful, versatile, and cost-aware.
Guiding constraint: **all intelligence runs through headless `claude -p` on the
subscription (never the paid API), so token/compute burn is a first-class concern.**
Build one phase at a time; each phase gets its own spec → plan → implementation.

Status legend: `todo` · `in design` · `building` · `done` · `parked`

_Last updated: 2026-07-10_

**Cost baseline:** ~$3/day at ~20 runs/day (measured 2026-07-10 via `/api/usage/history`).
Target: hold under ~$2/day as later phases add agents, by leaning on the quiet-skip
and actually applying model tiering. Re-measure whenever a phase adds a new run kind.

---

## Phase 0 — See the burn before you grow it  ·  _nearly done_

Foundation. The ingest loop (~48 runs/day, multi-minute full-Slack scans) is the
dominant token cost, and today's `/api/usage` meter doesn't even count it. Get
visibility and cheap controls in place so every later phase is added against a
budget you can actually watch.

_Done when:_ per-run cost is visible for every run kind, quiet ticks are skipped,
triage runs on a cheaper model than agent code work, and daily spend is under target.

- **Real cost accounting** — `done`. `agent.js` parses `total_cost_usd` + `usage`
  token counts from the final `result` stream-json event, falls back to a notional
  `estimateCost()` (labelled "est.") when the subscription omits cost, and persists
  per run. `/api/usage` reports truthfully across all kinds (ingest/digest/reply +
  diagnose/execute), surfaced as a UI meter and budget banner.
- **Skip ingest when Slack is quiet** — `done`. `slack.js#hasNewSince` is an
  LLM-free probe (one `conversations.history` call per channel, early-exit, fail-open)
  that no-ops the run when nothing is new since the high-water-mark; the run shows
  "skipped (quiet)" rather than looking dead. A full LLM sweep is forced at least
  every 3h (`INGEST_MAX_QUIET_MS`) and on the manual **Pull Slack** trigger.
- **Model tiering** — `building`. The *mechanism* ships: per-job model overrides
  (`MODEL_INGEST/DIGEST/REPLY/DIAGNOSE/EXECUTE`), applied only when non-empty. But the
  default is empty (inherit the CLI default), so nothing is actually tiered yet —
  the decision to run Haiku on ingest/digest triage and reserve Opus for
  diagnose/execute/reply still needs to be made and set. Rate table in `config.js`
  backs cost estimation.
- **Adaptive cadence** — `todo` _(only remaining Phase 0 item)_. Cron is currently
  fixed (ingest `*/30`, digest `0 8`). Back off overnight/weekends, tighten during
  work hours. Compose with the quiet-skip so a backed-off tick that finds new
  messages still runs.

## Phase 0.5 — Run observability + lean context  ·  _done_

Every run is now a first-class, addressable object you can watch live and reopen later,
and the reply/diagnose prompts stop paying agent turns to re-fetch context the server
already holds. Spec + plan: `docs/superpowers/*/2026-07-10-run-observability-lean-context*`.

_Done when:_ any task's agent run can be watched live from the board and any finished
run's trace reopened after a restart; replies no longer curl for their own thread.

- **runId-keyed runs** — `done`. `runbus` streams key by `runId` (not kind), so
  concurrent per-task agents no longer collide and a specific run is addressable.
- **Durable traces** — `done`. Each run's events are teed to `data/traces/<runId>.jsonl`
  (retention: most-recent 500), so a finished/pre-restart run replays on demand.
- **Universal live console** — `done`. One `runId`-driven SSE endpoint + console:
  "Watch" any active task run, reopen past runs from a per-task "Runs" list, and a
  header activity indicator shows what's running now.
- **Lean context** — `done`. The server inlines a rendered task+thread into the
  reply/diagnose prompts (zero discovery curls), and a shared `AGENT_RULES` preamble
  replaces the boilerplate duplicated across every prompt.

## Phase 1 — GitHub CI-check loop  ·  _todo_

Flesh out the agentic state machine. Today `dispatch.js` runs
`diagnosing → awaiting_approval → executing → done/failed`; execute opens a **draft**
PR (`gh pr create --draft --fill`) and stops. This phase adds what happens after.

_Done when:_ a draft PR's checks are watched to green (with a bounded auto-fix on red)
and the PR is flipped ready-for-review without human babysitting.

- New `verifying` phase after the draft PR opens: watch `gh pr checks`.
- Bounded auto-fix pass on red checks (e.g. max 1–2 retries), then surface to human.
- Mark the PR ready-for-review when checks go green.
- Address-PR-review-comments mode (push fixes for reviewer comments).

## Phase 2 — More agent modes  ·  _todo_

Drop-in additions to `agent-modes.js`. Today there is exactly one mode (`code`);
`dispatch.js` is already generic over `MODES`, so new modes are mostly prompt +
tool-profile definitions.

_Done when:_ at least the read-only `investigate` and `draft-reply` modes are
dispatchable from the board and the repo is inferred from task content.

- `review` — read-only review of a PR → posts findings as comments.
- `investigate` — research/answer a question, no code changes (cheap).
- `draft-reply` — agent drafts a Slack reply → you approve in the UI → it posts
  back to Slack. High value for an eng lead.
- Auto-detect the relevant repo from task content instead of manual selection.

## Phase 3 — Dashboard UX  ·  _todo_

Make the board genuinely pleasant to live in (`public/index.html`).

_Done when:_ the board supports filter/search + a "waiting on me" view and a cost
trend panel, and surfaces a notification when a P1 lands or an agent needs approval.

- PR check-status badges (passing/failing/pending) on task cards.
- "Waiting on me" vs "waiting on others" distinction.
- Filter / search / grouping; snooze / defer; due dates.
- **Cost panel** — daily $ spend + trend. _(The Phase 0 meter + budget banner exist;
  this is the richer trend/history view.)_
- Keyboard-driven triage.
- Notifications — desktop / Discord ping when a P1 lands or an agent needs approval.

## Phase 4 — More sources  ·  _todo_

Currently Slack-only for ingest (Discord is output-only; GitHub is just `gh` in prompts).

_Done when:_ GitHub review-requests + assigned issues flow into tasks alongside Slack,
without blowing the cost target.

- GitHub review-requests + assigned issues → tasks.
- Weekly-review digest; on-demand digest trigger. _(Daily digest at 08:00 + a manual
  digest trigger already ship; this is the weekly rollup.)_
- (Further out) real Discord ingestion — needs polling/webhook infra that doesn't exist yet.

---

## Parked / smaller ideas

- Learn the relevance filter: when tasks are dismissed/deleted, periodically suggest
  edits to `context.md` (watch token cost of doing this).
- Task dependencies / linking.
- Reminders / nudges for stale "waiting on others" tasks (agent drafts the nudge).
