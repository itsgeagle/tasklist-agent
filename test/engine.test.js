import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, addRepo, getTask } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stub-claude.js');

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  execFileSync('git', ['-C', dir, 'init', '-b', 'trunk']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'x'), '1');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--no-gpg-sign', '-m', 'init']);
  return dir;
}

async function boot() {
  const db = openDb(':memory:');
  const repo = tmpGitRepo();
  const { id: repoId } = addRepo(db, { name: 'r', path: repo, default_branch: 'trunk' });
  const app = express(); app.use(express.json());
  // Set CLAUDE_BIN before dispatch.js (and its static config.js import) load,
  // since config.js reads process.env.CLAUDE_BIN eagerly at import time —
  // same ordering integration.test.js relies on for the other stubbed runs.
  process.env.CLAUDE_BIN = STUB;
  const { dispatch } = await import('../src/dispatch.js?d1');
  app.use(makeRouter(db, { onDispatch: (id, body) => dispatch(db, id, body) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  return { db, repo, repoId, base, server };
}

test('dispatch → diagnose posts a plan and moves to awaiting_approval', async () => {
  const { db, base, repoId, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fix bug', source_channel: 'C', source_ts: '1.1' }) })).json();
  await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  let t;
  for (let i = 0; i < 100; i++) { t = getTask(db, id); if (t.agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'awaiting_approval');
  assert.ok(t.comments.some((c) => c.author === 'agent' && /Plan:/.test(c.body)));
  assert.ok(t.worktree_path);
  server.close();
});

test('dispatch rejects non-integer repo_id and survives a nonexistent repo_id without crashing', async () => {
  const { db, base, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fix bug 2', source_channel: 'C', source_ts: '2.1' }) })).json();

  const badRes = await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: {}, mode: 'code' }) });
  assert.equal(badRes.status, 400);
  assert.match((await badRes.json()).error, /repo_id must be an integer/);

  const badRes2 = await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: 'abc', mode: 'code' }) });
  assert.equal(badRes2.status, 400);

  const okRes = await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: 99999, mode: 'code' }) });
  assert.equal(okRes.status, 200);

  let t;
  for (let i = 0; i < 100; i++) {
    t = getTask(db, id);
    if (t.comments.some((c) => c.author === 'system')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(t.comments.some((c) => c.author === 'system' && /unknown mode or repo/.test(c.body)));
  assert.notEqual(t.agent_phase, 'diagnosing');
  server.close();
});
