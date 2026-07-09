# Agentic Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the tasklist dashboard so any task can dispatch a Claude Code agent that diagnoses a bug in an allow-listed repo, proposes a plan, waits for approval, then executes the fix in an isolated git worktree and opens a draft PR — streaming progress into the task thread.

**Architecture:** A generic run lifecycle (`dispatch → diagnose → plan → approve → execute → report`) built on the existing server. The server spawns headless `claude -p` (never the paid API) with a per-mode tool profile, in a git worktree of a chosen repo. v1 ships one mode: `code`. Phases are separate stateless spawns; progress is streamed as thread comments; the localhost API drives everything.

**Tech Stack:** Node ≥18, Express, better-sqlite3, node-cron, vanilla HTML/JS, `node:test`. Git worktrees + the `gh` CLI (draft PRs). Same repo: `~/projects/tasklist-agent`.

## Global Constraints

- **No Anthropic API usage.** All agent reasoning via `claude -p ... --allowedTools <tools> --output-format json`, binary from `CLAUDE_BIN`. Child env is a copy of `process.env` with every `ANTHROPIC_*` key deleted (carried from the base app's agent.js) before SLACK/DISCORD/TASKLIST are set.
- **Server binds `127.0.0.1` only.** ESM (`"type":"module"`), Node ≥18.
- **Draft PR only.** `gh pr create --draft`. Never push to `main`/`master`, never force-push, never merge. No remote → leave local branch + commits, report the branch.
- **Agents act only on allow-listed repos.** Execute always runs in a **fresh worktree** off the base branch; the source checkout is never modified.
- **Phase-aware, cancellable timeouts:** diagnose `DIAGNOSE_TIMEOUT_MS` (default 600000), execute `EXECUTE_TIMEOUT_MS` (default 2700000). Global concurrency cap `MAX_AGENT_CONCURRENCY` (default 2).
- **Commit unsigned** (`git commit --no-gpg-sign`); no `Co-Authored-By` trailer. TDD, DRY, YAGNI, frequent commits.
- **Additive only:** do not break the base app's existing tables, routes, tests, or the ingest/reply/digest flows. New task columns are nullable/defaulted; `runs.kind` is free-text TEXT (no change needed to store `diagnose`/`execute`).

## File Structure

```
src/config.js        MODIFY  add WORKTREE_DIR, MAX_AGENT_CONCURRENCY, DIAGNOSE_TIMEOUT_MS, EXECUTE_TIMEOUT_MS
src/store.js         MODIFY  repos table + task agent columns (guarded ALTER); repo CRUD; agent-field/usage helpers
src/repos.js         CREATE  git validation + default-branch read for the allow-list
src/routes.js        MODIFY  /api/repos, /api/tasks/:id/dispatch|approve|cancel, /api/usage
src/worktree.js      CREATE  create/cleanup/listStale git worktrees
src/agent.js         MODIFY  spawnAgent gains {tools,cwd,timeoutMs}; cancellation registry + cancelRun
src/agent-modes.js   CREATE  per-mode prompts + tool profiles (v1: code)
src/dispatch.js      CREATE  dispatch/approve/cancel orchestration (per-task lock + global cap + phase transitions)
server.js            MODIFY  wire dispatch handlers into makeRouter; reconcile worktrees on boot
public/index.html    MODIFY  status pill, plan card (Approve/Edit/Cancel), progress, PR link, "Hand to agent"
public/repos.html    CREATE  allow-list management page
bin/stub-claude.js   MODIFY  DIAGNOSE + EXECUTE branches (for tests)
test/repos.test.js       CREATE
test/worktree.test.js    CREATE
test/agent.test.js       CREATE  (spawnAgent tools/cwd/cancel)
test/engine.test.js      CREATE  (dispatch→diagnose→approve→execute end-to-end via stub)
```

---

### Task 1: Schema, repo allow-list backend, and repo API

**Files:**
- Modify: `src/config.js`, `src/store.js`, `src/routes.js`
- Create: `src/repos.js`, `test/repos.test.js`

**Interfaces:**
- Consumes: existing `openDb`, `getTask`, `makeRouter` from the base app.
- Produces:
  - `config` gains `WORKTREE_DIR:string`, `MAX_AGENT_CONCURRENCY:number`, `DIAGNOSE_TIMEOUT_MS:number`, `EXECUTE_TIMEOUT_MS:number`.
  - `store.js` new exports:
    - `addRepo(db,{name,path,default_branch}) → {id}` (UNIQUE path; throws on dup handled by caller)
    - `listRepos(db) → Repo[]`, `getRepo(db,id) → Repo|null`, `removeRepo(db,id) → void`
    - `setAgentFields(db, taskId, fields) → Task|null` where fields ⊆ `{repo_id,agent_mode,base_branch,agent_phase,worktree_path,pr_url}`
    - `activeAgentRuns(db) → number` (running runs with kind in diagnose|execute)
    - `activeRunIdForTask(db, taskId) → number|null`
    - `agentRunsToday(db) → number`
  - `repos.js`: `validateRepo(path) → {ok:boolean, default_branch?:string, error?:string}`
  - `Repo = {id,name,path,default_branch,added_at}`
  - Routes: `GET /api/repos`, `POST /api/repos {path,name?}`, `DELETE /api/repos/:id`.

- [ ] **Step 1: Add config values** — `src/config.js`, inside the exported object (after `API_BASE`):

```js
  WORKTREE_DIR: process.env.WORKTREE_DIR || path.join(ROOT, 'data', 'worktrees'),
  MAX_AGENT_CONCURRENCY: Number(process.env.MAX_AGENT_CONCURRENCY || 2),
  DIAGNOSE_TIMEOUT_MS: Number(process.env.DIAGNOSE_TIMEOUT_MS || 600000),
  EXECUTE_TIMEOUT_MS: Number(process.env.EXECUTE_TIMEOUT_MS || 2700000),
```

- [ ] **Step 2: Write failing test** — `test/repos.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/repos.test.js`
Expected: FAIL — `Cannot find module '../src/repos.js'`.

- [ ] **Step 4: Implement `src/repos.js`**

```js
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
```

- [ ] **Step 5: Add schema + store helpers** — `src/store.js`.

In `openDb`, after the existing `CREATE TABLE` block, add the repos table and column guards:

```js
  db.exec(`CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  for (const [col, def] of [
    ['repo_id', 'INTEGER'], ['agent_mode', 'TEXT'], ['base_branch', 'TEXT'],
    ['agent_phase', "TEXT NOT NULL DEFAULT 'idle'"], ['worktree_path', 'TEXT'], ['pr_url', 'TEXT'],
  ]) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?`).get(col);
    if (!exists) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
  }
```

Append these exports at the end of `src/store.js`:

```js
export function addRepo(db, { name, path, default_branch }) {
  const info = db.prepare('INSERT INTO repos (name, path, default_branch) VALUES (?, ?, ?)')
    .run(name, path, default_branch);
  return { id: info.lastInsertRowid };
}
export function listRepos(db) { return db.prepare('SELECT * FROM repos ORDER BY name').all(); }
export function getRepo(db, id) { return db.prepare('SELECT * FROM repos WHERE id = ?').get(id) || null; }
export function removeRepo(db, id) { db.prepare('DELETE FROM repos WHERE id = ?').run(id); }

export function setAgentFields(db, taskId, fields) {
  const allowed = ['repo_id', 'agent_mode', 'base_branch', 'agent_phase', 'worktree_path', 'pr_url'];
  const sets = allowed.filter((k) => k in fields);
  if (sets.length) {
    const clause = sets.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE tasks SET ${clause}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...fields, id: taskId });
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) || null;
}
export function activeAgentRuns(db) {
  return db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running' AND kind IN ('diagnose','execute')").get().n;
}
export function activeRunIdForTask(db, taskId) {
  const r = db.prepare("SELECT id FROM runs WHERE task_id = ? AND status='running' ORDER BY id DESC LIMIT 1").get(taskId);
  return r ? r.id : null;
}
export function agentRunsToday(db) {
  return db.prepare("SELECT COUNT(*) n FROM runs WHERE kind IN ('diagnose','execute') AND date(started_at)=date('now')").get().n;
}
```

- [ ] **Step 6: Add repo routes** — `src/routes.js`, inside `makeRouter`, before `return r;`. Import repos validation at top: `import { validateRepo } from './repos.js';`

```js
  r.get('/api/repos', (_req, res) => res.json(store.listRepos(db)));
  r.post('/api/repos', (req, res) => {
    const { path: repoPath, name } = req.body || {};
    if (!repoPath) return res.status(400).json({ error: 'path required' });
    const v = validateRepo(repoPath);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const { id } = store.addRepo(db, {
        name: name || repoPath.split('/').filter(Boolean).pop(),
        path: repoPath, default_branch: v.default_branch,
      });
      res.json({ id });
    } catch (e) {
      res.status(409).json({ error: String(e.message || e) });
    }
  });
  r.delete('/api/repos/:id', (req, res) => { store.removeRepo(db, Number(req.params.id)); res.json({ ok: true }); });
```

- [ ] **Step 7: Write route test** — append to `test/repos.test.js`:

```js
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd ~/projects/tasklist-agent && node --test test/repos.test.js`
Expected: PASS (3 tests). Then `npm test` — all prior tests still pass.

- [ ] **Step 9: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/config.js src/store.js src/repos.js src/routes.js test/repos.test.js
git commit --no-gpg-sign -m "feat(engine): repo allow-list schema, validation, and API"
```

---

### Task 2: Repos settings page

**Files:**
- Create: `public/repos.html`
- Modify: `public/index.html` (add a header link to Repos)

**Interfaces:**
- Consumes: `/api/repos` (Task 1). No automated test — verified by booting the server.

- [ ] **Step 1: Create `public/repos.html`**

```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tasklist · repos</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
  header { padding: 12px 20px; border-bottom: 1px solid #8884; }
  a { color: #4a90d9; } main { max-width: 720px; margin: 0 auto; padding: 20px; }
  .repo { display: flex; gap: 10px; align-items: center; border: 1px solid #8884; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .repo .path { flex: 1; font-family: ui-monospace, monospace; font-size: 13px; }
  input { flex: 1; padding: 6px 8px; border: 1px solid #8886; border-radius: 6px; background: Field; color: FieldText; }
  button { padding: 6px 10px; border: 1px solid #8886; border-radius: 6px; background: ButtonFace; color: ButtonText; cursor: pointer; }
  form { display: flex; gap: 6px; margin-bottom: 16px; }
</style></head>
<body>
<header><a href="/">&larr; tasks</a> &nbsp; <strong>Allowed repos</strong></header>
<main>
  <form onsubmit="return addRepo(event)">
    <input type="text" id="path" placeholder="/absolute/path/to/repo" autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <div id="list">Loading…</div>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function render() {
  const repos = await (await fetch('/api/repos')).json();
  document.getElementById('list').innerHTML = repos.length
    ? repos.map((x) => `<div class="repo"><span class="path">${esc(x.path)}</span>
        <span>${esc(x.default_branch)}</span>
        <button onclick="del(${x.id})">Remove</button></div>`).join('')
    : '<p>No repos yet. Add one above.</p>';
}
async function addRepo(e) {
  e.preventDefault();
  const path = document.getElementById('path').value.trim();
  if (!path) return false;
  const res = await fetch('/api/repos', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!res.ok) alert((await res.json()).error || 'failed');
  else { document.getElementById('path').value = ''; render(); }
  return false;
}
async function del(id) { await fetch('/api/repos/' + id, { method: 'DELETE' }); render(); }
render();
</script>
</body></html>
```

- [ ] **Step 2: Add a Repos link to the dashboard header** — `public/index.html`, inside `<header>`, after the `.tabs` span:

```html
  <a href="/repos.html" style="margin-left:auto;color:#4a90d9;font-size:13px;">Repos</a>
```

- [ ] **Step 3: Verify by booting**

Run: `cd ~/projects/tasklist-agent && (node server.js & echo $! > /tmp/tl.pid); sleep 1; curl -s http://127.0.0.1:8787/repos.html | grep -o '<title>tasklist · repos</title>'; kill $(cat /tmp/tl.pid)`
Expected: prints `<title>tasklist · repos</title>`.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tasklist-agent
git add public/repos.html public/index.html
git commit --no-gpg-sign -m "feat(engine): repos settings page"
```

---

### Task 3: Git worktree lifecycle

**Files:**
- Create: `src/worktree.js`, `test/worktree.test.js`

**Interfaces:**
- Consumes: `config.WORKTREE_DIR`.
- Produces:
  - `createWorktree(repoPath, baseBranch, taskId) → {worktreePath, branch}` — adds a worktree under `WORKTREE_DIR/task-<id>-<ts>` on a new branch `agent/task-<id>-<ts>` from `baseBranch`.
  - `cleanupWorktree(repoPath, worktreePath) → void` — `git worktree remove --force` + prune; ignores if already gone.
  - `listWorktrees(repoPath) → string[]` — absolute worktree paths (excluding the main checkout).

- [ ] **Step 1: Write failing test** — `test/worktree.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/worktree.test.js`
Expected: FAIL — `Cannot find module '../src/worktree.js'`.

- [ ] **Step 3: Implement `src/worktree.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/worktree.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/worktree.js test/worktree.test.js
git commit --no-gpg-sign -m "feat(engine): git worktree lifecycle"
```

---

### Task 4: Extend spawnAgent (tools, cwd, timeout, cancellation)

**Files:**
- Modify: `src/agent.js`
- Create: `test/agent.test.js`

**Interfaces:**
- Consumes: existing `config`, `createRun`, `finishRun`.
- Produces:
  - `spawnAgent(db, {kind, task_id=null, prompt, tools=['Bash'], cwd=undefined, timeoutMs=300000}) → Promise<{status,log,runId}>` — passes `--allowedTools <tools...>`, spawns with `cwd`, records/finishes the run, and registers the child for cancellation.
  - `cancelRun(db, runId) → boolean` — kills the registered child and marks the run `failed`; returns whether a child was found.

- [ ] **Step 1: Write failing test** — `test/agent.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, latestRun } from '../src/store.js';

test('spawnAgent runs in cwd and passes allowedTools', async () => {
  // stub echoes argv + cwd into a file we can inspect
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.PROBE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));
process.stdout.write('{}');`);
  const probe = path.join(dir, 'probe.json');
  process.env.CLAUDE_BIN = 'node';                 // run the stub via: node <stub> -p ...
  process.env.PROBE = probe;
  const { spawnAgent } = await import('../src/agent.js?a1');
  const db = openDb(':memory:');
  // prepend the stub path so `claude` args land after it: emulate by using a wrapper prompt
  const res = await spawnAgent(db, { kind: 'diagnose', prompt: 'hi', tools: ['Bash', 'Read'], cwd: dir,
    // test hook: force argv0 to the stub
    _binOverride: stub });
  assert.equal(res.status, 'ok');
  const probed = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(probed.cwd, fs.realpathSync(dir));
  assert.ok(probed.argv.includes('--allowedTools'));
  assert.ok(probed.argv.includes('Bash') && probed.argv.includes('Read'));
  assert.equal(latestRun(db, 'diagnose').status, 'ok');
});
```

> Note: `_binOverride` is a test-only hook so the test can point at a probe script without disturbing `CLAUDE_BIN` semantics. Implement it (Step 3) as: `const bin = opts._binOverride || config.CLAUDE_BIN;` and, when `_binOverride` is set, invoke `node <bin> ...args`. Keep it minimal.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/agent.test.js`
Expected: FAIL — `spawnAgent` doesn't accept `tools`/`cwd`/`_binOverride` yet (probe not written / assertion fails).

- [ ] **Step 3: Rewrite `src/agent.js`**

```js
import { spawn } from 'node:child_process';
import config from './config.js';
import { createRun, finishRun } from './store.js';

const active = new Map(); // runId -> child

export function spawnAgent(db, { kind, task_id = null, prompt, tools = ['Bash'], cwd, timeoutMs = 300000, _binOverride } = {}) {
  const runId = createRun(db, { kind, task_id });
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) if (/^ANTHROPIC_/.test(k)) delete childEnv[k];
    childEnv.SLACK_USER_TOKEN = config.SLACK_USER_TOKEN;
    childEnv.DISCORD_WEBHOOK_URL = config.DISCORD_WEBHOOK_URL;
    childEnv.TASKLIST_API = process.env.TASKLIST_API || config.API_BASE;

    const agentArgs = ['-p', prompt, '--output-format', 'json', '--allowedTools', ...tools];
    const bin = _binOverride || config.CLAUDE_BIN;
    const argv = _binOverride ? [bin, ...agentArgs] : agentArgs;
    const cmd = _binOverride ? 'node' : bin;
    const child = spawn(cmd, argv, { cwd, env: childEnv });

    active.set(runId, child);
    let out = '', err = '', done = false;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer); active.delete(runId);
      finishRun(db, runId, status, (out + err).slice(0, 20000));
      resolve({ status, log: out + err, runId });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('failed'); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { err += String(e); finish('failed'); });
    child.on('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
  });
}

export function cancelRun(db, runId) {
  const child = active.get(runId);
  if (!child) return false;
  child.kill('SIGKILL');           // 'close' handler finishes the run as failed
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/agent.test.js`
Expected: PASS. Then `npm test` — the base app's ingest/reply/digest tests still pass (they call `spawnAgent` with `{kind,prompt}` — defaults `tools:['Bash']` preserve prior `--allowedTools Bash` behavior).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/agent.js test/agent.test.js
git commit --no-gpg-sign -m "feat(engine): spawnAgent tool profile, cwd, and cancellation"
```

---

### Task 5: Diagnose phase — modes, dispatch orchestration, /dispatch

**Files:**
- Create: `src/agent-modes.js`, `src/dispatch.js`
- Modify: `src/routes.js`, `server.js`, `bin/stub-claude.js`
- Create: `test/engine.test.js`

**Interfaces:**
- Consumes: `spawnAgent` (Task 4), `createWorktree`/`cleanupWorktree` (Task 3), `getRepo`/`setAgentFields`/`getTask`/`acquireLock`/`releaseLock`/`activeAgentRuns` (Tasks 1 + base).
- Produces:
  - `agent-modes.js`: `MODES = { code: { diagnoseTools, executeTools, diagnosePrompt(ctx), executePrompt(ctx) } }`.
  - `dispatch.js`: `dispatch(db, taskId, {repo_id, base_branch, mode}) → Promise<void>` — validates, enforces cap + per-task lock, creates worktree, sets `diagnosing`, spawns diagnose, then transitions to `awaiting_approval` (ok) or `failed`+cleanup.
  - Route: `POST /api/tasks/:id/dispatch`.
  - `makeRouter(db, { onCommentAgent, onDispatch })` — `onDispatch(id, body)` fired fire-and-forget.

- [ ] **Step 1: Implement `src/agent-modes.js`**

```js
export const MODES = {
  code: {
    diagnoseTools: ['Bash', 'Read', 'Grep'],
    executeTools: ['Bash', 'Read', 'Write', 'Edit'],
    diagnosePrompt: ({ apiBase, task, worktreePath }) => `DIAGNOSE task_id=${task.id}.
You are in a git worktree at ${worktreePath} (already checked out, do NOT switch branches).
Investigate this issue READ-ONLY (do not modify files). Task: "${task.title}". ${task.detail || ''}
Find the root cause, then post a concise plan (root cause + the fix you propose + files to touch)
as a comment via:
  curl -s -X POST ${apiBase}/api/tasks/${task.id}/comments -H "content-type: application/json" \\
    -d "$(python3 -c 'import json,sys;print(json.dumps({"author":"agent","body":sys.argv[1]}))' "<your plan>")"
Do NOT use any Anthropic API. Output a one-line JSON summary.`,
    executePrompt: ({ apiBase, task, worktreePath, plan }) => `EXECUTE task_id=${task.id}.
You are in a git worktree at ${worktreePath} on a fresh branch. Implement this approved plan:
---
${plan}
---
Follow TDD, run the repo's tests, and commit with --no-gpg-sign (no Co-Authored-By).
Then open a DRAFT PR: \`gh pr create --draft --fill\`. NEVER push to main/master; never force-push.
If gh is unavailable or there is no remote, skip the PR and report the branch name instead.
Record the PR url:
  curl -s -X PATCH ${apiBase}/api/tasks/${task.id} -H "content-type: application/json" \\
    -d "$(python3 -c 'import json,sys;print(json.dumps({"pr_url":sys.argv[1]}))' "<pr url or branch>")"
Post a short summary comment (author "agent"). Do NOT use any Anthropic API.`,
  },
};
```

- [ ] **Step 2: Implement `src/dispatch.js` (diagnose path)**

```js
import config from './config.js';
import { getRepo, getTask, setAgentFields, acquireLock, releaseLock, activeAgentRuns, addComment } from './store.js';
import { spawnAgent } from './agent.js';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { MODES } from './agent-modes.js';

