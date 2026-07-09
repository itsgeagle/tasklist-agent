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

test('digest run completes ok via stub', async () => {
  const db = openDb(':memory:');
  process.env.CLAUDE_BIN = STUB;
  process.env.TASKLIST_API = 'http://127.0.0.1:1'; // stub does not call it for DIGEST
  const { runDigest } = await import('../src/cron.js?digest');
  await runDigest(db);
  const { latestRun } = await import('../src/store.js');
  assert.equal(latestRun(db, 'digest').status, 'ok');
});
