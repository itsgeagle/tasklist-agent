import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, listTasks, getTask } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, '..', 'bin', 'stub-claude.js');

async function bootFull() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  // onCommentAgent wired in Task 6 test; here we only exercise ingest.
  app.use(makeRouter(db));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;
  return { db, server, base };
}

test('ingest via stubbed claude creates deduped tasks', async () => {
  const { db, server, base } = await bootFull();
  // Import after env is set so config picks up CLAUDE_BIN/TASKLIST_API.
  const { runIngest } = await import('../src/cron.js?ingest');
  await runIngest(db);
  await runIngest(db); // second run must not duplicate
  const tasks = listTasks(db, 'all');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.find((t) => t.title.includes('Sam')));
  server.close();
});

test('ingest reconciles: thread task gets a slack update, merged-PR task closes', async () => {
  const { db, server, base } = await bootFull();
  const mk = (t) => fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) })
    .then((r) => r.json());

  const threaded = await mk({ title: 'Launch thread', source_channel: 'C9', source_ts: 'T9', source_thread_ts: 'T9' });
  const merged = await mk({ title: 'Ship fix', source_channel: 'C8', source_ts: '8.8' });
  await fetch(`${base}/api/tasks/${merged.id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7' }) });

  const { runIngest } = await import('../src/cron.js?reconcile');
  await runIngest(db);

  const threadedTask = getTask(db, threaded.id);
  assert.ok(threadedTask.comments.some((c) => c.author === 'slack'), 'thread task got a slack update');
  assert.equal(threadedTask.updated_by, 'slack');

  const mergedTask = getTask(db, merged.id);
  assert.equal(mergedTask.status, 'done', 'merged-PR task was closed');
  assert.equal(mergedTask.updated_by, 'slack');
  server.close();
});

test('commenting @claude spawns a reply run that posts an agent comment', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  const { runReply } = await import('../src/cron.js?reply');
  app.use(makeRouter(db, { onCommentAgent: (id) => runReply(db, id) }));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;

  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Help me', source_channel: 'C1', source_ts: '1.1' }) })).json();
  await fetch(`${base}/api/tasks/${id}/comments`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'me', body: '@claude please help', ask_agent: true }) });

  // Poll until the agent comment lands (reply run is async).
  let t;
  for (let i = 0; i < 50; i++) {
    t = await (await fetch(`${base}/api/tasks/${id}`)).json();
    if (t.comments.some((c) => c.author === 'agent')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(t.comments.some((c) => c.author === 'agent'), 'agent comment posted');
  server.close();
});

test('meta watermark round-trips and PATCH accepts updated_by', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // watermark starts null, then round-trips
  let hwm = await (await fetch(`${base}/api/meta/ingest_hwm`)).json();
  assert.equal(hwm.value, null);
  await fetch(`${base}/api/meta/ingest_hwm`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '200.5' }) });
  hwm = await (await fetch(`${base}/api/meta/ingest_hwm`)).json();
  assert.equal(hwm.value, '200.5');

  // PATCH carries updated_by through to the row
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  const patched = await (await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done', updated_by: 'slack' }) })).json();
  assert.equal(patched.updated_by, 'slack');
  server.close();
});

test('runbus replays buffer to late subscribers, then streams, and caps growth', async () => {
  const runbus = await import('../src/runbus.js');
  runbus._reset();
  runbus.begin(7);
  runbus.publish(7, { t: 'tool', text: 'curl auth.test' });
  const seen = [];
  const unsub = runbus.subscribe(7, (ev) => seen.push(ev));
  // replay delivered reset + the buffered tool event
  assert.ok(seen.some((e) => e.t === 'reset'));
  assert.ok(seen.some((e) => e.t === 'tool'));
  runbus.publish(7, { t: 'result', text: 'ok' });   // live
  assert.equal(seen[seen.length - 1].t, 'result');
  runbus.end(7, 'ok');
  assert.equal(seen[seen.length - 1].t, 'end');
  unsub();
  runbus.publish(7, { t: 'tool', text: 'after unsub' }); // must not reach us
  assert.ok(!seen.some((e) => e.text === 'after unsub'));
});

test('a stubbed ingest persists a trace (start … tool/result … end)', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;
  const runbus = await import('../src/runbus.js');
  runbus._reset();
  const { runIngest } = await import('../src/cron.js?stream');
  await runIngest(db);
  const { latestRun } = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const fs = await import('node:fs');
  const runId = latestRun(db, 'ingest').id; // end() drops the live stream → read the durable trace
  const kinds = trace.read(runId).map((e) => e.t);
  assert.ok(kinds.includes('start'), 'has start');
  assert.ok(kinds.includes('tool'), 'has a tool call');
  assert.equal(kinds.at(-1), 'end', 'ends with end');
  fs.rmSync(trace.fileFor(runId));
  server.close();
});

test('SSE endpoint streams a finished run trace as event-stream frames', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db, { onRunJob: () => {} }));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;
  const runbus = await import('../src/runbus.js');
  runbus._reset();
  const { runIngest } = await import('../src/cron.js?sse');
  await runIngest(db);                    // completes; end() drops the live stream, trace persists

  const { latestRun } = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const fs = await import('node:fs');
  const runId = latestRun(db, 'ingest').id;

  const r = await fetch(`${base}/api/runs/${runId}/stream`);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();            // resolves because the replayed 'end' closes the stream
  assert.ok(text.includes('"t":"start"'), 'streamed a start frame');
  assert.ok(text.includes('"t":"end"'), 'streamed an end frame');

  const bad = await fetch(`${base}/api/runs/999999/stream`);
  assert.equal(bad.status, 404);
  fs.rmSync(trace.fileFor(runId));
  server.close();
  server.closeAllConnections?.();         // drop the keep-alive socket so the test process can exit
});

test('manual run route triggers the job callback and rejects unknown jobs', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db, { onRunJob: (job) => calls.push(job) }));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const ing = await fetch(`${base}/api/run/ingest`, { method: 'POST' });
  assert.equal(ing.status, 200);
  const dig = await fetch(`${base}/api/run/digest`, { method: 'POST' });
  assert.equal(dig.status, 200);
  const bad = await fetch(`${base}/api/run/bogus`, { method: 'POST' });
  assert.equal(bad.status, 400);

  // onRunJob fires via setImmediate; let the event loop drain.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['ingest', 'digest']);
  server.close();
});

test('digest run completes ok via stub', async () => {
  const db = openDb(':memory:');
  process.env.CLAUDE_BIN = STUB;
  process.env.TASKLIST_API = 'http://127.0.0.1:1'; // stub does not call it for DIGEST
  const { runDigest } = await import('../src/cron.js?digest');
  await runDigest(db);
  const { latestRun } = await import('../src/store.js');
  assert.equal(latestRun(db, 'digest').status, 'ok');
});