const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

export async function dispatch(db, taskId, { repo_id, base_branch, mode = 'code' }) {
  const task = getTask(db, taskId);
  if (!task) return;
  const modeDef = MODES[mode];
  const repo = getRepo(db, repo_id);
  if (!modeDef || !repo) { addComment(db, taskId, 'system', 'Dispatch failed: unknown mode or repo.'); return; }
  if (activeAgentRuns(db) >= config.MAX_AGENT_CONCURRENCY) {
    addComment(db, taskId, 'system', 'Busy: max concurrent agents reached, try again shortly.'); return;
  }
  if (!acquireLock(db, `agent:${taskId}`)) { addComment(db, taskId, 'system', 'An agent is already working on this task.'); return; }
  const branch = base_branch || repo.default_branch;
  let wt;
  try {
    wt = createWorktree(repo.path, branch, taskId);
    setAgentFields(db, taskId, { repo_id, agent_mode: mode, base_branch: branch, worktree_path: wt.worktreePath, agent_phase: 'diagnosing', pr_url: null });
    const t = getTask(db, taskId);
    const res = await spawnAgent(db, {
      kind: 'diagnose', task_id: taskId, tools: modeDef.diagnoseTools, cwd: wt.worktreePath,
      timeoutMs: config.DIAGNOSE_TIMEOUT_MS,
      prompt: modeDef.diagnosePrompt({ apiBase: apiBase(), task: t, worktreePath: wt.worktreePath }),
    });
    if (res.status === 'ok') setAgentFields(db, taskId, { agent_phase: 'awaiting_approval' });
    else { setAgentFields(db, taskId, { agent_phase: 'failed' }); addComment(db, taskId, 'system', 'Diagnosis failed.'); cleanupWorktree(repo.path, wt.worktreePath); }
  } catch (e) {
    setAgentFields(db, taskId, { agent_phase: 'failed' });
    addComment(db, taskId, 'system', 'Dispatch error: ' + String(e.message || e));
    if (wt) cleanupWorktree(repo.path, wt.worktreePath);
  } finally {
    releaseLock(db, `agent:${taskId}`);
  }
}
```

- [ ] **Step 3: Add the dispatch route + wire onDispatch** — `src/routes.js`. Change the signature to `export function makeRouter(db, { onCommentAgent, onDispatch } = {})` and add before `return r;`:

```js
  r.post('/api/tasks/:id/dispatch', (req, res) => {
    const id = Number(req.params.id);
    const task = store.getTask(db, id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.agent_phase && !['idle', 'done', 'failed'].includes(task.agent_phase))
      return res.status(409).json({ error: 'agent already active on this task' });
    const { repo_id, base_branch, mode } = req.body || {};
    if (!repo_id) return res.status(400).json({ error: 'repo_id required' });
    if (onDispatch) setImmediate(() => onDispatch(id, { repo_id, base_branch, mode }));
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Wire into `server.js`** — import dispatch and pass the handler:

```js
import { dispatch } from './src/dispatch.js';
// ...
const onCommentAgent = (id) => runReply(db, id);
const onDispatch = (id, body) => dispatch(db, id, body);
// ...
app.use(makeRouter(db, { onCommentAgent, onDispatch }));
```

- [ ] **Step 5: Add a DIAGNOSE branch to `bin/stub-claude.js`** — inside `main()`, before the final `else`:

```js
  } else if (/DIAGNOSE task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/DIAGNOSE task_id=(\d+)/)[1];
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Root cause: X. Plan: change file Y.' }) });
    process.stdout.write(JSON.stringify({ result: 'diagnosed' }));
```

- [ ] **Step 6: Write failing test** — `test/engine.test.js` (diagnose portion):

```js
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
  const { dispatch } = await import('../src/dispatch.js?d1');
  app.use(makeRouter(db, { onDispatch: (id, body) => dispatch(db, id, body) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base; process.env.CLAUDE_BIN = STUB;
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
```

- [ ] **Step 7: Run to verify RED then GREEN**

Run: `cd ~/projects/tasklist-agent && node --test test/engine.test.js`
Expected: initially FAIL (module/route missing), then PASS after Steps 1–5.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/agent-modes.js src/dispatch.js src/routes.js server.js bin/stub-claude.js test/engine.test.js
git commit --no-gpg-sign -m "feat(engine): diagnose phase (modes, dispatch, worktree)"
```

---

### Task 6: Approve + execute + cancel

**Files:**
- Modify: `src/dispatch.js`, `src/routes.js`, `bin/stub-claude.js`, `src/store.js` (extend `patchTask` allowed fields with `pr_url`)
- Modify: `test/engine.test.js` (add execute + cancel tests)

**Interfaces:**
- Consumes: everything from Task 5, plus `cancelRun` (Task 4), `activeRunIdForTask` (Task 1).
- Produces:
  - `dispatch.js` gains `approve(db, taskId, {plan}) → Promise<void>` and `cancel(db, taskId) → void`.
  - Routes: `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/cancel`.
  - `makeRouter(db, { onCommentAgent, onDispatch, onApprove })` — `onApprove(id, plan)` fire-and-forget. `cancel` is synchronous (no spawn) so its route calls a passed `onCancel(id)` or `store`+`cancelRun` directly; use `onCancel`.

- [ ] **Step 1: Extend `patchTask` allowed fields** — `src/store.js`, in `patchTask` change:

```js
  const allowed = ['status', 'title', 'detail', 'priority', 'pr_url'];
```

- [ ] **Step 2: Add `approve` and `cancel` to `src/dispatch.js`**

```js
import { cancelRun, } from './agent.js';           // add to existing agent.js import
import { activeRunIdForTask, listComments } from './store.js';  // add to existing store import

export async function approve(db, taskId, { plan } = {}) {
  const task = getTask(db, taskId);
  if (!task || task.agent_phase !== 'awaiting_approval') return;
  const repo = getRepo(db, task.repo_id);
  const modeDef = MODES[task.agent_mode] || MODES.code;
  // plan = edited plan if provided, else the last agent comment (the diagnosis)
  const planText = plan || [...listComments(db, taskId)].reverse().find((c) => c.author === 'agent')?.body || 'Fix the issue.';
  if (!acquireLock(db, `agent:${taskId}`)) return;
  setAgentFields(db, taskId, { agent_phase: 'executing' });
  try {
    const res = await spawnAgent(db, {
      kind: 'execute', task_id: taskId, tools: modeDef.executeTools, cwd: task.worktree_path,
      timeoutMs: config.EXECUTE_TIMEOUT_MS,
      prompt: modeDef.executePrompt({ apiBase: apiBase(), task, worktreePath: task.worktree_path, plan: planText }),
    });
    setAgentFields(db, taskId, { agent_phase: res.status === 'ok' ? 'done' : 'failed' });
    if (res.status !== 'ok') addComment(db, taskId, 'system', 'Execution failed.');
  } finally {
    releaseLock(db, `agent:${taskId}`);
    if (repo && task.worktree_path) cleanupWorktree(repo.path, task.worktree_path);
  }
}

export function cancel(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return;
  const runId = activeRunIdForTask(db, taskId);
  if (runId) cancelRun(db, runId);
  releaseLock(db, `agent:${taskId}`);
  const repo = getRepo(db, task.repo_id);
  if (repo && task.worktree_path) cleanupWorktree(repo.path, task.worktree_path);
  setAgentFields(db, taskId, { agent_phase: 'failed' });
  addComment(db, taskId, 'system', 'Agent run cancelled.');
}
```

- [ ] **Step 3: Add routes** — `src/routes.js`, signature `makeRouter(db, { onCommentAgent, onDispatch, onApprove, onCancel } = {})`, add:

```js
  r.post('/api/tasks/:id/approve', (req, res) => {
    const id = Number(req.params.id);
    const task = store.getTask(db, id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.agent_phase !== 'awaiting_approval') return res.status(409).json({ error: 'not awaiting approval' });
    if (onApprove) setImmediate(() => onApprove(id, (req.body || {}).plan));
    res.json({ ok: true });
  });
  r.post('/api/tasks/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getTask(db, id)) return res.status(404).json({ error: 'not found' });
    if (onCancel) onCancel(id);
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Wire `server.js`**

```js
import { dispatch, approve, cancel } from './src/dispatch.js';
// ...
app.use(makeRouter(db, {
  onCommentAgent: (id) => runReply(db, id),
  onDispatch: (id, body) => dispatch(db, id, body),
  onApprove: (id, plan) => approve(db, id, { plan }),
  onCancel: (id) => cancel(db, id),
}));
```

- [ ] **Step 5: Add an EXECUTE branch to `bin/stub-claude.js`** — the file is ESM, so add these imports at the TOP of `bin/stub-claude.js` (do NOT use `require`, which is undefined in ESM): `import { execSync } from 'node:child_process';` and `import fs from 'node:fs';`. Then add this branch before the final `else`:

```js
  } else if (/EXECUTE task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/EXECUTE task_id=(\d+)/)[1];
    fs.writeFileSync('fix.txt', 'fixed');                  // cwd is the worktree
    execSync('git add -A && git commit --no-gpg-sign -m "fix" ', { stdio: 'ignore' });
    await fetch(`${api}/api/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pr_url: 'local-branch:agent/task-' + id }) });
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Done. Draft PR opened.' }) });
    process.stdout.write(JSON.stringify({ result: 'executed' }));
