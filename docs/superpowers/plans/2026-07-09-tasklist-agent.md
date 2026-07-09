# Tasklist Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, always-on task dashboard at `http://tasklist` that ingests Slack activity into a deduplicated task list, lets me check off / comment / get Claude's help per task, and pushes a daily digest to Discord.

**Architecture:** A single Node + Express server bound to `127.0.0.1`, owning a SQLite store and serving one static HTML page. The server has no LLM logic of its own — it spawns `claude -p` (headless Claude Code, billed to the subscription, never the paid API) for ingestion, per-task replies, and the daily digest. Those headless runs talk back to the server over its localhost JSON API. Managed as a macOS launchd LaunchAgent.

**Tech Stack:** Node ≥18, Express, better-sqlite3 (WAL), node-cron, dotenv, vanilla HTML/JS dashboard, `node:test` for tests.

## Global Constraints

- **No Anthropic API usage.** All LLM reasoning goes through the Claude Code CLI in headless mode (`claude -p ... --output-format json`). The binary is resolved from `CLAUDE_BIN` (default `claude`) so tests substitute a stub.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0`.
- **Node port `8787`** (env `PORT`). Plain `http://tasklist` works via a one-time `pf` redirect `80 → 8787`; fallback `http://tasklist:8787`.
- **Secrets in gitignored `.env`:** `SLACK_USER_TOKEN`, `DISCORD_WEBHOOK_URL`, `PORT`, `CLAUDE_BIN`.
- **Dedup fingerprint:** `sha1(source_channel + ':' + source_ts + ':' + slug(title))`. Ingest never duplicates; a `done` task is never resurrected.
- **TDD, DRY, YAGNI, frequent commits.** Commit unsigned (`--no-gpg-sign`). No `Co-Authored-By` trailer.
- **Cron:** ingest `*/30 * * * *`; digest `0 8 * * *`.

## File Structure

```
package.json               deps + "test"/"start" scripts
.env.example               documented env template (committed; real .env gitignored)
server.js                  entry: config → db → routes → static → cron → listen(127.0.0.1)
src/config.js              env + resolved paths + port + API_BASE
src/store.js               SQLite open/migrate; fingerprint/slug; tasks/comments/runs/meta; locks
src/routes.js              Express router: /api/*
src/agent.js               spawnAgent(): run CLAUDE_BIN, record run, timeout kill
src/prompts.js             ingestPrompt/replyPrompt/digestPrompt (Slack + local-API contract)
src/cron.js                startSchedules(): 30-min ingest, daily digest
public/index.html          dashboard (inline CSS + JS, fetch + polling)
bin/stub-claude.js         test stub: emits canned JSON + performs the API writes a real run would
scripts/setup.sh           writes .env, /etc/hosts entry, pf redirect, launchd load
scripts/teardown.sh        reverse of setup.sh
scripts/tasklist.plist.template   launchd LaunchAgent template
test/store.test.js
test/routes.test.js
test/integration.test.js
```

---

### Task 1: Project scaffold, config, and store

**Files:**
- Create: `package.json`, `.env.example`, `src/config.js`, `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `src/config.js` default export object: `{ PORT:number, HOST:'127.0.0.1', DB_PATH:string, LOG_DIR:string, CLAUDE_BIN:string, SLACK_USER_TOKEN:string, DISCORD_WEBHOOK_URL:string, API_BASE:string }`.
  - `src/store.js` named exports:
    - `openDb(path:string) → Database` (better-sqlite3 instance, migrations applied, WAL on)
    - `slug(s:string) → string`
    - `fingerprint(channel:string, ts:string, title:string) → string`
    - `upsertTask(db, {title, detail?, source_channel, source_ts, source_permalink?, priority?}) → {id:number, created:boolean}`
    - `listTasks(db, status:'open'|'done'|'all') → Task[]`
    - `getTask(db, id:number) → (Task & {comments:Comment[], active_run:boolean}) | null`
    - `patchTask(db, id, {status?, title?, detail?, priority?}) → Task | null`
    - `addComment(db, taskId:number, author:'me'|'agent'|'system', body:string) → Comment`
    - `listComments(db, taskId) → Comment[]`
    - `createRun(db, {kind:'ingest'|'reply'|'digest', task_id?:number|null}) → number`
    - `finishRun(db, id, status:'ok'|'failed', log:string) → void`
    - `activeRunForTask(db, taskId) → boolean`
    - `latestRun(db, kind) → Run | null`
    - `getMeta(db, key) → string|null`, `setMeta(db, key, value) → void`
    - `acquireLock(db, key) → boolean`, `releaseLock(db, key) → void`
  - `Task = {id, title, detail, source_channel, source_ts, source_permalink, fingerprint, status, priority, created_at, updated_at}`
  - `Comment = {id, task_id, author, body, created_at}`
  - `Run = {id, kind, task_id, status, started_at, finished_at, log}`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tasklist-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.4.0",
    "express": "^4.19.0",
    "node-cron": "^3.0.3"
  }
}
```

