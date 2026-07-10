import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/trace-dir.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, latestRun, setMeta } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stub-claude.js');

// Point ingest's API writes at a throwaway server bound to the test db, so the
// stub NEVER posts to the real running tasklist server on 127.0.0.1:8787.
function boot() {
  const db = openDb(':memory:');
  const app = express(); app.use(express.json()); app.use(makeRouter(db, {}));
  const server = app.listen(0);
  process.env.TASKLIST_API = `http://127.0.0.1:${server.address().port}`;
  return { db, server };
}

test('runIngest skips the LLM spawn when quiet and not stale', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c1');
  const { db, server } = boot();
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => false, now: () => 1_000_000 + 60_000 }); // 1 min later
  assert.equal(latestRun(db, 'ingest').status, 'skipped');
  server.close();
});

test('runIngest runs the full LLM ingest when quiet but stale', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c2');
  const { db, server } = boot();
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => false, now: () => 1_000_000 + 4 * 3600_000 }); // 4h later > 3h
  assert.equal(latestRun(db, 'ingest').status, 'ok');
  server.close();
});

test('runIngest runs the full LLM ingest when Slack has new activity', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c3');
  const { db, server } = boot();
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => true, now: () => 1_000_000 + 60_000 });
  assert.equal(latestRun(db, 'ingest').status, 'ok');
  server.close();
});

test('runIngest with force:true runs the full LLM ingest even when quiet and fresh', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?cforce');
  const { db, server } = boot();
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  // quiet + fresh (would normally skip), but force overrides:
  await runIngest(db, { hasNew: async () => false, now: () => 1_000_000 + 60_000, force: true });
  assert.equal(latestRun(db, 'ingest').status, 'ok');
  server.close();
});