```

- [ ] **Step 6: Add execute + cancel tests** — append to `test/engine.test.js`. (Reuse the `boot()`/`tmpGitRepo()` helpers already in the file.)

```js
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
```

- [ ] **Step 7: Run to verify RED then GREEN**

Run: `cd ~/projects/tasklist-agent && node --test test/engine.test.js`
Expected: PASS (diagnose + execute tests). Then `npm test` — full suite green.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/dispatch.js src/routes.js src/store.js server.js bin/stub-claude.js test/engine.test.js
git commit --no-gpg-sign -m "feat(engine): approve/execute/cancel with draft-PR flow"
```

---

### Task 7: Thread UI — dispatch, status, plan card, PR link

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `/api/repos`, `/api/tasks/:id/dispatch|approve|cancel`, and the `agent_phase`/`pr_url` fields now present on tasks. No automated test — verified by booting + a scripted dispatch.

- [ ] **Step 1: Extend `taskHtml(t)` in `public/index.html`** — add an agent block after the `.thread` div (inside the task template):

```js
  const phase = t.agent_phase || 'idle';
  const pill = phase !== 'idle'
    ? `<span class="pill ${phase}">${esc(phase.replace('_',' '))}</span>` : '';
  const pr = t.pr_url ? `<div class="src">PR: ${esc(t.pr_url)}</div>` : '';
  const approveBar = phase === 'awaiting_approval'
    ? `<div class="agentbar">
         <button onclick="approve(${t.id})">Approve &amp; execute</button>
         <button onclick="cancelAgent(${t.id})">Cancel</button>
       </div>` : '';
  const busy = ['diagnosing','executing'].includes(phase)
    ? `<div class="agentbar"><span class="spin">● agent ${esc(phase)}…</span>
         <button onclick="cancelAgent(${t.id})">Cancel</button></div>` : '';
  const dispatchBar = ['idle','done','failed'].includes(phase)
    ? `<div class="agentbar"><button onclick="handToAgent(${t.id})">Hand to agent</button></div>` : '';
```

