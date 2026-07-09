import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, addRepo, getTask, reconcile, setAgentFields, activeRunIdForTask, acquireLock, releaseLock } from '../src/store.js';
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
  const { dispatch, approve, cancel } = await import('../src/dispatch.js?d1');
  app.use(makeRouter(db, {
    onDispatch: (id, body) => dispatch(db, id, body),
    onApprove: (id, plan) => approve(db, id, { plan }),
    onCancel: (id) => cancel(db, id),
  }));
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

test('execute runs ONLY after approve, commits in the worktree, sets pr_url, never touches source main', async () => {
  const { db, repo, base, repoId, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fix bug', source_channel: 'C', source_ts: '2.2' }) })).json();
  await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  let t;
  for (let i = 0; i < 100; i++) { t = getTask(db, id); if (t.agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'awaiting_approval');
  const srcHeadBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();

  await fetch(`${base}/api/tasks/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  for (let i = 0; i < 200; i++) { t = getTask(db, id); if (['done', 'failed'].includes(t.agent_phase)) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'done');
  assert.match(t.pr_url, /agent\/task-/);
  const srcHeadAfter = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  assert.equal(srcHeadAfter, srcHeadBefore, 'source checkout HEAD unchanged');
  // worktree cleaned up
  assert.equal(fs.existsSync(t.worktree_path), false);
  server.close();
});

test('approve is rejected (409) unless the task is awaiting_approval', async () => {
  const { base, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Fresh task', source_channel: 'C', source_ts: '2.3' }) })).json();
  const res = await fetch(`${base}/api/tasks/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 409);
  server.close();
});

test('cancel from awaiting_approval releases the lock, cleans the worktree, marks failed, and blocks a later approve', async () => {
  const { db, base, repoId, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Cancel me', source_channel: 'C', source_ts: '2.4' }) })).json();
  await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  let t;
  for (let i = 0; i < 100; i++) { t = getTask(db, id); if (t.agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'awaiting_approval');
  const worktreePath = t.worktree_path;
  assert.equal(fs.existsSync(worktreePath), true);

  const cancelRes = await fetch(`${base}/api/tasks/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cancelRes.status, 200);
  t = getTask(db, id);
  assert.equal(t.agent_phase, 'failed');
  assert.ok(t.comments.some((c) => c.author === 'system' && /cancel/i.test(c.body)));
  assert.equal(fs.existsSync(worktreePath), false);

  // Cancel unblocks the lock, so a lock should be re-acquirable; but approve
  // must no-op since the phase is no longer awaiting_approval.
  const approveRes = await fetch(`${base}/api/tasks/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(approveRes.status, 409);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getTask(db, id).agent_phase, 'failed');
  server.close();
});

test('cancel while a run is in-flight delegates lock release + worktree cleanup to the owning run (no double-release)', async () => {
  const { db, base, repoId, server } = await boot();
  const { dispatch, cancel } = await import('../src/dispatch.js?d1');
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Cancel mid-flight', source_channel: 'C', source_ts: '2.6' }) })).json();
  const lockHeld = () => !!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`lock:agent:${id}`);

  // Call dispatch directly (not via the fire-and-forget HTTP route) and DON'T
  // await it yet: doDispatch runs synchronously (worktree creation, lock
  // acquire, agent_phase -> 'diagnosing', run row insert + child spawn) up to
  // its first await (the pending spawnAgent promise). So calling cancel()
  // synchronously right after is guaranteed — no polling/timing race — to see
  // the run as in-flight, with the same live child cancelRun's active-run map
  // is tracking.
  const dispatchPromise = dispatch(db, id, { repo_id: repoId, mode: 'code' });
  assert.equal(getTask(db, id).agent_phase, 'diagnosing');
  const runId = activeRunIdForTask(db, id);
  assert.ok(runId, 'run should already be registered as in-flight');
  assert.equal(lockHeld(), true);

  cancel(db, id);

  // cancel() found and killed a live run, so it must NOT touch phase/lock/
  // worktree itself — only post the "stopping" comment and step back.
  let t = getTask(db, id);
  assert.equal(t.agent_phase, 'diagnosing', 'cancel must not set phase itself when delegating to the owner');
  assert.ok(t.comments.some((c) => c.author === 'system' && /cancellation requested/i.test(c.body)));
  assert.equal(lockHeld(), true, 'lock is still held by the owning run, not double-released yet');

  await dispatchPromise; // the killed child's 'close' event resolves spawnAgent; doDispatch's own finally now runs

  t = getTask(db, id);
  assert.equal(t.agent_phase, 'failed');
  assert.equal(fs.existsSync(t.worktree_path), false, 'worktree cleaned up by the owning run, not by cancel');
  assert.equal(lockHeld(), false, 'lock released exactly once, by the owner');

  // Lock is free (not leaked): a fresh acquire succeeds.
  assert.equal(acquireLock(db, `agent:${id}`), true);
  releaseLock(db, `agent:${id}`);

  // And the task can be dispatched again exactly once.
  const dispatchRes2 = await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  assert.equal(dispatchRes2.status, 200);
  for (let i = 0; i < 100; i++) { t = getTask(db, id); if (t.agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'awaiting_approval', 'redispatch after cancel settles works exactly once');
  server.close();
});

test('cancel 404s on a nonexistent task', async () => {
  const { base, server } = await boot();
  const res = await fetch(`${base}/api/tasks/999999/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 404);
  server.close();
});

test('boot reconcile fails orphaned diagnosing/executing tasks and cleans their worktrees', async () => {
  const { db, base, repoId, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Orphaned', source_channel: 'C', source_ts: '2.5' }) })).json();
  await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  let t;
  for (let i = 0; i < 100; i++) { t = getTask(db, id); if (t.agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(t.agent_phase, 'awaiting_approval');
  const worktreePath = t.worktree_path;
  assert.equal(fs.existsSync(worktreePath), true);

  // The real 'diagnosing'/'executing' window is transient and racy to catch
  // mid-flight with the (near-instant) stub, so simulate the crash a boot-time
  // reconcile is meant to recover from: force the task into 'executing' with
  // its worktree still on disk (as it would be if the process died mid-run),
  // then run the exact two-step boot-reconcile path server.js runs: reconcile(db)
  // for the DB-only part, then clean up whatever it flags as orphaned.
  // worktree.js is imported dynamically (not at file top) for the same reason
  // dispatch.js is above: a static import would drag in config.js before
  // boot() sets CLAUDE_BIN, freezing it on the real `claude` binary and
  // hanging every agent-spawning test in this file.
  setAgentFields(db, id, { agent_phase: 'executing' });
  const { cleanupWorktree } = await import('../src/worktree.js');
  const { orphanedWorktrees } = reconcile(db);
  for (const { repo_path, worktree_path } of orphanedWorktrees) cleanupWorktree(repo_path, worktree_path);

  t = getTask(db, id);
  assert.equal(t.agent_phase, 'failed');
  assert.equal(orphanedWorktrees.some((w) => w.worktree_path === worktreePath), true);
  assert.equal(fs.existsSync(worktreePath), false);
  server.close();
});
