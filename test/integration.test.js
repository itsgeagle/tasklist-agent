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