Include `${pill}` next to the title, and `${pr}${approveBar}${busy}${dispatchBar}` after the thread. Add CSS in `<style>`:

```css
  .pill { font-size: 11px; padding: 2px 6px; border-radius: 10px; border: 1px solid #8886; margin-left: 6px; }
  .pill.executing, .pill.diagnosing { color: #d68910; } .pill.done { color: #27ae60; } .pill.failed { color: #c0392b; }
  .agentbar { margin: 8px 0 0 26px; display: flex; gap: 6px; align-items: center; }
```

- [ ] **Step 2: Add the JS handlers** — in `public/index.html` `<script>`:

```js
async function handToAgent(id) {
  const repos = await (await fetch('/api/repos')).json();
  if (!repos.length) { alert('Add a repo first (Repos link, top right).'); return; }
  const choice = prompt('Repo id to use:\n' + repos.map((r) => `${r.id}: ${r.path} (${r.default_branch})`).join('\n'), String(repos[0].id));
  if (!choice) return;
  await fetch('/api/tasks/' + id + '/dispatch', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: Number(choice), mode: 'code' }) });
  render();
}
async function approve(id) {
  const edited = prompt('Approve the plan. Optionally edit it (blank = use the posted plan):', '');
  await fetch('/api/tasks/' + id + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edited ? { plan: edited } : {}) });
  render();
}
async function cancelAgent(id) {
  await fetch('/api/tasks/' + id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  render();
}
```

