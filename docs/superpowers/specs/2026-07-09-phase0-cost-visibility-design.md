# Phase 0 — Cost visibility + controls

Status: approved, ready for planning
Date: 2026-07-09
Roadmap: see `docs/ROADMAP.md` (Phase 0)

## Goal

The ingest loop (~48 runs/day, multi-minute full-Slack scans via `claude -p`) is the
dominant compute cost, and today's `/api/usage` meter counts only `diagnose`/`execute`
runs — so it understates real burn and hides the biggest consumer. Before adding more
always-on agentic machinery (Phases 1–4), get honest cost visibility and cheap,
reversible controls in place so every later feature is added against a budget you can
watch.

Non-goals for this phase: the richer cost dashboard/panel (Phase 3), new agent modes
(Phase 2), the CI-check loop (Phase 1). Phase 0 makes the number honest and adds two
low-risk savings levers.

## Constraints (unchanged, load-bearing)

- All intelligence runs through headless `claude -p` on the **subscription**, never the
  paid Anthropic API. `agent.js` strips every `ANTHROPIC_*` var from the child; keep it.
- Additive only: no data migration ceremony, no behavior change unless explicitly
  configured. Every new lever defaults to today's behavior.

## Approved decisions

1. **Model tiering** = per-job config knob, defaulting to current (unpinned) behavior.
   Reversible; lets the user measure the cost/quality tradeoff before committing.
2. **Skip-ingest-when-quiet** = cheap JS pre-check skips the `claude` spawn when Slack
   has nothing new, but a full run is forced every N hours so the PR-merge sweep and
   edge cases stay honest.
3. **Budget behavior** = track tokens + notional $, display the daily total, and show a
   dismissable warning banner when over a configurable `DAILY_BUDGET`. Scheduled jobs
   keep running (visibility, not enforcement); on-demand work is never blocked.

---

## Component 1 — Cost accounting

### What the runtime emits

The real `claude -p --output-format stream-json --verbose` emits a final event:

```json
{ "type": "result", "subtype": "success", "is_error": false, "num_turns": N,
  "duration_ms": M, "total_cost_usd": 0.0123,
  "usage": { "input_tokens": ..., "output_tokens": ...,
             "cache_read_input_tokens": ..., "cache_creation_input_tokens": ... },
  "result": "..." }
```

**Tokens are ground truth** (always present). **`total_cost_usd` is notional** on a
subscription — the API-equivalent price, not a real charge — and may be absent. So:

- Persist token counts verbatim.
- Persist `total_cost_usd` when present; otherwise estimate `$` from tokens using a
  small static per-model rate table (`config.js`), and flag it as estimated.
- The UI always labels the dollar figure "est." to avoid implying real billing.

### Capture (`src/agent.js`)

The stdout line parser already parses each `result` line (`toEvents`). Capture the raw
result object into a `metrics` variable in the parse loop (when `obj.type === 'result'`):
`{ cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
num_turns, duration_ms, model }` (model comes from the earlier `system/init` event).
Pass `metrics` to `finishRun` in `finish()`. Do not change the live event stream.

### Schema (`src/store.js`)

Extend the `runs` table using the existing additive column loop (mirror `store.js:49-56`
for `tasks`). New nullable columns:

- `cost_usd REAL`
- `cost_estimated INTEGER` (0/1 — was `$` derived from tokens?)
- `input_tokens INTEGER`, `output_tokens INTEGER`
- `cache_read_tokens INTEGER`, `cache_write_tokens INTEGER`
- `num_turns INTEGER`, `duration_ms INTEGER`
- `model TEXT`

`finishRun(db, id, status, log, metrics = {})` — write the metric columns alongside
status/log/finished_at. Existing callers that pass no metrics keep working.

### Aggregation (`src/store.js`)

- `usageToday(db)` → `{ by_kind: { <kind>: { runs, cost_usd, cost_estimated,
  input_tokens, output_tokens, ... } }, total: {...}, active }`. Counts **all** kinds
  (`ingest`, `digest`, `reply`, `diagnose`, `execute`), where `date(started_at) =
  date('now')`. `active` counts currently-`running` agent runs (as today).
- `usageByDay(db, days = 14)` → array of `{ date, cost_usd, cost_estimated,
  input_tokens, output_tokens, runs }` for the trend, oldest→newest.

