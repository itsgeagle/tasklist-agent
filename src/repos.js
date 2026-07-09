import { execFileSync } from 'node:child_process';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

export function validateRepo(repoPath) {
  try {
    const inside = git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return { ok: false, error: 'not a git work tree' };
    let branch;
    try { branch = git(repoPath, ['symbolic-ref', '--short', 'HEAD']); }
    catch { branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']); }
    return { ok: true, default_branch: branch };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).toString().trim() };
  }
}
