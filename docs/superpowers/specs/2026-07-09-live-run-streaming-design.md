# Live run streaming (SSE console) — design

**Date:** 2026-07-09
**Status:** approved (design)

## Problem

Triggering an ingest/digest is a black box: `claude -p … --output-format json` emits
one JSON blob only at the very end, so until a run finishes (or times out) there's no
signal about whether it connected to Slack, what it's doing, or why it's stuck. The
23:04 ingest failure — a 5-minute timeout with zero output — is the motivating case.

Give each manual run a **live trace** in the browser: started → each tool call →
each result → done.

## Approach

Switch runs to `--output-format stream-json --verbose` (newline-delimited events as
they happen), fan those events out over **Server-Sent Events** to a console panel in
the page. Chosen over polling for zero-latency "is it even connecting" feedback; SSE
needs no new deps (plain `EventSource`).

Server run-logic is unaffected: task creation is done by the agent's own curls, and
run status still comes from the child's exit code — nothing parses the JSON result.
So the output-format switch is low-risk.

## Components

### `src/runbus.js` (new) — in-memory pub/sub keyed by stream key

Stream key = `ingest` / `digest` for those kinds, `reply:<taskId>` for replies (so
concurrent replies don't interleave; console only subscribes to ingest/digest for now).

- `begin(key, runId)` — reset the key's buffer, push `{t:'reset'}` to live subscribers.
- `publish(key, event)` — append to buffer (capped at 500; oldest dropped) + notify subs.
- `end(key, status)` — push `{t:'end', status}` so the SSE endpoint can close.
- `subscribe(key, cb)` — replay current buffer to `cb`, then stream; returns unsubscribe.

Bounded buffer keeps a late-opening console able to replay from the run's start
without unbounded memory. State is per-process (fine: single always-on server).

### `src/agent.js` — stream-json + parse + publish

- Spawn args become `['-p', prompt, '--output-format', 'stream-json', '--verbose',
  '--allowedTools', ...tools]`.
- `begin(key, runId)` after `createRun`; `end(key, status)` in `finish()`.
- stdout: still accumulate raw for `finishRun`, AND split into lines (buffering the
  partial trailing line). Each complete line → `JSON.parse` → `toEvent()` →
  `runbus.publish(key, ev)`. Unparseable lines are ignored (raw still saved).
- `toEvent(obj)` maps claude stream events to `{ t, text, ok? }`:
  - `system/init` → `{t:'start', text:'started · <model>'}`
  - `assistant` content `text` → `{t:'text', text}`
  - `assistant` content `tool_use` → `{t:'tool', text:'<name>: <summary>'}`
    (Bash → the command; else JSON of input; truncated ~200 chars)
  - `user` `tool_result` → `{t:'result', text:<first line, ~200>, ok:!is_error}`
  - `result` → `{t:'done', text:'done — ok|error · N turns'}`
- stderr lines → `{t:'stderr', text}` (surfaces the "no stdin" warning etc.).

### `src/routes.js` — SSE endpoint

`GET /api/runs/:kind/stream`, kind ∈ {ingest, digest}:
- `text/event-stream`, no-cache; `res.write('data: ' + JSON.stringify(ev) + '\n\n')`.
- Subscribe to runbus for the kind; on `{t:'end'}` flush + `res.end()`.
- 15s heartbeat comment (`: hb`) to keep the connection alive.
- Clean up (clear heartbeat, unsubscribe, end) on `req` `close`.
- Unknown kind → 400.

### `public/index.html` — console panel

- Collapsible panel under the banner: title + Close, and a scrollable `<pre>`.
- `runJob(job, btn)` (existing) also calls `openConsole(job)`.
- `openConsole(kind)`: show panel, set title, close any prior `EventSource`, open
  `new EventSource('/api/runs/'+kind+'/stream')`. On message: `reset` clears; `end`
  marks `■ done (<status>)` and closes; others append a formatted line and autoscroll.
- Line prefixes: start/tool `▸`, result `   →`, stderr `⚠`, text plain, done `■`.

### `bin/stub-claude.js` — emit stream-json

Wrap the existing keyword-driven side effects, but emit a few stream-json lines
(`system/init`, an `assistant` `tool_use`, a `result`) to stdout instead of one JSON
blob, so `agent.js`'s parser and the existing ingest/digest/reply tests stay green.
A small `emit(obj)` helper writes `JSON.stringify(obj) + '\n'`.

## Tests (`test/`)

- **runbus unit:** subscribe replays buffered events then receives new ones;
  `begin` resets; buffer cap holds.
- **agent publishes:** run `runIngest` against the stub; assert `runbus` for `ingest`
  saw a `start` and an `end`, and at least one `tool`/`result`/`done`.
- **SSE smoke:** GET `/api/runs/ingest/stream` returns `text/event-stream` and streams
  at least one `data:` frame during a stubbed run; `/api/runs/bogus/stream` → 400.
- Existing ingest/digest/reply tests must remain green with the new stub output.

## Out of scope
- Streaming reply runs into task threads (they already surface via comments).
- Persisting the trace across restarts (buffer is in-memory by design).

## Related cleanup (separate commit, not this feature)
The pf redirect broke direct `:8787`, which caused the ingest failure and affects
other spots. Persist `TASKLIST_API=http://tasklist` in `setup.sh`/`.env.example`, fix
`update.sh`'s health check (it probes `:8787` directly), and correct the README
`tasklist:8787` fallback note.
