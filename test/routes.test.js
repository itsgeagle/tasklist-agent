import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

function boot() {
  const db = openDb(':memory:');
  const asked = [];
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db, { onCommentAgent: (id) => asked.push(id) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, asked };
}

test('POST then GET tasks, dedup returns created flag', async () => {
  const { server, base } = boot();
  const body = { title: 'Reply to Sam', source_channel: 'C1', source_ts: '1.1' };
  const r1 = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal(r1.created, true);
  const r2 = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal(r2.created, false);
  const list = await (await fetch(`${base}/api/tasks?status=open`)).json();
  assert.equal(list.length, 1);
  server.close();
});

test('PATCH marks done, GET :id 404s when missing', async () => {
  const { server, base } = boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  const patched = await (await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }) })).json();
  assert.equal(patched.status, 'done');
  const miss = await fetch(`${base}/api/tasks/99999`);
  assert.equal(miss.status, 404);
  server.close();
});

test('comment with ask_agent triggers onCommentAgent', async () => {
  const { server, base, asked } = boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  await fetch(`${base}/api/tasks/${id}/comments`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'me', body: 'help please', ask_agent: true }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, [id]);
  server.close();
});

// A boot() variant that exposes the db so a test can record a finished run.
function bootDb() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db, {}));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

test('runs endpoints: unknown run 404s; active/task-runs return arrays', async () => {
  const { server, base } = bootDb();
  assert.equal((await fetch(`${base}/api/runs/999999`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/999999/stream`)).status, 404);
  const active = await (await fetch(`${base}/api/runs/active`)).json();
  assert.ok(Array.isArray(active));
  const taskRuns = await (await fetch(`${base}/api/tasks/1/runs`)).json();
  assert.ok(Array.isArray(taskRuns));
  server.close();
});

test('finished-run stream replays the trace file then ends', async () => {
  const { db, server, base } = bootDb();
  const store = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const fs = await import('node:fs');
  const runId = store.createRun(db, { kind: 'digest', task_id: null });
  store.finishRun(db, runId, 'ok', 'log', {});
  trace.open(runId);
  trace.append(runId, { t: 'start', text: 'go' });
  trace.append(runId, { t: 'end', status: 'ok' });
  trace.close(runId);
  const text = await (await fetch(`${base}/api/runs/${runId}/stream`)).text();
  assert.ok(text.includes('"t":"start"'), 'streamed a start frame');
  assert.ok(text.includes('"t":"end"'), 'streamed an end frame');
  fs.rmSync(trace.fileFor(runId));
  server.close();
});