- [ ] **Step 3: Verify by booting + scripted dispatch (stub)**

```bash
cd ~/projects/tasklist-agent
export CLAUDE_BIN="$PWD/bin/stub-claude.js"
rm -f data/tasks.db*                    # clean slate for manual check
(node server.js & echo $! > /tmp/tl.pid); sleep 1
# add this repo as an allow-listed repo, create a task, dispatch, approve
RID=$(curl -s -XPOST localhost:8787/api/repos -H 'content-type: application/json' -d "{\"path\":\"$PWD\"}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
TID=$(curl -s -XPOST localhost:8787/api/tasks -H 'content-type: application/json' -d '{"title":"demo","source_channel":"C","source_ts":"9.9"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
curl -s -XPOST localhost:8787/api/tasks/$TID/dispatch -H 'content-type: application/json' -d "{\"repo_id\":$RID,\"mode\":\"code\"}" >/dev/null
sleep 2; curl -s localhost:8787/api/tasks/$TID | node -e 'process.stdin.on("data",d=>{const t=JSON.parse(d);console.log("phase:",t.agent_phase)})'
kill $(cat /tmp/tl.pid)
```
Expected: `phase: awaiting_approval` (the stub diagnose posted a plan). Confirm `http://tasklist` shows the pill + Approve bar. Discard the scratch DB after.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tasklist-agent
git add public/index.html
git commit --no-gpg-sign -m "feat(engine): thread UI for dispatch, approval, and PR link"
```

---

### Task 8: Usage view + concurrency counter

**Files:**
- Modify: `src/routes.js`, `public/index.html`
- Modify: `test/engine.test.js` (usage assertion)

**Interfaces:**
- Consumes: `agentRunsToday`, `activeAgentRuns` (Task 1).
- Produces: `GET /api/usage → {today:number, active:number, cap:number}`; a small usage indicator in the dashboard header.

- [ ] **Step 1: Add the usage route** — `src/routes.js`, before `return r;`. Import cap: `import config from './config.js';` (if not already imported) then:

```js
  r.get('/api/usage', (_req, res) => res.json({
    today: store.agentRunsToday(db), active: store.activeAgentRuns(db), cap: config.MAX_AGENT_CONCURRENCY,
  }));
