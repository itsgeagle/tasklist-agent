import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DAILY_BUDGET = '0.01'; // captured when routes lazily imports config on first /api/usage
import { openDb, createRun, finishRun } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

test('GET /api/usage returns shaped totals and an over-budget flag; history is an array', async () => {
  const db = openDb(':memory:');
  const app = express(); app.use(express.json()); app.use(makeRouter(db, {}));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runId = createRun(db, { kind: 'ingest' });
  finishRun(db, runId, 'ok', '', { cost_usd: 0.5, input_tokens: 10, output_tokens: 5 });
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(u.today.total.cost_usd, 0.5);
  assert.equal(u.today.by_kind.ingest.input_tokens, 10);
  assert.equal(u.budget.over, true);
  assert.equal(u.budget.daily_usd, 0.01);
  assert.equal(u.cap, 2);
  const h = await (await fetch(`${base}/api/usage/history?days=7`)).json();
  assert.ok(Array.isArray(h));
  assert.equal(h[0].cost_usd, 0.5);
  server.close();
});
