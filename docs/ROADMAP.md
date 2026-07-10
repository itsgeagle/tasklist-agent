# tasklist-agent — improvement roadmap

Living backlog of ideas to make the dashboard more useful, versatile, and cost-aware.
Guiding constraint: **all intelligence runs through headless `claude -p` on the
subscription (never the paid API), so token/compute burn is a first-class concern.**
Build one phase at a time; each phase gets its own spec → plan → implementation.

Status legend: `todo` · `in design` · `building` · `done` · `parked`

---

## Phase 0 — See the burn before you grow it  ·  _in design_

Foundation. The ingest loop (~48 runs/day, multi-minute full-Slack scans) is the
dominant token cost, and today's `/api/usage` meter doesn't even count it. Get
visibility and cheap controls in place so every later phase is added against a
budget you can actually watch.

- **Real cost accounting** — parse the `total_cost_usd` / `usage` (token counts)
  fields from `claude -p`'s final `result` stream-json event; persist per run;
  include ingest/digest/reply, not just diagnose/execute. Fix the under-counting meter.
- **Skip ingest when Slack is quiet** — cheap JS pre-check (Slack message counts
  since the high-water-mark, no LLM spawn) that no-ops the run when nothing is new.
  Likely the single biggest saving.
- **Model tiering** — cheaper model (e.g. Haiku) for ingest/digest triage, stronger
  (Opus) reserved for agent code work (diagnose/execute) and `@claude` replies.
- **(stretch) Adaptive cadence** — back off overnight/weekends, tighten during work hours.

## Phase 1 — GitHub CI-check loop  ·  _todo_

Flesh out the agentic state machine (`dispatch.js` / `agent-modes.js`).

- New `verifying` phase after the draft PR opens: watch `gh pr checks`.
- Bounded auto-fix pass on red checks (e.g. max 1–2 retries), then surface to human.
- Mark the PR ready-for-review when checks go green.
- Address-PR-review-comments mode (push fixes for reviewer comments).

## Phase 2 — More agent modes  ·  _todo_

Drop-in additions to `agent-modes.js` (dispatch.js is already generic over mode).

- `review` — read-only review of a PR → posts findings as comments.
- `investigate` — research/answer a question, no code changes (cheap).
- `draft-reply` — agent drafts a Slack reply → you approve in the UI → it posts
  back to Slack. High value for an eng lead.
- Auto-detect the relevant repo from task content instead of manual selection.

## Phase 3 — Dashboard UX  ·  _todo_

Make the board genuinely pleasant to live in (`public/index.html`).

- PR check-status badges (passing/failing/pending) on task cards.
- "Waiting on me" vs "waiting on others" distinction.
- Filter / search / grouping; snooze / defer; due dates.
- **Cost panel** — daily $ spend + trend, powered by Phase 0 accounting.
- Keyboard-driven triage.
- Notifications — desktop / Discord ping when a P1 lands or an agent needs approval.

## Phase 4 — More sources  ·  _todo_

Currently Slack-only for ingest (Discord is output-only; GitHub is just `gh` in prompts).

- GitHub review-requests + assigned issues → tasks.
- Weekly-review digest; on-demand digest trigger.
- (Further out) real Discord ingestion — needs polling/webhook infra that doesn't exist yet.

---

## Parked / smaller ideas

- Learn the relevance filter: when tasks are dismissed/deleted, periodically suggest
  edits to `context.md` (watch token cost of doing this).
- Task dependencies / linking.
- Reminders / nudges for stale "waiting on others" tasks (agent drafts the nudge).