```

- [ ] **Step 2: Add usage test** — append to `test/engine.test.js`:

```js
test('usage endpoint counts agent runs for today', async () => {
  const { db, base, repoId, server } = await boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'u', source_channel: 'C', source_ts: '3.3' }) })).json();
  await fetch(`${base}/api/tasks/${id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, mode: 'code' }) });
  for (let i = 0; i < 100; i++) { if (getTask(db, id).agent_phase === 'awaiting_approval') break; await new Promise((r) => setTimeout(r, 50)); }
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(u.today >= 1, true);
  assert.equal(u.cap, 2);
  server.close();
});
```

- [ ] **Step 3: Run test**

Run: `cd ~/projects/tasklist-agent && node --test test/engine.test.js`
Expected: PASS (all engine tests).

- [ ] **Step 4: Add the header indicator** — `public/index.html`, add to the header (after the Repos link):

```html
  <span id="usage" style="font-size:12px;opacity:.7;margin-left:12px;"></span>
```

And in `loadStatusBanner()` (or a new poll), append:

```js
  const u = await (await fetch('/api/usage')).json();
  document.getElementById('usage').textContent = `agents: ${u.active}/${u.cap} · ${u.today} today`;
```

- [ ] **Step 5: Run full suite + commit**

Run: `cd ~/projects/tasklist-agent && npm test`
Expected: all tests pass.

```bash
cd ~/projects/tasklist-agent
git add src/routes.js public/index.html test/engine.test.js
git commit --no-gpg-sign -m "feat(engine): usage/cost view and concurrency counter"
```

---

## Self-Review

**Spec coverage:**
- §3 loop (dispatch→diagnose→plan→approve→execute→report) → Tasks 5 (diagnose) + 6 (approve/execute). ✓
- §4 data model (repos table; task columns; runs.kind) → Task 1. ✓
- §5 API (repos CRUD, dispatch, approve, cancel, usage) → Tasks 1, 5, 6, 8. ✓
- §6 interaction (thread status pill, plan card, repos page, usage) → Tasks 2, 7, 8. ✓
- §7 guardrails (allow-list, worktree isolation, draft-PR-only, no-main-push, phase timeouts, concurrency cap) → Tasks 1/3/4/5/6/8; "never touches source main" asserted in Task 6 test. ✓
- §8 reuse/extension (spawnAgent tools/cwd/timeout/cancel, modules) → Tasks 3, 4, 5, 6. ✓
- §9 error handling (bad repo 400, crash/timeout→failed+cleanup, 409 guards, gh-missing fallback) → Tasks 1/5/6. ✓
- §10 testing (stub-driven, git fixture, phase transitions, approve-gates-execute, worktree isolation, cleanup, cap) → Tasks 1,3,4,5,6,8. ✓
- §11 build phases → Task grouping. ✓
- **Boot reconcile of orphaned worktrees (§9):** the base app's `reconcile` already marks orphaned `running` runs `failed`; extend it to also clean worktrees for tasks left non-terminal. **Added as Task 6 Step note?** — NOT yet covered by a task. **Fix inline:** fold into Task 6 — see addendum below.

**Addendum to Task 6 (fold in during implementation):** in `src/store.js` `reconcile(db)`, after marking running runs failed, also: for every task with `agent_phase IN ('diagnosing','executing')`, set `agent_phase='failed'` and, if `worktree_path` + `repo_id` resolve, `cleanupWorktree(repo.path, worktree_path)` (import worktree there, or expose the list to server.js which owns the imports). Add one assertion to `test/engine.test.js`: dispatch, kill mid-run by calling `reconcile` on the same db, assert `agent_phase==='failed'` and the worktree path is removed. Commit with Task 6.

**Placeholder scan:** No TBD/TODO. The `_binOverride` hook in Task 4 is real, minimal test-support code (documented), not a placeholder.

**Type consistency:** `spawnAgent(db,{kind,task_id,prompt,tools,cwd,timeoutMs})`, `dispatch(db,taskId,{repo_id,base_branch,mode})`, `approve(db,taskId,{plan})`, `cancel(db,taskId)`, `makeRouter(db,{onCommentAgent,onDispatch,onApprove,onCancel})`, and all new `store.js` signatures are used identically across Tasks 1/4/5/6/8. Prompt markers `DIAGNOSE task_id=N` / `EXECUTE task_id=N` match between `agent-modes.js` and `bin/stub-claude.js`. `agent_phase` enum values are consistent everywhere (`idle|diagnosing|awaiting_approval|executing|done|failed`).
