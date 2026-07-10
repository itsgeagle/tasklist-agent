import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, slug, fingerprint, upsertTask, listTasks, getTask,
  patchTask, addComment, createRun, finishRun, activeRunForTask,
  acquireLock, releaseLock, findOpenTaskByThread, latestRun,
  usageToday, usageByDay } from '../src/store.js';

const db = () => openDb(':memory:');

test('slug normalizes text', () => {
  assert.equal(slug('Fix the Login Bug!'), 'fix-the-login-bug');
});

test('fingerprint is stable and channel/ts/title sensitive', () => {
  const a = fingerprint('C1', '111.1', 'Do thing');
  assert.equal(a, fingerprint('C1', '111.1', 'Do thing'));
  assert.notEqual(a, fingerprint('C2', '111.1', 'Do thing'));
});

test('upsertTask dedups on fingerprint', () => {
  const d = db();
  const r1 = upsertTask(d, { title: 'Do thing', source_channel: 'C1', source_ts: '1.1' });
  const r2 = upsertTask(d, { title: 'Do thing', source_channel: 'C1', source_ts: '1.1' });
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.id, r2.id);
  assert.equal(listTasks(d, 'all').length, 1);
});

test('done task is not resurrected by re-ingest', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'Do thing', source_channel: 'C1', source_ts: '1.1' });
  patchTask(d, id, { status: 'done' });
  upsertTask(d, { title: 'Do thing', source_channel: 'C1', source_ts: '1.1' });
  assert.equal(getTask(d, id).status, 'done');
  assert.equal(listTasks(d, 'open').length, 0);
});

test('comments attach and getTask includes them', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'T', source_channel: 'C1', source_ts: '1.1' });
  addComment(d, id, 'me', 'hello');
  addComment(d, id, 'agent', 'hi back');
  const t = getTask(d, id);
  assert.equal(t.comments.length, 2);
  assert.equal(t.comments[0].author, 'me');
});

test('active run is reflected on task', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'T', source_channel: 'C1', source_ts: '1.1' });
  const runId = createRun(d, { kind: 'reply', task_id: id });
  assert.equal(activeRunForTask(d, id), true);
  finishRun(d, runId, 'ok', 'done');
  assert.equal(activeRunForTask(d, id), false);
});

test('upsertTask persists source_thread_ts and defaults updated_by to slack', () => {
  const d = db();
  const { id } = upsertTask(d, {
    title: 'Ship launch', source_channel: 'C1', source_ts: '100.1',
    source_thread_ts: '100.1',
  });
  const t = getTask(d, id);
  assert.equal(t.source_thread_ts, '100.1');
  assert.equal(t.updated_by, 'slack');
});

test('findOpenTaskByThread matches only open tasks on thread ts', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'A', source_channel: 'C1', source_ts: '1.1', source_thread_ts: 'T1' });
  assert.equal(findOpenTaskByThread(d, 'T1').id, id);
  assert.equal(findOpenTaskByThread(d, 'nope'), null);
  assert.equal(findOpenTaskByThread(d, ''), null);
  patchTask(d, id, { status: 'done' });
  assert.equal(findOpenTaskByThread(d, 'T1'), null); // done tasks are not matched
});

test('patchTask records updated_by, defaulting to me', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'T', source_channel: 'C1', source_ts: '1.1' });
  patchTask(d, id, { priority: 1 });
  assert.equal(getTask(d, id).updated_by, 'me');
  patchTask(d, id, { status: 'done', updated_by: 'slack' });
  assert.equal(getTask(d, id).updated_by, 'slack');
});

test('addComment stamps the task updated_by with the comment author', () => {
  const d = db();
  const { id } = upsertTask(d, { title: 'T', source_channel: 'C1', source_ts: '1.1' });
  addComment(d, id, 'slack', 'thread update from Slack');
  assert.equal(getTask(d, id).updated_by, 'slack');
});

test('lock is exclusive until released', () => {
  const d = db();
  assert.equal(acquireLock(d, 'ingest'), true);
  assert.equal(acquireLock(d, 'ingest'), false);
  releaseLock(d, 'ingest');
  assert.equal(acquireLock(d, 'ingest'), true);
});

test('finishRun persists cost/token metrics on the run', () => {
  const d = db();
  const runId = createRun(d, { kind: 'ingest' });
  finishRun(d, runId, 'ok', 'log', {
    cost_usd: 0.0123, cost_estimated: false,
    input_tokens: 1000, output_tokens: 200,
    cache_read_tokens: 5, cache_write_tokens: 6,
    num_turns: 3, duration_ms: 4200, model: 'claude-opus-4-8',
  });
  const r = latestRun(d, 'ingest');
  assert.equal(r.cost_usd, 0.0123);
  assert.equal(r.cost_estimated, 0);
  assert.equal(r.input_tokens, 1000);
  assert.equal(r.output_tokens, 200);
  assert.equal(r.model, 'claude-opus-4-8');
});

test('finishRun without metrics leaves metric columns null (back-compat)', () => {
  const d = db();
  const runId = createRun(d, { kind: 'reply' });
  finishRun(d, runId, 'ok', 'log');
  const r = latestRun(d, 'reply');
  assert.equal(r.cost_usd, null);
  assert.equal(r.input_tokens, null);
});

test('usageToday sums metrics across all run kinds, excluding skipped', () => {
  const d = db();
  const a = createRun(d, { kind: 'ingest' });
  finishRun(d, a, 'ok', '', { cost_usd: 0.02, input_tokens: 100, output_tokens: 20 });
  const b = createRun(d, { kind: 'diagnose' });
  finishRun(d, b, 'ok', '', { cost_usd: 0.05, input_tokens: 200, output_tokens: 30 });
  const s = createRun(d, { kind: 'ingest' });
  finishRun(d, s, 'skipped', 'quiet');
  const u = usageToday(d);
  assert.equal(u.by_kind.ingest.runs, 1);      // skipped excluded
  assert.equal(u.by_kind.diagnose.cost_usd, 0.05);
  assert.equal(Math.round(u.total.cost_usd * 100), 7); // 0.07
  assert.equal(u.total.input_tokens, 300);
});