Run: `cd ~/projects/tasklist-agent && npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 2: Create `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored.
PORT=8787
CLAUDE_BIN=claude
# Slack user token (xoxp-...) with scopes: channels/groups/im/mpim:history,
# channels/groups/im/mpim:read, users:read, search:read
SLACK_USER_TOKEN=
# Discord incoming webhook URL for the daily digest
DISCORD_WEBHOOK_URL=
```

- [ ] **Step 3: Create `src/config.js`**

```js
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(root, '..');
const PORT = Number(process.env.PORT || 8787);

export default {
  PORT,
  HOST: '127.0.0.1',
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'tasks.db'),
  LOG_DIR: path.join(ROOT, 'logs'),
  CLAUDE_BIN: process.env.CLAUDE_BIN || 'claude',
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || '',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  API_BASE: process.env.TASKLIST_API || `http://127.0.0.1:${PORT}`,
};
```

- [ ] **Step 4: Write the failing test `test/store.test.js`**

```js
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../src/store.js'`.

- [ ] **Step 6: Implement `src/store.js`**

```js
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      source_channel TEXT,
      source_ts TEXT,
      source_permalink TEXT,
      fingerprint TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      task_id INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      log TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
  return db;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function fingerprint(channel, ts, title) {
  return crypto.createHash('sha1')
    .update(`${channel}:${ts}:${slug(title)}`).digest('hex');
}

export function upsertTask(db, t) {
  const fp = fingerprint(t.source_channel || '', t.source_ts || '', t.title);
  const existing = db.prepare('SELECT * FROM tasks WHERE fingerprint = ?').get(fp);
  if (existing) return { id: existing.id, created: false };
  const info = db.prepare(`INSERT INTO tasks
    (title, detail, source_channel, source_ts, source_permalink, fingerprint, priority)
    VALUES (@title, @detail, @source_channel, @source_ts, @source_permalink, @fp, @priority)`)
    .run({
      title: t.title, detail: t.detail || '',
      source_channel: t.source_channel || null, source_ts: t.source_ts || null,
      source_permalink: t.source_permalink || null, fp,
      priority: t.priority ?? 2,
    });
  return { id: info.lastInsertRowid, created: true };
}

export function listTasks(db, status = 'open') {
  const q = status === 'all'
    ? 'SELECT * FROM tasks ORDER BY status, priority, updated_at DESC'
    : 'SELECT * FROM tasks WHERE status = ? ORDER BY priority, updated_at DESC';
  return status === 'all' ? db.prepare(q).all() : db.prepare(q).all(status);
}

export function getTask(db, id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return null;
  t.comments = listComments(db, id);
  t.active_run = activeRunForTask(db, id);
  return t;
}

export function patchTask(db, id, fields) {
  const allowed = ['status', 'title', 'detail', 'priority'];
  const sets = allowed.filter((k) => k in fields);
  if (sets.length) {
    const clause = sets.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE tasks SET ${clause}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...fields, id });
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
}

export function addComment(db, taskId, author, body) {
  const info = db.prepare('INSERT INTO comments (task_id, author, body) VALUES (?, ?, ?)')
    .run(taskId, author, body);
  db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(taskId);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
}

export function listComments(db, taskId) {
  return db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(taskId);
}

export function createRun(db, { kind, task_id = null }) {
  return db.prepare('INSERT INTO runs (kind, task_id) VALUES (?, ?)').run(kind, task_id).lastInsertRowid;
}

export function finishRun(db, id, status, log) {
  db.prepare("UPDATE runs SET status = ?, log = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, String(log || '').slice(0, 20000), id);
}

export function activeRunForTask(db, taskId) {
  return !!db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(taskId);
}

export function latestRun(db, kind) {
  return db.prepare('SELECT * FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) || null;
}

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function acquireLock(db, key) {
  try {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`lock:${key}`, 'held');
    return true;
  } catch { return false; }
}

export function releaseLock(db, key) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(`lock:${key}`);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/store.test.js`
Expected: PASS — all 7 tests.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/tasklist-agent
git add package.json package-lock.json .env.example src/config.js src/store.js test/store.test.js
git commit --no-gpg-sign -m "feat: project scaffold, config, and SQLite store"
```

---

### Task 2: HTTP API routes

**Files:**
- Create: `src/routes.js`
- Test: `test/routes.test.js`

**Interfaces:**
- Consumes: all of `src/store.js` (Task 1).
- Produces: `makeRouter(db, { onCommentAgent }) → express.Router`, where `onCommentAgent(taskId)` is an optional callback invoked (fire-and-forget) when a `me` comment requests the agent. Endpoints:
  - `GET /api/tasks?status=` → `Task[]`
  - `GET /api/tasks/:id` → task with comments or `404`
  - `POST /api/tasks` → `{id, created}` (used by ingest agent)
  - `PATCH /api/tasks/:id` → task
  - `POST /api/tasks/:id/comments` body `{author, body, ask_agent?}` → comment
  - `GET /api/status` → `{ingest, digest}` latest-run info

- [ ] **Step 1: Write the failing test `test/routes.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

