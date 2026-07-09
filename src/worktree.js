import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function createWorktree(repoPath, baseBranch, taskId) {
  fs.mkdirSync(config.WORKTREE_DIR, { recursive: true });
  const ts = Date.now().toString(36);
  const branch = `agent/task-${taskId}-${ts}`;
  const worktreePath = path.join(config.WORKTREE_DIR, `task-${taskId}-${ts}`);
  git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
  return { worktreePath, branch };
}

export function cleanupWorktree(repoPath, worktreePath) {
  try { git(repoPath, ['worktree', 'remove', '--force', worktreePath]); } catch { /* already gone */ }
  try { git(repoPath, ['worktree', 'prune']); } catch { /* noop */ }
  if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
}

export function listWorktrees(repoPath) {
  const out = git(repoPath, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => path.resolve(p) !== path.resolve(repoPath));
}
