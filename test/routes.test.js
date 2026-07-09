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