function boot() {
  const db = openDb(':memory:');
  const asked = [];
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db, { onCommentAgent: (id) => asked.push(id) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, asked };
}

test('POST then GET tasks, dedup returns created flag', async () => {
  const { server, base } = boot();
  const body = { title: 'Reply to Sam', source_channel: 'C1', source_ts: '1.1' };
  const r1 = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal(r1.created, true);
  const r2 = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.equal(r2.created, false);
  const list = await (await fetch(`${base}/api/tasks?status=open`)).json();
  assert.equal(list.length, 1);
  server.close();
});

test('PATCH marks done, GET :id 404s when missing', async () => {
  const { server, base } = boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  const patched = await (await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }) })).json();
  assert.equal(patched.status, 'done');
  const miss = await fetch(`${base}/api/tasks/99999`);
  assert.equal(miss.status, 404);
  server.close();
});

test('comment with ask_agent triggers onCommentAgent', async () => {
  const { server, base, asked } = boot();
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  await fetch(`${base}/api/tasks/${id}/comments`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'me', body: 'help please', ask_agent: true }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, [id]);
  server.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/routes.test.js`
Expected: FAIL — `Cannot find module '../src/routes.js'`.

- [ ] **Step 3: Implement `src/routes.js`**

```js
import express from 'express';
import * as store from './store.js';

export function makeRouter(db, { onCommentAgent } = {}) {
  const r = express.Router();

  r.get('/api/tasks', (req, res) => {
    res.json(store.listTasks(db, req.query.status || 'open'));
  });

  r.get('/api/tasks/:id', (req, res) => {
    const t = store.getTask(db, Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  r.post('/api/tasks', (req, res) => {
    const { title, source_channel, source_ts } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    res.json(store.upsertTask(db, { ...req.body, source_channel, source_ts }));
  });

  r.patch('/api/tasks/:id', (req, res) => {
    const t = store.patchTask(db, Number(req.params.id), req.body || {});
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  r.post('/api/tasks/:id/comments', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getTask(db, id)) return res.status(404).json({ error: 'not found' });
    const { author = 'me', body = '', ask_agent = false } = req.body || {};
    const c = store.addComment(db, id, author, body);
    const wantsAgent = ask_agent || (author === 'me' && /@claude\b/i.test(body));
    if (wantsAgent && onCommentAgent) setImmediate(() => onCommentAgent(id));
    res.json(c);
  });

  r.get('/api/status', (_req, res) => {
    res.json({ ingest: store.latestRun(db, 'ingest'), digest: store.latestRun(db, 'digest') });
  });

  return r;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/routes.test.js`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/routes.js test/routes.test.js
git commit --no-gpg-sign -m "feat: localhost JSON API for tasks and comments"
```

---

### Task 3: Dashboard page + server entry

**Files:**
- Create: `public/index.html`, `server.js`
- Modify: none

**Interfaces:**
- Consumes: `makeRouter` (Task 2), `config` (Task 1), `openDb` (Task 1). `startSchedules` and `runReply` are wired in later tasks — leave a `TODO`-free stub that no-ops until Task 4/6 (see below; the stub is real code, not a placeholder).
- Produces: a runnable server (`npm start`) serving the dashboard at `/` and the API. `server.js` exports nothing; it is the entry point.

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tasklist</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
  header { padding: 12px 20px; border-bottom: 1px solid #8884; display: flex; gap: 16px; align-items: center; }
  h1 { font-size: 18px; margin: 0; }
  .banner { background: #c0392b; color: #fff; padding: 6px 20px; font-size: 13px; display: none; }
  main { max-width: 820px; margin: 0 auto; padding: 20px; }
  .task { border: 1px solid #8884; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
  .task.done { opacity: .55; }
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .title { font-weight: 600; flex: 1; }
  .src a { font-size: 12px; color: #4a90d9; text-decoration: none; }
  .thread { margin: 10px 0 0 26px; border-left: 2px solid #8884; padding-left: 10px; }
  .cmt { margin: 6px 0; }
  .cmt .who { font-weight: 600; font-size: 12px; text-transform: uppercase; opacity: .7; }
  .cmt.agent .who { color: #27ae60; }
  form.add { margin-top: 8px; display: flex; gap: 6px; }
  input[type=text] { flex: 1; padding: 6px 8px; border: 1px solid #8886; border-radius: 6px; background: Field; color: FieldText; }
  button { padding: 6px 10px; border: 1px solid #8886; border-radius: 6px; background: ButtonFace; color: ButtonText; cursor: pointer; }
  .spin { font-size: 12px; color: #27ae60; }
  .tabs button.active { font-weight: 700; text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>tasklist</h1>
  <span class="tabs">
    <button data-status="open" class="active">Open</button>
    <button data-status="done">Done</button>
    <button data-status="all">All</button>
  </span>
</header>
<div class="banner" id="banner"></div>
<main id="list">Loading…</main>
<script>
let status = 'open';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

async function loadStatusBanner() {
  const s = await (await fetch('/api/status')).json();
  const b = document.getElementById('banner');
  const bad = s.ingest && s.ingest.status === 'failed';
  b.style.display = bad ? 'block' : 'none';
  if (bad) b.textContent = 'Last Slack ingest failed — ' + (s.ingest.finished_at || '');
}

function taskHtml(t) {
  const cmts = (t.comments || []).map((c) =>
    `<div class="cmt ${c.author}"><span class="who">${esc(c.author)}</span> ${esc(c.body)}</div>`).join('');
  const src = t.source_permalink ? `<div class="src"><a href="${esc(t.source_permalink)}" target="_blank">source ↗</a></div>` : '';
  const spin = t.active_run ? '<span class="spin">● claude working…</span>' : '';
  return `<div class="task ${t.status}" data-id="${t.id}">
    <div class="row">
      <input type="checkbox" ${t.status==='done'?'checked':''} onchange="toggle(${t.id}, this.checked)">
      <div class="title">${esc(t.title)} ${spin}</div>
    </div>
    ${t.detail ? `<div>${esc(t.detail)}</div>` : ''}
    ${src}
    <div class="thread">${cmts}</div>
    <form class="add" onsubmit="return comment(event, ${t.id})">
      <input type="text" name="body" placeholder="Comment, or @claude for help…" autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </div>`;
}

async function render() {
  const tasks = await (await fetch('/api/tasks?status=' + status)).json();
  document.getElementById('list').innerHTML =
    tasks.length ? tasks.map(taskHtml).join('') : '<p>No tasks.</p>';
}

async function toggle(id, done) {
  await fetch('/api/tasks/' + id, { method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: done ? 'done' : 'open' }) });
  render();
}

async function comment(e, id) {
  e.preventDefault();
  const input = e.target.body;
  const body = input.value.trim();
  if (!body) return false;
  const ask = /@claude\b/i.test(body);
  input.value = '';
  await fetch('/api/tasks/' + id + '/comments', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'me', body, ask_agent: ask }) });
  render();
  return false;
}

document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  status = b.dataset.status;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  render();
});

render();
loadStatusBanner();
setInterval(() => { render(); loadStatusBanner(); }, 3000);
</script>
</body>
</html>
```

- [ ] **Step 2: Create `server.js`**

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import { openDb } from './src/store.js';
import { makeRouter } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(config.DB_PATH);

// runReply is wired in Task 6; until then commenting @claude simply records the comment.
let onCommentAgent = () => {};

const app = express();
app.use(express.json());
app.use(makeRouter(db, { onCommentAgent: (id) => onCommentAgent(id) }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`tasklist listening on http://${config.HOST}:${config.PORT}`);
});
```

- [ ] **Step 3: Start the server and verify the dashboard loads**

Run: `cd ~/projects/tasklist-agent && (node server.js & echo $! > /tmp/tl.pid); sleep 1; curl -s http://127.0.0.1:8787/ | grep -o '<title>tasklist</title>'; curl -s http://127.0.0.1:8787/api/tasks; kill $(cat /tmp/tl.pid)`
Expected: prints `<title>tasklist</title>` then `[]` (empty task list).

- [ ] **Step 4: Commit**

```bash
cd ~/projects/tasklist-agent
git add public/index.html server.js
git commit --no-gpg-sign -m "feat: dashboard page and server entry"
```

---

### Task 4: Agent spawner, prompts, and 30-minute ingest cron

**Files:**
- Create: `src/agent.js`, `src/prompts.js`, `src/cron.js`, `bin/stub-claude.js`
- Modify: `server.js` (wire `startSchedules`)
- Test: `test/integration.test.js`

**Interfaces:**
- Consumes: `store` (Task 1), `config` (Task 1).
- Produces:
  - `src/agent.js`: `spawnAgent(db, { kind, task_id=null, prompt, timeoutMs=300000 }) → Promise<{status:'ok'|'failed', log:string, runId:number}>`. Spawns `config.CLAUDE_BIN` with `['-p', prompt, '--output-format', 'json']`, env `{...process.env, SLACK_USER_TOKEN, DISCORD_WEBHOOK_URL, TASKLIST_API: config.API_BASE}`. Records a run row; kills child + marks `failed` on timeout.
  - `src/prompts.js`: `ingestPrompt({apiBase}) → string`, `replyPrompt({apiBase, task}) → string`, `digestPrompt({apiBase}) → string`.
  - `src/cron.js`: `startSchedules(db) → void`; also exports `runIngest(db) → Promise<void>` and `runDigest(db) → Promise<void>` (guarded by `acquireLock`).
  - `bin/stub-claude.js`: an executable Node script used as `CLAUDE_BIN` in tests. Reads the prompt from argv, and — mimicking a real run — uses `fetch` against `TASKLIST_API` to POST tasks/comments, then prints canned JSON to stdout.

- [ ] **Step 1: Create `bin/stub-claude.js`**

```js
#!/usr/bin/env node
// Test/dev stand-in for `claude -p`. Performs the API writes a real run would,
// driven by keywords in the prompt, then prints canned JSON.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const api = process.env.TASKLIST_API;

async function main() {
  if (/INGEST/.test(prompt)) {
    for (const t of [
      { title: 'Reply to Sam about launch', source_channel: 'C1', source_ts: '100.1', source_permalink: 'https://slack/x' },
      { title: 'Review PR 42', source_channel: 'C2', source_ts: '200.2' },
    ]) {
      await fetch(`${api}/api/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
    }
    process.stdout.write(JSON.stringify({ result: 'ingested 2' }));
  } else if (/REPLY task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/REPLY task_id=(\d+)/)[1];
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Here is my help on this task.' }) });
    process.stdout.write(JSON.stringify({ result: 'replied' }));
  } else if (/DIGEST/.test(prompt)) {
    process.stdout.write(JSON.stringify({ result: 'digest posted' }));
  } else {
    process.stdout.write(JSON.stringify({ result: 'noop' }));
  }
}
main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
```

Run: `chmod +x ~/projects/tasklist-agent/bin/stub-claude.js`
Expected: no output (exit 0).

- [ ] **Step 2: Create `src/prompts.js`**

```js
const SLACK_SCOPES = 'channels/groups/im/mpim:history, channels/groups/im/mpim:read, users:read, search:read';

export function ingestPrompt({ apiBase }) {
  return `INGEST — Slack → tasklist.
You have SLACK_USER_TOKEN in env (scopes: ${SLACK_SCOPES}) and the local API at ${apiBase}.
Use Bash + curl only. Do NOT use any Anthropic API.

Steps:
1. List my conversations:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200"
2. For each conversation id C, fetch recent messages:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.history?channel=C&limit=50"
   Also check mentions: search.messages?query=to:me OR your @handle.
3. Identify concrete action items directed at or owned by me (things I must DO or REPLY to).
   Skip pure FYI/noise.
4. For each action item, get a permalink:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/chat.getPermalink?channel=C&message_ts=TS"
5. POST each to the tasklist (server dedups by fingerprint — safe to re-post):
   curl -s -X POST ${apiBase}/api/tasks -H "content-type: application/json" \\
     -d '{"title":"...","detail":"...","source_channel":"C","source_ts":"TS","source_permalink":"URL","priority":2}'
Keep titles short and imperative. Output a one-line JSON summary at the end.`;
}

export function replyPrompt({ apiBase, task }) {
  return `REPLY task_id=${task.id}.
Fetch the task and its comment thread: curl -s ${apiBase}/api/tasks/${task.id}
The latest 'me' comment is my request. Help with THIS task only.
You may read Slack via SLACK_USER_TOKEN + curl (do NOT use any Anthropic API), draft messages, and reason.
When done, post your answer as an agent comment:
  curl -s -X POST ${apiBase}/api/tasks/${task.id}/comments -H "content-type: application/json" \\
    -d '{"author":"agent","body":"<your reply>"}'
Task title: ${task.title}`;
}

export function digestPrompt({ apiBase }) {
  return `DIGEST — daily summary.
Fetch open tasks: curl -s "${apiBase}/api/tasks?status=open"
Fetch done today: curl -s "${apiBase}/api/tasks?status=done"
Write a concise Discord-formatted digest (markdown, <1800 chars): what's open by priority,
what got done, and any Slack items that look urgent.
Post it to Discord:
  curl -s -X POST "$DISCORD_WEBHOOK_URL" -H "content-type: application/json" \\
    -d "$(jq -n --arg c "<digest text>" '{content:$c}')"
Do NOT use any Anthropic API. Output a one-line JSON summary.`;
}
```

- [ ] **Step 3: Create `src/agent.js`**

```js
import { spawn } from 'node:child_process';
import config from './config.js';
import { createRun, finishRun } from './store.js';

export function spawnAgent(db, { kind, task_id = null, prompt, timeoutMs = 300000 }) {
  const runId = createRun(db, { kind, task_id });
  return new Promise((resolve) => {
    const child = spawn(config.CLAUDE_BIN, ['-p', prompt, '--output-format', 'json'], {
      env: {
        ...process.env,
        SLACK_USER_TOKEN: config.SLACK_USER_TOKEN,
        DISCORD_WEBHOOK_URL: config.DISCORD_WEBHOOK_URL,
        // Read env at call time (not the cached config value) so tests that boot
        // an ephemeral-port server per case point the child at the right port.
        TASKLIST_API: process.env.TASKLIST_API || config.API_BASE,
      },
    });
    let out = '', err = '', done = false;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer);
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
```

- [ ] **Step 4: Create `src/cron.js`**

```js
import cron from 'node-cron';
import config from './config.js';
import { acquireLock, releaseLock } from './store.js';
import { spawnAgent } from './agent.js';
import { ingestPrompt, digestPrompt } from './prompts.js';

// Resolve at call time so tests can retarget the API per case (see agent.js note).
const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

export async function runIngest(db) {
  if (!acquireLock(db, 'ingest')) return;
  try { await spawnAgent(db, { kind: 'ingest', prompt: ingestPrompt({ apiBase: apiBase() }) }); }
  finally { releaseLock(db, 'ingest'); }
}

export async function runDigest(db) {
  if (!acquireLock(db, 'digest')) return;
  try { await spawnAgent(db, { kind: 'digest', prompt: digestPrompt({ apiBase: apiBase() }) }); }
  finally { releaseLock(db, 'digest'); }
}

export function startSchedules(db) {
  cron.schedule('*/30 * * * *', () => runIngest(db));
  cron.schedule('0 8 * * *', () => runDigest(db));
}
```

- [ ] **Step 5: Write the failing integration test `test/integration.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, listTasks, getTask } from '../src/store.js';
import { makeRouter } from '../src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, '..', 'bin', 'stub-claude.js');

async function bootFull() {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  // onCommentAgent wired in Task 6 test; here we only exercise ingest.
  app.use(makeRouter(db));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;
  return { db, server, base };
}

test('ingest via stubbed claude creates deduped tasks', async () => {
  const { db, server, base } = await bootFull();
  // Import after env is set so config picks up CLAUDE_BIN/TASKLIST_API.
  const { runIngest } = await import('../src/cron.js?ingest');
  await runIngest(db);
  await runIngest(db); // second run must not duplicate
  const tasks = listTasks(db, 'all');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.find((t) => t.title.includes('Sam')));
  server.close();
});
```

> Note: set `process.env.TASKLIST_API`/`CLAUDE_BIN` **before** the dynamic `import('../src/cron.js?...')` so the first `config` import reads them. Because `agent.js` and `cron.js` resolve `TASKLIST_API` at call time (not from cached `config.API_BASE`), each test's per-case env wins even though the `config` module is cached across tests in this file.

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd ~/projects/tasklist-agent && node --test test/integration.test.js`
Expected: FAIL — `Cannot find module '../src/cron.js'` (before Step 4 is committed) or agent-not-defined.

- [ ] **Step 7: Wire `startSchedules` into `server.js`**

Replace the `let onCommentAgent = () => {};` line and add the schedule start. Modify `server.js`:

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import { openDb } from './src/store.js';
import { makeRouter } from './src/routes.js';
import { startSchedules } from './src/cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(config.DB_PATH);

let onCommentAgent = () => {}; // replaced in Task 6

const app = express();
app.use(express.json());
app.use(makeRouter(db, { onCommentAgent: (id) => onCommentAgent(id) }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`tasklist listening on http://${config.HOST}:${config.PORT}`);
  startSchedules(db);
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/integration.test.js`
Expected: PASS — ingest creates exactly 2 tasks across two runs.

- [ ] **Step 9: Run the full suite**

Run: `cd ~/projects/tasklist-agent && npm test`
Expected: all test files PASS.

- [ ] **Step 10: Commit**

```bash
cd ~/projects/tasklist-agent
git add src/agent.js src/prompts.js src/cron.js bin/stub-claude.js server.js test/integration.test.js
git commit --no-gpg-sign -m "feat: claude -p agent spawner, prompts, and 30-min ingest cron"
```

---

### Task 5: launchd service, hostname, and setup/teardown scripts

**Files:**
- Create: `scripts/tasklist.plist.template`, `scripts/setup.sh`, `scripts/teardown.sh`
- Modify: `docs/superpowers/specs/...` — none

**Interfaces:**
- Consumes: `server.js` (Task 3/4). No test harness — verified manually (privileged system changes can't run in CI). Steps include exact verification commands.

- [ ] **Step 1: Create `scripts/tasklist.plist.template`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aaryan.tasklist</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__DIR__/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>__DIR__</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__DIR__/logs/out.log</string>
  <key>StandardErrorPath</key><string>__DIR__/logs/err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create `scripts/setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PORT="${PORT:-8787}"
PLIST="$HOME/Library/LaunchAgents/com.aaryan.tasklist.plist"

mkdir -p "$DIR/logs" "$DIR/data"

# 1. .env
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  echo "Created .env — fill in SLACK_USER_TOKEN and DISCORD_WEBHOOK_URL, then re-run."
fi

# 2. hosts entry (idempotent)
if ! grep -q "[[:space:]]tasklist$" /etc/hosts; then
  echo "127.0.0.1 tasklist" | sudo tee -a /etc/hosts >/dev/null
  echo "Added 'tasklist' to /etc/hosts"
fi

# 3. pf redirect 80 -> PORT (idempotent anchor)
ANCHOR="/etc/pf.anchors/tasklist"
echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port $PORT" | sudo tee "$ANCHOR" >/dev/null
if ! grep -q 'anchor "tasklist"' /etc/pf.conf; then
  echo 'anchor "tasklist"' | sudo tee -a /etc/pf.conf >/dev/null
  echo 'load anchor "tasklist" from "/etc/pf.anchors/tasklist"' | sudo tee -a /etc/pf.conf >/dev/null
fi
sudo pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
sudo pfctl -e >/dev/null 2>&1 || true

# 4. launchd agent
sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" "$DIR/scripts/tasklist.plist.template" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded launchd agent. Open http://tasklist (or http://tasklist:$PORT)."
```

Run: `chmod +x ~/projects/tasklist-agent/scripts/setup.sh`

- [ ] **Step 3: Create `scripts/teardown.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.aaryan.tasklist.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
sudo sed -i '' '/[[:space:]]tasklist$/d' /etc/hosts || true
sudo sed -i '' '\#anchor "tasklist"#d' /etc/pf.conf || true
sudo sed -i '' '\#load anchor "tasklist"#d' /etc/pf.conf || true
sudo rm -f /etc/pf.anchors/tasklist || true
sudo pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
echo "Removed tasklist launchd agent, hosts entry, and pf redirect."
```

Run: `chmod +x ~/projects/tasklist-agent/scripts/teardown.sh`

- [ ] **Step 4: Manual verification**

```bash
cd ~/projects/tasklist-agent
./scripts/setup.sh                 # fill .env if prompted, then re-run
sleep 2
curl -s http://tasklist/api/tasks  # or http://tasklist:8787/api/tasks
launchctl list | grep tasklist     # shows the agent with a PID
```
Expected: `curl` returns a JSON array; `launchctl list` shows `com.aaryan.tasklist` with a numeric PID (running).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tasklist-agent
git add scripts/
git commit --no-gpg-sign -m "feat: launchd service, tasklist hostname, setup/teardown"
```

**Phase 1 complete: dashboard + ingestion usable at http://tasklist.**

---

### Task 6: Agent replies (Phase 2)

**Files:**
- Modify: `server.js` (wire `onCommentAgent` to a real reply runner), `src/cron.js` (add `runReply`)
- Test: extend `test/integration.test.js`

**Interfaces:**
- Consumes: `spawnAgent` (Task 4), `replyPrompt` (Task 4), `getTask`/`acquireLock` (Task 1).
- Produces: `src/cron.js` gains `runReply(db, taskId) → Promise<void>` — guarded by a per-task lock `reply:<id>`, builds `replyPrompt`, spawns a `reply` run. `server.js` sets `onCommentAgent = (id) => runReply(db, id)`.

- [ ] **Step 1: Add `runReply` to `src/cron.js`**

Add these imports and function (keep existing content):

```js
import { getTask } from './store.js';
import { replyPrompt } from './prompts.js';

export async function runReply(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return;
  if (!acquireLock(db, `reply:${taskId}`)) return;
  try {
    await spawnAgent(db, { kind: 'reply', task_id: taskId, prompt: replyPrompt({ apiBase: apiBase(), task }) });
  } finally {
    releaseLock(db, `reply:${taskId}`);
  }
}
```

- [ ] **Step 2: Wire `onCommentAgent` in `server.js`**

Replace `let onCommentAgent = () => {};` and the import block:

```js
import { startSchedules, runReply } from './src/cron.js';
// ...
const onCommentAgent = (id) => runReply(db, id);
```

(Use `const` and pass `onCommentAgent` straight into `makeRouter(db, { onCommentAgent })`.)

- [ ] **Step 3: Extend `test/integration.test.js` with a reply test**

```js
test('commenting @claude spawns a reply run that posts an agent comment', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  const { runReply } = await import('../src/cron.js?reply');
  app.use(makeRouter(db, { onCommentAgent: (id) => runReply(db, id) }));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TASKLIST_API = base;
  process.env.CLAUDE_BIN = STUB;

  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Help me', source_channel: 'C1', source_ts: '1.1' }) })).json();
  await fetch(`${base}/api/tasks/${id}/comments`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'me', body: '@claude please help', ask_agent: true }) });

  // Poll until the agent comment lands (reply run is async).
  let t;
  for (let i = 0; i < 50; i++) {
    t = await (await fetch(`${base}/api/tasks/${id}`)).json();
    if (t.comments.some((c) => c.author === 'agent')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(t.comments.some((c) => c.author === 'agent'), 'agent comment posted');
  server.close();
});
```

- [ ] **Step 4: Run the reply test to verify it passes**

Run: `cd ~/projects/tasklist-agent && node --test test/integration.test.js`
Expected: PASS — both ingest and reply tests.

- [ ] **Step 5: Run full suite**

Run: `cd ~/projects/tasklist-agent && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/tasklist-agent
git add server.js src/cron.js test/integration.test.js
git commit --no-gpg-sign -m "feat: per-task agent replies via claude -p"
```

**Phase 2 complete: commenting @claude wakes Claude Code to respond in-thread.**

---

### Task 7: Daily Discord digest (Phase 3)

**Files:**
- Modify: none beyond what Task 4 already created (`runDigest` + `digestPrompt` + the `0 8 * * *` schedule already exist).
- Test: extend `test/integration.test.js` with a digest smoke test; add a manual live-webhook check.

**Interfaces:**
- Consumes: `runDigest` (Task 4), `digestPrompt` (Task 4).
- Produces: verified digest path. Real posting happens inside the `claude -p` run via `DISCORD_WEBHOOK_URL`; the stub verifies the run completes `ok`.

- [ ] **Step 1: Extend the stub to acknowledge digest (already handled)**

Confirm `bin/stub-claude.js` has the `DIGEST` branch (added in Task 4). No change needed if present.

- [ ] **Step 2: Add a digest smoke test to `test/integration.test.js`**

```js
test('digest run completes ok via stub', async () => {
  const db = openDb(':memory:');
  process.env.CLAUDE_BIN = STUB;
  process.env.TASKLIST_API = 'http://127.0.0.1:1'; // stub does not call it for DIGEST
  const { runDigest } = await import('../src/cron.js?digest');
  await runDigest(db);
  const { latestRun } = await import('../src/store.js');
  assert.equal(latestRun(db, 'digest').status, 'ok');
});
```

- [ ] **Step 3: Run the digest test**

Run: `cd ~/projects/tasklist-agent && node --test test/integration.test.js`
Expected: PASS.

- [ ] **Step 4: Manual live verification (real Discord + real Claude Code)**

```bash
cd ~/projects/tasklist-agent
# with a real .env (SLACK_USER_TOKEN, DISCORD_WEBHOOK_URL) and CLAUDE_BIN=claude:
node -e "import('./src/cron.js').then(async m => { const {openDb}=await import('./src/store.js'); await m.runDigest(openDb(process.env.DB_PATH||'./data/tasks.db')); })"
```
Expected: a formatted digest message appears in the target Discord channel within a couple of minutes.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/tasklist-agent
git add test/integration.test.js
git commit --no-gpg-sign -m "test: daily Discord digest smoke test"
```

**Phase 3 complete: morning digest posts to Discord.**

---

## Self-Review

**Spec coverage:**
- §2 architecture (Express + SQLite + `claude -p`) → Tasks 1–4. ✓
- §4 data model (tasks/comments/runs/meta, fingerprint, no-resurrect) → Task 1 + tests. ✓
- §5 API endpoints → Task 2. ✓
- §6.1 ingest 30-min + Slack scopes/contract → Task 4 (`prompts.js`, cron `*/30`). ✓
- §6.2 reply on demand → Task 6. ✓
- §6.3 daily digest → Tasks 4 (schedule) + 7 (verification). ✓
- §7 hostname (hosts + pf) → Task 5. ✓
- §8 launchd → Task 5. ✓
- §9 error handling (127.0.0.1 bind, gitignored .env, run logging, 5-min timeout, locks) → Tasks 1/3/4. ✓
- §10 testing (units + integration + stub `claude` + manual live) → Tasks 1–7. ✓
- §11 setup steps → Task 5 `setup.sh` + `.env.example` (Task 1). ✓
- §12 phases → Task grouping (P1: 1–5, P2: 6, P3: 7). ✓

**Placeholder scan:** No TBD/TODO left as work. The single `// replaced in Task 6` and `// wired in Task 6` markers in `server.js` are real, functioning no-op code (the app runs) that Task 6 explicitly rewrites — not placeholders.

**Type consistency:** `spawnAgent(db, {kind, task_id, prompt, timeoutMs})`, `runIngest/runDigest/runReply(db[, id])`, `makeRouter(db, {onCommentAgent})`, and all `store.js` signatures are used identically across Tasks 2, 4, 6, 7. Prompt keyword contract (`INGEST` / `REPLY task_id=N` / `DIGEST`) matches between `prompts.js` and `bin/stub-claude.js`.