Keep `agentRunsToday`/`activeAgentRuns` (still used by dispatch's concurrency gate).

### API (`src/routes.js`)

- Expand `GET /api/usage` → `{ today: usageToday(), budget: { daily_usd, over },
  active, cap }`. `over` = today's total `cost_usd` > `DAILY_BUDGET` (when set).
- Add `GET /api/usage/history?days=14` → `usageByDay(days)` (clamp days to a sane max).

### Config (`src/config.js`, `.env.example`)

- `DAILY_BUDGET` (USD notional; unset/`0` = no banner).
- `MODEL_RATES` — a static in-code table mapping known model ids → `{ input, output }`
  $/Mtok for the token→$ fallback. Not env-configurable in Phase 0; documented inline.

### UI (`public/index.html`)

- Top-bar meter: replace the diagnose/execute-only counter with today's total tokens +
  est. $ (and keep `active/cap`). Small and honest — the full panel is Phase 3.
- Dismissable banner (reuse the existing ingest-fail banner pattern) when
  `usage.budget.over` is true: "Today's est. spend $X exceeds your $Y budget." Dismiss
  is client-side only; it reappears on reload if still over. Scheduled jobs are **not**
  paused.

### Stub + tests

- `bin/stub-claude.js`: emit `total_cost_usd`, `usage`, `duration_ms` in `result()` so
  tests exercise the capture path. Keep values small and deterministic.
- Tests: metric capture → stored on the run; `usageToday` sums across all kinds;
  `/api/usage` reflects a run's tokens/$; token→$ fallback when `total_cost_usd` absent
  sets `cost_estimated = 1`; `/api/usage/history` shape.

---

## Component 2 — Skip-ingest-when-quiet

### New module `src/slack.js`

A minimal plain-`fetch` Slack client (no LLM). Testable via an injectable base URL
(default `https://slack.com/api`) and token (default `config.SLACK_USER_TOKEN`).

- `hasNewSince(hwm, { baseUrl, token } = {})` → `boolean`.
  - No `hwm` (never ingested) → return `true` (let the full bootstrap run).
  - `GET users.conversations?types=public_channel,private_channel,im,mpim&limit=200`.
  - For each conversation id: `GET conversations.history?channel=C&oldest=hwm&limit=1`.
    **Early-exit `true`** on the first conversation that returns ≥1 message.
  - All conversations empty → `false`.
  - On any Slack API error, return `true` (fail open — never silently skip because Slack
    was unreachable; the full run will surface the real error).

### `src/cron.js` — `runIngest`

Before spawning the agent (inside the existing `ingest` lock):

1. `hwm = getMeta(db, 'ingest_hwm')`.
2. `lastFull = getMeta(db, 'ingest_last_full')` (epoch ms; null if never).
3. `stale = !lastFull || (now - lastFull) >= INGEST_MAX_QUIET_MS`.
   - `now` from `Date.now()`.
4. If `!stale` and `hasNewSince(hwm) === false`:
   - Record a lightweight run row `kind:'ingest', status:'skipped'` with zero metrics
     (so `latestRun('ingest')` and the UI show "skipped (quiet)", not a dead loop).
   - Release lock, return. **No `claude` spawn.**
5. Otherwise: run the full LLM ingest as today; on completion set
   `ingest_last_full = now`.

`store.js` gets a small helper to insert a terminal `skipped` run (or reuse
`createRun` + `finishRun(status:'skipped')`). `skipped` runs are excluded from cost
totals (they have none) but visible in status.

### Config

- `INGEST_MAX_QUIET_MS` (default `10800000` = 3h).

### Tests

- Stub `slack.js` (inject base URL to a local fake, or stub the module) so no real Slack
  is hit. Cases: quiet + fresh → no spawn + `skipped` run recorded; quiet + stale
  (`lastFull` older than max) → full run happens; new messages present → full run;
  Slack error → full run (fail open). Assert the `claude` spawn count via the existing
  stub/spawn seam.

---

## Component 3 — Model tiering (per-job knob)

### `src/agent.js`

`spawnAgent(db, { ..., model } = {})` → when `model` is a non-empty string, append
`--model`, `model` to `agentArgs`. When unset, argv is byte-for-byte what it is today
(preserves current behavior and all existing tests).

### `src/config.js`, `.env.example`

`MODEL_INGEST`, `MODEL_DIGEST`, `MODEL_REPLY`, `MODEL_DIAGNOSE`, `MODEL_EXECUTE` — all
default unset. Documented in `.env.example` with the note that unset = subscription
default, and that downgrading `ingest` risks relevance-judging quality (measure via the
new cost meter before/after).

### Wiring

- `cron.js`: `runIngest` passes `model: config.MODEL_INGEST`; `runDigest` passes
  `MODEL_DIGEST`; `runReply` passes `MODEL_REPLY`.
- `dispatch.js`: diagnose spawn passes `MODEL_DIAGNOSE`; execute spawn passes
  `MODEL_EXECUTE`.

### Tests

- With `model` set, `spawnAgent` argv includes `--model <x>`; with it unset, argv is
  unchanged (assert the flag is absent).

---

## Files touched

| File | Change |
|------|--------|
| `src/agent.js` | Capture result metrics → `finishRun`; `--model` passthrough |
| `src/store.js` | `runs` metric columns; `finishRun(metrics)`; `usageToday`/`usageByDay`; skipped-run helper |
| `src/cron.js` | Quiet pre-check + forced-full cadence + per-job model |
| `src/slack.js` | **new** — `hasNewSince(hwm)` plain-fetch Slack client |
| `src/config.js` | `DAILY_BUDGET`, `INGEST_MAX_QUIET_MS`, `MODEL_*`, `MODEL_RATES` |
| `src/dispatch.js` | Pass `MODEL_DIAGNOSE`/`MODEL_EXECUTE` |
| `src/routes.js` | Expand `/api/usage`; add `/api/usage/history` |
| `public/index.html` | Honest tokens/$ meter + over-budget banner |
| `bin/stub-claude.js` | Emit `total_cost_usd` + `usage` in result event |
| `.env.example` | Document new env vars |
| `test/*` | Cost capture/aggregation, skip-when-quiet, model passthrough |

## Risks & mitigations

- **`total_cost_usd` absent on subscription** → tokens are the source of truth; $ falls
  back to a token×rate estimate flagged `cost_estimated`. Feature stands either way.
- **Skip-when-quiet skips the PR-merge sweep** → forced full run every
  `INGEST_MAX_QUIET_MS` bounds staleness; sweep still runs regularly.
- **Slack pre-check adds per-conversation calls** → free Slack API, `limit=1`,
  early-exit on first hit; fail-open on error so we never skip due to a Slack outage.
- **Cheaper ingest model degrades relevance judging** → opt-in only, off by default; the
  new cost meter lets the user A/B it deliberately.
- **Cost meter now counts ingest** → the number will look higher than the old meter.
  This is the point (the old one lied); document it so it isn't read as a regression.
