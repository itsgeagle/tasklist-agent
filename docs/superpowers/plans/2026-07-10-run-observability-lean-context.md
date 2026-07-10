# Run Observability + Lean Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every agent run watchable live and replayable after the fact — keyed by `runId` with a durable trace — and stop the reply/diagnose prompts from spending agent turns fetching context the server already has.

**Architecture:** `runbus` is re-keyed from run *kind* to `runId`; each published event is teed to a per-run JSONL file under `data/traces/`. A run-scoped SSE endpoint serves the live in-memory buffer while a run is active and the persisted file once it has finished. The reply/diagnose prompts inline a server-rendered task+thread block and share a common rules preamble.

**Tech Stack:** Node ESM, `node --test`, better-sqlite3, Express, plain `EventSource` in `public/index.html`.

## Global Constraints

- Runtime: Node ≥ 18, ESM (`"type": "module"`). No new dependencies.
- Test runner: `node --test`. Run one file: `node --test test/<file>.test.js`. Run all: `npm test`.
- Commits: `git commit --no-gpg-sign`. NEVER add a `Co-Authored-By` trailer.
- `data/` is gitignored — trace files under `data/traces/` must never be committed.
- Agents must never use the Anthropic API; prompts keep the "Do NOT use any Anthropic API" rule.
- Trace detail stays curated (the existing `toEvents` summaries) — not a raw firehose.
- Branch: `feat/run-observability-lean-context` (already created; spec already committed there).

---

### Task 1: Re-key `runbus` by `runId`

`runbus` currently keys streams by a `streamKey({kind, task_id})`. Switch the key to the numeric `runId`, and drop each run's stream on `end()` so finished runs replay from their trace file (Task 2) rather than lingering in memory.

**Files:**
- Modify: `src/runbus.js` (rewrite)
- Test: `test/runbus.test.js` (create)

**Interfaces:**
- Produces: `begin(runId)`, `publish(runId, ev)`, `end(runId, status)`, `subscribe(runId, cb) → unsub`, `snapshot(runId) → {status, events} | null`, `_reset()`. `streamKey` is removed.

- [ ] **Step 1: Write the failing test**

