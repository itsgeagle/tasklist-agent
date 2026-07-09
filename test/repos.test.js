import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRepo } from '../src/repos.js';

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['-C', dir, 'init', '-b', 'trunk']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'x'), '1');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--no-gpg-sign', '-m', 'init']);
  return dir;
}

test('validateRepo accepts a git repo and reads its branch', () => {
  const dir = tmpGitRepo();
  const r = validateRepo(dir);
  assert.equal(r.ok, true);
  assert.equal(r.default_branch, 'trunk');
});

test('validateRepo rejects a non-git dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  const r = validateRepo(dir);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

import express from 'express';
import { openDb } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

test('POST/GET/DELETE /api/repos with a real git repo', async () => {
  const dir = tmpGitRepo();
  const db = openDb(':memory:');
  const app = express(); app.use(express.json()); app.use(makeRouter(db));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const add = await (await fetch(`${base}/api/repos`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json();
  assert.ok(add.id);
  const list = await (await fetch(`${base}/api/repos`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].default_branch, 'trunk');
  const bad = await fetch(`${base}/api/repos`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/nope/nogit' }) });
  assert.equal(bad.status, 400);
  await fetch(`${base}/api/repos/${add.id}`, { method: 'DELETE' });
  assert.equal((await (await fetch(`${base}/api/repos`)).json()).length, 0);
  server.close();
});
