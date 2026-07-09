import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, cleanupWorktree } from '../src/worktree.js';

function tmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  execFileSync('git', ['-C', dir, 'init', '-b', 'trunk']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'x'), '1');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '--no-gpg-sign', '-m', 'init']);
  return dir;
}

test('createWorktree makes an isolated checkout on a new branch, cleanup removes it', () => {
  const repo = tmpGitRepo();
  const { worktreePath, branch } = createWorktree(repo, 'trunk', 42);
  assert.ok(fs.existsSync(path.join(worktreePath, 'x')), 'worktree has repo contents');
  assert.match(branch, /^agent\/task-42-/);
  // committing in the worktree must NOT change the source checkout's branch
  fs.writeFileSync(path.join(worktreePath, 'y'), '2');
  execFileSync('git', ['-C', worktreePath, 'add', '-A']);
  execFileSync('git', ['-C', worktreePath, 'commit', '--no-gpg-sign', '-m', 'wt']);
  assert.equal(fs.existsSync(path.join(repo, 'y')), false, 'source checkout untouched');
  cleanupWorktree(repo, worktreePath);
  assert.equal(fs.existsSync(worktreePath), false, 'worktree removed');
});
