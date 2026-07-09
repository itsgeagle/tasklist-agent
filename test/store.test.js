import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, slug, fingerprint, upsertTask, listTasks, getTask,
  patchTask, addComment, createRun, finishRun, activeRunForTask,
  acquireLock, releaseLock } from '../src/store.js';

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

test('lock is exclusive until released', () => {
  const d = db();
  assert.equal(acquireLock(d, 'ingest'), true);
  assert.equal(acquireLock(d, 'ingest'), false);
  releaseLock(d, 'ingest');
  assert.equal(acquireLock(d, 'ingest'), true);
});