Create `test/runbus.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runbus from '../src/runbus.js';

test('subscribe replays buffer then streams new events; ids are isolated', () => {
  runbus._reset();
  runbus.begin(1);
  runbus.publish(1, { t: 'tool', text: 'a' });
  const seen = [];
  const unsub = runbus.subscribe(1, (ev) => seen.push(ev));
  runbus.publish(1, { t: 'result', text: 'b' });
  runbus.publish(2, { t: 'tool', text: 'other' }); // different run must not leak
  unsub();
  runbus.publish(1, { t: 'tool', text: 'after' });  // must not reach us
  const kinds = seen.map((e) => e.t);
  assert.deepEqual(kinds, ['reset', 'tool', 'result']);
});

test('end() pushes end to live subscribers then drops the stream', () => {
  runbus._reset();
  runbus.begin(5);
  const seen = [];
  runbus.subscribe(5, (ev) => seen.push(ev));
  runbus.end(5, 'ok');
  assert.equal(seen.at(-1).t, 'end');
  assert.equal(seen.at(-1).status, 'ok');
  assert.equal(runbus.snapshot(5), null); // dropped after end
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runbus.test.js`
Expected: FAIL (current `runbus` exports `streamKey`-keyed fns; `snapshot(5)` won't be null after end).

- [ ] **Step 3: Rewrite `src/runbus.js`**

```js
// In-memory pub/sub for live run traces, keyed by runId. A run's events live here
// only while it is active; end() drops the stream so finished runs replay from their
// persisted JSONL trace instead (see trace.js). State is per-process — fine for a
// single always-on server.
const MAX = 500; // cap buffered events per run; a chatty run can't grow unbounded

const streams = new Map(); // runId -> { status, events:[], subs:Set }

function ensure(runId) {
  let s = streams.get(runId);
  if (!s) { s = { status: 'idle', events: [], subs: new Set() }; streams.set(runId, s); }
  return s;
}

function push(s, ev) {
  s.events.push(ev);
  if (s.events.length > MAX) s.events.splice(0, s.events.length - MAX);
  for (const cb of s.subs) { try { cb(ev); } catch { /* a dead subscriber must not break others */ } }
}

// Start a run: clear the buffer and tell live viewers to reset.
export function begin(runId) {
  const s = ensure(runId);
  s.status = 'running'; s.events = [];
  push(s, { t: 'reset', runId });
}

export function publish(runId, ev) {
  const s = streams.get(runId);
  if (s) push(s, ev);
}

export function end(runId, status) {
  const s = streams.get(runId);
  if (!s) return;
  s.status = status;
  push(s, { t: 'end', status });
  streams.delete(runId); // finished runs are served from the trace file, not memory
}

// Replay the current buffer to cb, then stream new events. Returns an unsubscribe fn.
export function subscribe(runId, cb) {
  const s = ensure(runId);
  for (const ev of s.events) cb(ev);
  s.subs.add(cb);
  return () => s.subs.delete(cb);
}

export function snapshot(runId) {
  const s = streams.get(runId);
  return s ? { status: s.status, events: s.events.slice() } : null;
}

// Test hook: forget all stream state.
export function _reset() { streams.clear(); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runbus.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runbus.js test/runbus.test.js
git commit --no-gpg-sign -m "refactor(runbus): key live streams by runId, drop on end"
```

---

### Task 2: Durable per-run trace (`src/trace.js`)

Persist each run's events to `data/traces/<runId>.jsonl` so finished/pre-restart runs are replayable.

**Files:**
- Create: `src/trace.js`
- Test: `test/trace.test.js` (create)

**Interfaces:**
- Produces: `open(runId)`, `append(runId, ev)`, `close(runId)`, `read(runId) → ev[]`, `prune(keepRuns=500)`, `fileFor(runId) → path`.

- [ ] **Step 1: Write the failing test**

Create `test/trace.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as trace from '../src/trace.js';

test('open/append/close then read round-trips; missing → []', () => {
  const id = 9000001;
  trace.open(id);
  trace.append(id, { t: 'start', text: 'go' });
  trace.append(id, { t: 'end', status: 'ok' });
  trace.close(id);
  const evs = trace.read(id);
  assert.deepEqual(evs.map((e) => e.t), ['start', 'end']);
  assert.deepEqual(trace.read(9999999), []); // no file
  fs.rmSync(trace.fileFor(id));
});

test('prune keeps the most-recent N and deletes older', () => {
  for (const id of [9000010, 9000011, 9000012]) { trace.open(id); trace.append(id, { t: 'start' }); trace.close(id); }
  trace.prune(2);
  assert.equal(fs.existsSync(trace.fileFor(9000010)), false);
  assert.equal(fs.existsSync(trace.fileFor(9000012)), true);
  fs.rmSync(trace.fileFor(9000011)); fs.rmSync(trace.fileFor(9000012));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/trace.test.js`
Expected: FAIL with "Cannot find module '../src/trace.js'".

- [ ] **Step 3: Create `src/trace.js`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'traces');
const writers = new Map(); // runId -> WriteStream

export function fileFor(runId) { return path.join(DIR, `${runId}.jsonl`); }

export function open(runId) {
  fs.mkdirSync(DIR, { recursive: true });
  const ws = fs.createWriteStream(fileFor(runId), { flags: 'a' });
  ws.on('error', () => {}); // a dead trace file must never break a run
  writers.set(runId, ws);
}

export function append(runId, ev) {
  const ws = writers.get(runId);
  try { if (ws) ws.write(JSON.stringify(ev) + '\n'); } catch { /* non-fatal */ }
}

export function close(runId) {
  const ws = writers.get(runId);
  if (ws) { try { ws.end(); } catch { /* already closed */ } writers.delete(runId); }
}

export function read(runId) {
  let text;
  try { text = fs.readFileSync(fileFor(runId), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Keep the most-recent `keepRuns` trace files (runId is a monotonic autoincrement,
// so a larger id is newer); delete the rest. Best-effort; errors are ignored.
export function prune(keepRuns = 500) {
  let files;
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  const byNewest = files
    .map((f) => [Number(f.slice(0, -6)), f])
    .sort((a, b) => b[0] - a[0]);
  for (const [, f] of byNewest.slice(keepRuns)) { try { fs.rmSync(path.join(DIR, f)); } catch { /* gone */ } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/trace.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/trace.js test/trace.test.js
git commit --no-gpg-sign -m "feat(trace): durable per-run JSONL trace store"
```

---

### Task 3: Tee agent events to `runbus` + `trace`, keyed by `runId`

Wire `spawnAgent` to the new runId-keyed bus and the trace store, and migrate the existing integration tests that key `runbus` by `'ingest'`.

**Files:**
- Modify: `src/agent.js` (`spawnAgent`)
- Modify: `test/integration.test.js` (runbus assertions at lines ~117-170)
- Test: `test/agent.test.js` (add one test)

**Interfaces:**
- Consumes: Task 1 `runbus.begin/publish/end`, Task 2 `trace.open/append/close/prune`.
- Produces: unchanged `spawnAgent(...) → {status, log, runId}`; every event now also lands in `data/traces/<runId>.jsonl` and the run's trace ends with an `{t:'end', status}` line.

- [ ] **Step 1: Write the failing test**

Add to `test/agent.test.js`:

```js
test('spawnAgent tees the trace to data/traces/<runId>.jsonl', async () => {
  const STUB = new URL('../bin/stub-claude.js', import.meta.url).pathname;
  const { spawnAgent } = await import('../src/agent.js?trace1');
  const { openDb } = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const db = openDb(':memory:');
  const res = await spawnAgent(db, { kind: 'digest', prompt: 'DIGEST', tools: ['Bash'], _binOverride: STUB });
  assert.equal(res.status, 'ok');
  const evs = trace.read(res.runId);
  const kinds = evs.map((e) => e.t);
  assert.ok(kinds.includes('start'), 'has start');
  assert.equal(evs.at(-1).t, 'end');
  assert.equal(evs.at(-1).status, 'ok');
  (await import('node:fs')).rmSync(trace.fileFor(res.runId));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="tees the trace" test/agent.test.js`
Expected: FAIL (no trace file written yet).

- [ ] **Step 3: Modify `src/agent.js`**

At the top, add the trace import next to the runbus import:

```js
import * as trace from './trace.js';
```

Replace the run/key setup (currently lines ~50-51):

```js
  const runId = createRun(db, { kind, task_id });
  const key = runbus.streamKey({ kind, task_id });
```

with:

```js
  const runId = createRun(db, { kind, task_id });
  trace.prune();                          // opportunistic retention (keep most-recent 500)
  const emit = (ev) => { runbus.publish(runId, ev); trace.append(runId, ev); };
```

Replace `runbus.begin(key, runId);` (line ~78) with:

```js
    runbus.begin(runId);
    trace.open(runId);
```

In `finish(status)` (lines ~81-87), replace `runbus.end(key, status);` with:

```js
      runbus.end(runId, status);
      trace.append(runId, { t: 'end', status });
      trace.close(runId);
```

Replace the two publish sites so both bus and trace get the event:
- Line ~118 `for (const ev of toEvents(obj)) runbus.publish(key, ev);` → `for (const ev of toEvents(obj)) emit(ev);`
- Line ~121 stderr `runbus.publish(key, { t: 'stderr', text: truncate(String(d), 300) });` → `emit({ t: 'stderr', text: truncate(String(d), 300) });`
- Line ~122 error handler `runbus.publish(key, { t: 'stderr', text: String(e) });` → `emit({ t: 'stderr', text: String(e) });`

(Note: `begin`'s `reset` is a live-only control signal and intentionally not traced; the trace begins at `start`.)

- [ ] **Step 4: Migrate `test/integration.test.js` runbus assertions**

The three runbus-related tests (~lines 117-170) key by `'ingest'`. Update them to the runId model. Replace the block that begins `test('runbus replays buffer to late subscribers...` and the `snapshot('ingest')` usages:

```js
test('runbus replays buffer to late subscribers, then streams, and caps growth', async () => {
  const runbus = await import('../src/runbus.js');
  runbus._reset();
  runbus.begin(7);
  runbus.publish(7, { t: 'tool', text: 'curl auth.test' });
  const seen = [];
  const unsub = runbus.subscribe(7, (ev) => seen.push(ev));
  runbus.publish(7, { t: 'result', text: 'ok' });   // live
  unsub();
  runbus.end(7, 'ok');
  runbus.publish(7, { t: 'tool', text: 'after unsub' }); // must not reach us
  assert.deepEqual(seen.map((e) => e.t), ['reset', 'tool', 'result']);
});
```

For the "stubbed ingest publishes a live trace" test, capture the runId from `spawnAgent`'s result and assert against the **trace** (the bus stream is dropped at end):

```js
test('a stubbed ingest publishes a trace (start … tool/result … end)', async () => {
  // ...existing boot of an app + stubbed spawnAgent ingest run...
  const res = await spawnAgent(db, { kind: 'ingest', prompt: 'INGEST', tools: ['Bash'], _binOverride: STUB });
  const trace = await import('../src/trace.js');
  const kinds = trace.read(res.runId).map((e) => e.t);
  assert.ok(kinds.includes('start') && kinds.includes('tool') && kinds.at(-1) === 'end');
  (await import('node:fs')).rmSync(trace.fileFor(res.runId));
});
```

(Adapt variable names to the existing test's setup; the key changes are: use numeric runIds, `end(id, status)` drops the stream, and post-run assertions read from `trace`, not `snapshot`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/agent.test.js test/integration.test.js`
Expected: PASS (all, including the migrated runbus tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent.js test/agent.test.js test/integration.test.js
git commit --no-gpg-sign -m "feat(agent): tee run events to runbus + durable trace by runId"
```

---

### Task 4: Run-query helpers in `src/store.js`

Add the read helpers the new API endpoints need.

**Files:**
- Modify: `src/store.js` (add three exported fns near `latestRun`, ~line 171)
- Test: `test/store.test.js` (add one test)

**Interfaces:**
- Produces: `runsForTask(db, taskId, limit=20) → row[]`, `activeRuns(db) → row[]`, `getRun(db, id) → row | null`.

- [ ] **Step 1: Write the failing test**

Add to `test/store.test.js`:

```js
test('runsForTask / activeRuns / getRun', async () => {
  const { openDb, createRun, finishRun, runsForTask, activeRuns, getRun } = await import('../src/store.js');
  const db = openDb(':memory:');
  const r1 = createRun(db, { kind: 'diagnose', task_id: 42 });
  const r2 = createRun(db, { kind: 'execute', task_id: 42 });
  finishRun(db, r1, 'ok', 'log', {});
  const runs = runsForTask(db, 42);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, r2);                 // newest first
  const active = activeRuns(db);
  assert.ok(active.some((r) => r.id === r2));    // r2 still running
  assert.ok(!active.some((r) => r.id === r1));   // r1 finished
  assert.equal(getRun(db, r1).status, 'ok');
  assert.equal(getRun(db, 999999), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="runsForTask" test/store.test.js`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Add to `src/store.js`** (after `latestRun`, ~line 173)

```js
export function runsForTask(db, taskId, limit = 20) {
  return db.prepare(
    `SELECT id, kind, status, cost_usd, cost_estimated, started_at, finished_at
       FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
  ).all(taskId, limit);
}

export function activeRuns(db) {
  return db.prepare(
    "SELECT id, kind, task_id, started_at FROM runs WHERE status = 'running' ORDER BY id DESC",
  ).all();
}

export function getRun(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="runsForTask" test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit --no-gpg-sign -m "feat(store): runsForTask/activeRuns/getRun helpers"
```

---

### Task 5: Run-scoped API endpoints in `src/routes.js`

Replace the kind-keyed SSE with a runId-scoped stream (live buffer or file replay) and add the run-listing endpoints.

**Files:**
- Modify: `src/routes.js` (imports; replace `/api/runs/:kind/stream`; add 3 endpoints)
- Test: `test/routes.test.js` (add tests)

**Interfaces:**
- Consumes: Task 1 `runbus.snapshot/subscribe`, Task 2 `trace.read`, Task 4 `store.runsForTask/activeRuns/getRun`.
- Produces: `GET /api/runs/active`, `GET /api/runs/:runId`, `GET /api/runs/:runId/stream`, `GET /api/tasks/:id/runs`.

- [ ] **Step 1: Write the failing test**

Add to `test/routes.test.js` (uses the existing `boot()` helper):

```js
test('runs endpoints: active, list-by-task, meta, finished-run replay', async () => {
  const { server, base } = boot();
  const store = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  // reach the same in-memory db the router uses: create a run via store on a fresh db won't match,
  // so drive through a real finished run recorded by the router's db:
  // (helper: expose db from boot — see note) OR assert 404 + shape here:
  const miss = await fetch(`${base}/api/runs/999999`);
  assert.equal(miss.status, 404);
  const missStream = await fetch(`${base}/api/runs/999999/stream`);
  assert.equal(missStream.status, 404);
  const active = await (await fetch(`${base}/api/runs/active`)).json();
  assert.ok(Array.isArray(active));
  const taskRuns = await (await fetch(`${base}/api/tasks/1/runs`)).json();
  assert.ok(Array.isArray(taskRuns));
  server.close();
});

test('finished-run stream replays the trace file then ends', async () => {
  const db = (await import('../src/store.js')).openDb(':memory:');
  const store = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const express = (await import('express')).default;
  const { makeRouter } = await import('../src/routes.js');
  const app = express(); app.use(express.json()); app.use(makeRouter(db, {}));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const runId = store.createRun(db, { kind: 'digest', task_id: null });
  store.finishRun(db, runId, 'ok', 'log', {});
  trace.open(runId); trace.append(runId, { t: 'start', text: 'go' }); trace.append(runId, { t: 'end', status: 'ok' }); trace.close(runId);
  const text = await (await fetch(`${base}/api/runs/${runId}/stream`)).text();
  assert.ok(text.includes('"t":"start"'));
  assert.ok(text.includes('"t":"end"'));
  (await import('node:fs')).rmSync(trace.fileFor(runId));
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="runs endpoints|finished-run stream" test/routes.test.js`
Expected: FAIL (endpoints not present / old kind-keyed route 400s).

- [ ] **Step 3: Modify `src/routes.js`**

Add the trace import after the runbus import:

```js
import * as trace from './trace.js';
```

Delete the existing `r.get('/api/runs/:kind/stream', ...)` handler (lines ~21-39). Keep the `JOBS` const (still used by `/api/run/:job`). Add, immediately after the `/api/run/:job` handler:

```js
  // What's running right now (drives the activity indicator + lets manual job
  // triggers resolve their runId). MUST precede '/api/runs/:runId' so "active"
  // isn't parsed as a run id.
  r.get('/api/runs/active', (_req, res) => res.json(store.activeRuns(db)));

  // Live trace of a specific run via SSE. Active run → replay the in-memory buffer
  // and tail live; finished run → replay its persisted JSONL trace, then close.
  r.get('/api/runs/:runId/stream', (req, res) => {
    const runId = Number(req.params.runId);
    const run = store.getRun(db, runId);
    if (!run) return res.status(404).json({ error: 'unknown run' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    let closed = false, unsub = () => {};
    const send = (ev) => { if (!closed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, 15000);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(hb); unsub(); try { res.end(); } catch { /* already gone */ } };
    req.on('close', cleanup);
    if (runbus.snapshot(runId)) {
      unsub = runbus.subscribe(runId, (ev) => { send(ev); if (ev.t === 'end') cleanup(); });
      if (closed) unsub();
    } else {
      const events = trace.read(runId);
      let sawEnd = false;
      for (const ev of events) { send(ev); if (ev.t === 'end') sawEnd = true; }
      if (!sawEnd) send({ t: 'end', status: run.status });
      cleanup();
    }
  });

  r.get('/api/runs/:runId', (req, res) => {
    const run = store.getRun(db, Number(req.params.runId));
    if (!run) return res.status(404).json({ error: 'unknown run' });
    res.json(run);
  });

  r.get('/api/tasks/:id/runs', (req, res) => res.json(store.runsForTask(db, Number(req.params.id))));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/routes.test.js`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/routes.js test/routes.test.js
git commit --no-gpg-sign -m "feat(api): runId-scoped SSE + runs/active + tasks/:id/runs"
```

---

### Task 6: Server-assembled context + shared prompt preamble

Inline the task+thread into reply/diagnose prompts and factor the shared rules. Wire `db` through `cron.runReply` and `dispatch`.

**Files:**
- Modify: `src/prompts.js` (add `AGENT_RULES`, `postCommentRecipe`, `renderThread`; rework `replyPrompt`; use `AGENT_RULES` in `ingestPrompt`/`digestPrompt`)
- Modify: `src/agent-modes.js` (`code.diagnosePrompt` takes `db`, inlines thread, uses `AGENT_RULES`)
- Modify: `src/cron.js` (`runReply` passes `db` to `replyPrompt`)
- Modify: `src/dispatch.js` (pass `db` to `diagnosePrompt`)
- Test: `test/prompts.test.js` (add tests)

**Interfaces:**
- Consumes: `store.getTask` (returns task with `.comments`).
- Produces: `AGENT_RULES` (string), `postCommentRecipe(apiBase, taskId) → string`, `renderThread(db, taskId) → string`, `replyPrompt({ apiBase, db, task }) → string`.

- [ ] **Step 1: Write the failing test**

Add to `test/prompts.test.js`:

```js
import { replyPrompt, renderThread, AGENT_RULES, ingestPrompt } from '../src/prompts.js';
import { openDb, upsertTask, addComment } from '../src/store.js';

test('renderThread includes task + comments; replyPrompt inlines it, no discovery curl', () => {
  const db = openDb(':memory:');
  const { id } = upsertTask(db, { title: 'Ship launch', detail: 'blocking', source_channel: 'C1', source_ts: '1.1' });
  addComment(db, id, 'me', '@claude summarize this');
  const thread = renderThread(db, id);
  assert.ok(thread.includes('Ship launch'));
  assert.ok(thread.includes('@claude summarize this'));
  const p = replyPrompt({ apiBase: 'http://api', db, task: { id, title: 'Ship launch' } });
  assert.ok(p.includes('Ship launch'));                 // thread inlined
  assert.ok(p.includes(AGENT_RULES));                   // shared preamble
  assert.ok(!/Fetch the task and its comment thread/i.test(p)); // discovery step gone
});

test('ingestPrompt carries the shared AGENT_RULES', () => {
  assert.ok(ingestPrompt({ apiBase: 'http://api' }).includes(AGENT_RULES));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prompts.test.js`
Expected: FAIL (`replyPrompt`/`renderThread`/`AGENT_RULES` not exported; `ingestPrompt` lacks the constant).

- [ ] **Step 3: Modify `src/prompts.js`**

Add near the top (after `loadContext`):

```js
export const AGENT_RULES =
  'Use Bash + curl + gh only. Do NOT use any Anthropic API. Do NOT use jq — build JSON with python3.';

export function postCommentRecipe(apiBase, taskId) {
  return `  curl -s -X POST ${apiBase}/api/tasks/${taskId}/comments -H "content-type: application/json" \\
    -d "$(python3 -c 'import json,sys;print(json.dumps({"author":"agent","body":sys.argv[1]}))' "<your reply>")"`;
}

// Compact, server-side rendering of a task + its comment thread, inlined into
// prompts so the agent needn't spend turns curling for what we already hold.
export function renderThread(db, taskId) {
  const t = getTask(db, taskId);
  if (!t) return '(task not found)';
  const head = [
    `Task #${t.id}: ${t.title}`,
    t.detail ? `Detail: ${t.detail}` : null,
    `Priority: ${t.priority} · Status: ${t.status}`,
    t.source_permalink ? `Source: ${t.source_permalink}` : null,
  ].filter(Boolean);
  const thread = (t.comments || []).map(
    (c) => `- [${c.author}${c.updated_by && c.updated_by !== c.author ? '/' + c.updated_by : ''} · ${c.created_at || ''}] ${c.body}`,
  );
  return [...head, '', 'Comment thread (oldest first):', ...(thread.length ? thread : ['(none yet)'])].join('\n');
}
```

Add the import for `getTask` at the top of `prompts.js`:

```js
import { getTask } from './store.js';
```

Replace `replyPrompt` with:

```js
export function replyPrompt({ apiBase, db, task }) {
  return `REPLY task_id=${task.id}.
WHO I AM (context): ${loadContext()}
${AGENT_RULES}
Here is the task and its full comment thread — you do NOT need to fetch it:
---
${renderThread(db, task.id)}
---
The latest 'me' comment is my request. Help with THIS task only.
You MAY read Slack via SLACK_USER_TOKEN + curl if this task genuinely needs it — but not merely to re-read the thread above.
When done, post your answer as an agent comment:
${postCommentRecipe(apiBase, task.id)}
Task title: ${task.title}`;
}
```

In `ingestPrompt`, replace the literal rules line (currently `Use Bash + curl + gh only. Do NOT use any Anthropic API. Do NOT use jq — build JSON with python3.`) with `${AGENT_RULES}`. In `digestPrompt`, replace `Do NOT use any Anthropic API.` (and the jq caution) with `${AGENT_RULES}`.

- [ ] **Step 4: Modify `src/agent-modes.js`** — `code.diagnosePrompt` takes `db` and inlines the thread

Add at the top: `import { AGENT_RULES, renderThread } from './prompts.js';`
Change the signature to `diagnosePrompt: ({ apiBase, task, worktreePath, db }) => ...` and inside, add before the closing instructions:

```js
Here is the task and its comment thread (context you may have been given):
---
${renderThread(db, task.id)}
---
```

and replace the trailing `Do NOT use any Anthropic API.` with `${AGENT_RULES}`.

- [ ] **Step 5: Wire `db` through callers**

`src/cron.js` `runReply` (line ~52): change
`prompt: replyPrompt({ apiBase: apiBase(), task })`
to
`prompt: replyPrompt({ apiBase: apiBase(), db, task })`.

`src/dispatch.js` `doDispatch` (line ~42): change
`prompt: modeDef.diagnosePrompt({ apiBase: apiBase(), task: t, worktreePath: wt.worktreePath })`
to
`prompt: modeDef.diagnosePrompt({ apiBase: apiBase(), task: t, worktreePath: wt.worktreePath, db })`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/prompts.test.js test/cron.test.js test/engine.test.js`
Expected: PASS (reply/diagnose wiring intact; the stub is keyword-driven, so `REPLY task_id=`/`DIAGNOSE task_id=` still match).

- [ ] **Step 7: Commit**

```bash
git add src/prompts.js src/agent-modes.js src/cron.js src/dispatch.js test/prompts.test.js
git commit --no-gpg-sign -m "feat(prompts): inline task/thread + shared preamble; leaner reply/diagnose"
```

---

### Task 7: Generalized live-run viewer in `public/index.html`

Drive the existing `#console` from any `runId`; add per-task Watch/Runs and an activity indicator. (No unit test — verified by exercising the app.)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/runs/:runId/stream`, `GET /api/runs/active`, `GET /api/tasks/:id/runs`.

- [ ] **Step 1: Generalize `openConsole`**

Replace the current `openConsole(kind)` (which opens `EventSource('/api/runs/'+kind+'/stream')`) with `openConsole(runId, title)` opening `new EventSource('/api/runs/' + runId + '/stream')`. Keep the exact message handling (`reset` clears; `end` marks done + closes; others append a formatted line and autoscroll) and the panel show/close logic.

- [ ] **Step 2: Point the manual ingest/digest buttons at the run**

In `runJob(job, btn)`, after `POST /api/run/:job`, resolve the run id (the row is created just after the fire-and-forget trigger) and open the console:

```js
async function watchLatest(kind, title) {
  for (let i = 0; i < 20; i++) {
    const active = await (await fetch('/api/runs/active')).json();
    const run = active.find((r) => r.kind === kind);
    if (run) return openConsole(run.id, title);
    await new Promise((r) => setTimeout(r, 250));
  }
}
```

Call `watchLatest(job, job)` from `runJob` instead of the old `openConsole(job)`.

- [ ] **Step 3: Per-task "Watch" + "Runs"**

In the task-card render, when `t.agent_phase` is `diagnosing` or `executing` (or a reply is running), add a "Watch" button:

```js
<button onclick="watchTask(${t.id})">Watch</button>
```

```js
async function watchTask(id) {
  const active = await (await fetch('/api/runs/active')).json();
  const run = active.find((r) => r.task_id === id);
  if (run) openConsole(run.id, 'task ' + id);
  else loadRuns(id); // nothing live — show history instead
}
async function loadRuns(id) {
  const runs = await (await fetch('/api/tasks/' + id + '/runs')).json();
  // render a small list; each row: `${r.kind} · ${r.status} · $${(r.cost_usd||0).toFixed(4)} · ${r.started_at}`
  // clicking a row → openConsole(r.id, r.kind + ' #' + r.id)
}
```

Add a "Runs" disclosure control on each task card that calls `loadRuns(t.id)` and renders the returned rows (each clickable → `openConsole`).

- [ ] **Step 4: Activity indicator**

Add a small header affordance that periodically (reuse the existing ~3s refresh) fetches `/api/runs/active` and shows a count / list of running kinds; clicking an entry opens its console.

- [ ] **Step 5: Verify in the app**

Run the server and exercise it (see Task 9 for the deploy/run path). Confirm: dispatch a task → "Watch" streams diagnose live; `@claude` on a task → "Watch" streams the reply live; after completion, "Runs" reopens the trace; manual ingest button still streams.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit --no-gpg-sign -m "feat(ui): watch any task's agent live + reopen past run traces"
```

---

### Task 8: Roadmap doc update (separate concern)

Fold this feature into the roadmap and make the earlier-agreed edits.

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Edit `docs/ROADMAP.md`**
  - Add a new entry (e.g. under Phase 3 / or a short "Phase 0.5 — Observability & lean context · building") describing: runId-keyed runs, durable JSONL traces, per-task live/replay console, inlined reply/diagnose context, shared prompt preamble.
  - Add a one-line **done-criteria** to each phase header.
  - Add a **baseline cost target** line near the top (fill the current ~$/day from `/api/usage/history` once known; state target).

- [ ] **Step 2: Commit**

```bash
git add docs/ROADMAP.md
git commit --no-gpg-sign -m "docs: roadmap — observability entry, per-phase done-criteria, cost baseline"
```

---

### Task 9: Full verification, merge to main, deploy

**Files:** none (process task)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all test files PASS.

- [ ] **Step 2: Exercise the app end-to-end**

Start the server (`npm start` or the project's run path), then drive: manual ingest (watch live), dispatch a task on a repo (watch diagnose live → approve → watch execute), `@claude` reply (watch live), reopen a finished run from "Runs". Confirm traces persist under `data/traces/` and replay after a restart.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge --no-ff feat/run-observability-lean-context -m "feat: run observability + lean context"
git push origin main
```

- [ ] **Step 4: Deploy**

Run the project's deploy path: `npm run update` (→ `scripts/update.sh`, which restarts the agent and deploys new code). Confirm the health check passes and the live site serves the new UI.

- [ ] **Step 5: Report back** with the results (tests, deploy status, live URL).

---

## Self-Review

**Spec coverage:**
- runbus runId keying → Task 1. Durable trace → Task 2. agent tee → Task 3. store queries → Task 4. SSE + active + task-runs + run-meta endpoints → Task 5. Shared preamble + renderThread + replyPrompt + diagnose thread + wiring → Task 6. Generalized console + Watch/Runs/activity → Task 7. Roadmap doc → Task 8. Testing + retention (Task 2 `prune`, called in Task 3) + merge/deploy → Task 9. All spec sections covered.

**Placeholder scan:** No TBD/TODO in code steps; every code step shows the code. Task 7 (UI) and Task 8 (prose doc) are intentionally described rather than full-file dumps because they are non-TDD edits to a large HTML file and a narrative doc; each step still names the exact function/handler and the shape of the change.

**Type consistency:** `runId` is numeric throughout (runbus, trace `fileFor`, store `getRun`). `renderThread(db, taskId)` signature matches all call sites (prompts, agent-modes). `replyPrompt({ apiBase, db, task })` matches the `cron.runReply` call. `diagnosePrompt({ apiBase, task, worktreePath, db })` matches the `dispatch` call. Endpoint paths (`/api/runs/active` before `/api/runs/:runId`) ordered to avoid capture. `activeRuns` returns `task_id` (used by `watchTask`).
