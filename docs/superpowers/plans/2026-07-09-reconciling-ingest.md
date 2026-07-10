# Reconciling Incremental Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ingest scan only what's new since the last run and reconcile it against the existing tasklist — folding updates into existing tasks, marking completions done, closing tasks whose PRs merged, and recording when/by-whom each task last changed.

**Architecture:** Ingest correlates new Slack messages to existing tasks thread-first (Slack `thread_ts` → `tasks.source_thread_ts`), with LLM judgment as fallback. A global high-water-mark in `meta['ingest_hwm']` bounds the fetch window (`oldest = HWM − overlap`). The reconcile logic itself lives in the ingest *prompt* (the agent does the judgment); our code provides the machinery: schema columns, a thread-lookup helper, an actor (`updated_by`) field on every mutation, and watermark endpoints.

**Tech Stack:** Node.js (ESM, `>=18`), better-sqlite3, Express, `node --test` (node:test + node:assert/strict). No new dependencies.

## Global Constraints

- Node ESM only (`"type": "module"`); import with explicit `.js` extensions.
- Test runner is `node --test`; tests use `node:test` + `node:assert/strict`.
- `openDb(':memory:')` for store/API tests; the claude stub is `bin/stub-claude.js`, selected via `process.env.CLAUDE_BIN`.
- Schema migrations use the existing idempotent `ALTER TABLE` loop in `openDb` — never a destructive migration.
- The ingest agent uses `SLACK_USER_TOKEN` + `curl` + `gh` only; it must NOT call any Anthropic API and must NOT rely on `jq`.
- **Every `git commit` MUST pass `--no-gpg-sign`.**
- Actor (`updated_by`) vocabulary is exactly: `me` | `slack` | `agent`.
- Merged-PR tasks land in the existing `done` status — do NOT introduce a `closed` status.

---

### Task 1: Schema — thread anchor & actor columns + thread lookup

**Files:**
- Modify: `src/store.js` (the `ALTER TABLE` loop at lines 49-55; `upsertTask` at 73-87; add `findOpenTaskByThread`)
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: existing `openDb`, `upsertTask`, `listTasks`, `getTask`, `patchTask`.
- Produces:
  - `tasks.source_thread_ts TEXT`, `tasks.updated_by TEXT DEFAULT 'me'` columns.
  - `upsertTask(db, t)` now also persists `t.source_thread_ts` (nullable) and sets `updated_by` to `t.updated_by || 'slack'` on insert.
  - `findOpenTaskByThread(db, threadTs) -> task | null` — the open task whose `source_thread_ts` equals `threadTs`; `null` if none or if `threadTs` is falsy.

- [ ] **Step 1: Write the failing tests**

Add to `test/store.test.js` (extend the import on lines 3-5 to include `findOpenTaskByThread`):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `findOpenTaskByThread is not a function` / `source_thread_ts` is `undefined`.

- [ ] **Step 3: Implement the schema + store changes**

In `src/store.js`, extend the column loop (currently lines 49-55) to add the two columns:

```javascript
  for (const [col, def] of [
    ['repo_id', 'INTEGER'], ['agent_mode', 'TEXT'], ['base_branch', 'TEXT'],
    ['agent_phase', "TEXT NOT NULL DEFAULT 'idle'"], ['worktree_path', 'TEXT'], ['pr_url', 'TEXT'],
    ['source_thread_ts', 'TEXT'], ['updated_by', "TEXT NOT NULL DEFAULT 'me'"],
  ]) {
```

Replace `upsertTask` (lines 73-87) so it persists the thread anchor and actor:

```javascript
export function upsertTask(db, t) {
  const fp = fingerprint(t.source_channel || '', t.source_ts || '', t.title);
  const existing = db.prepare('SELECT * FROM tasks WHERE fingerprint = ?').get(fp);
  if (existing) return { id: existing.id, created: false };
  const info = db.prepare(`INSERT INTO tasks
    (title, detail, source_channel, source_ts, source_thread_ts, source_permalink, fingerprint, priority, updated_by)
    VALUES (@title, @detail, @source_channel, @source_ts, @source_thread_ts, @source_permalink, @fp, @priority, @updated_by)`)
    .run({
      title: t.title, detail: t.detail || '',
      source_channel: t.source_channel || null, source_ts: t.source_ts || null,
      source_thread_ts: t.source_thread_ts || null,
      source_permalink: t.source_permalink || null, fp,
      priority: t.priority ?? 2,
      updated_by: t.updated_by || 'slack',
    });
  return { id: info.lastInsertRowid, created: true };
}
```

Add `findOpenTaskByThread` (place it right after `getTask`, ~line 102):

```javascript
export function findOpenTaskByThread(db, threadTs) {
  if (!threadTs) return null;
  return db.prepare("SELECT * FROM tasks WHERE source_thread_ts = ? AND status = 'open' ORDER BY id LIMIT 1")
    .get(threadTs) || null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (all store tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit --no-gpg-sign -m "feat(store): thread anchor + updated_by columns, findOpenTaskByThread"
```

---

### Task 2: Store — record actor on `patchTask` and `addComment`

**Files:**
- Modify: `src/store.js` (`patchTask` at lines 104-113; `addComment` at 115-120)
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `upsertTask`, `getTask` from Task 1.
- Produces:
  - `patchTask(db, id, fields)` — if `fields.updated_by` is present it is written to the `updated_by` column; otherwise `updated_by` defaults to `'me'` whenever any field changes.
  - `addComment(db, taskId, author, body)` — bumps the parent task's `updated_by` to `author` (alongside the existing `updated_at` bump).

- [ ] **Step 1: Write the failing tests**

Add to `test/store.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `updated_by` is still `'me'`/unchanged where the tests expect `'slack'`.

- [ ] **Step 3: Implement**

Replace `patchTask` (lines 104-113) so `updated_by` is part of the write:

```javascript
export function patchTask(db, id, fields) {
  const allowed = ['status', 'title', 'detail', 'priority', 'pr_url', 'updated_by'];
  const sets = allowed.filter((k) => k in fields);
  if (sets.length) {
    if (!('updated_by' in fields)) { fields = { ...fields, updated_by: 'me' }; sets.push('updated_by'); }
    const clause = sets.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE tasks SET ${clause}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...fields, id });
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;
}
```

Replace `addComment` (lines 115-120) so it also stamps the actor:

```javascript
export function addComment(db, taskId, author, body) {
  const info = db.prepare('INSERT INTO comments (task_id, author, body) VALUES (?, ?, ?)')
    .run(taskId, author, body);
  db.prepare("UPDATE tasks SET updated_at = datetime('now'), updated_by = ? WHERE id = ?").run(author, taskId);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit --no-gpg-sign -m "feat(store): stamp updated_by on patchTask and addComment"
```

---

### Task 3: API — `updated_by` passthrough + watermark endpoints

**Files:**
- Modify: `src/routes.js` (`POST /api/tasks/:id/comments` at 63-71; `PATCH /api/tasks/:id` at 57-61; add two `/api/meta/ingest_hwm` routes)
- Test: `test/integration.test.js`

**Interfaces:**
- Consumes: `store.addComment`, `store.patchTask` (Task 2), `store.getMeta`, `store.setMeta` (existing, lines 143-151).
- Produces:
  - `PATCH /api/tasks/:id` accepts optional `updated_by` in the body (defaults to `me` via `patchTask`).
  - `POST /api/tasks/:id/comments` accepts optional `updated_by`; when present it is passed to `addComment` as the author-of-record for the task stamp. (Body shape: `{ author, body, ask_agent, updated_by }`.)
  - `GET /api/meta/ingest_hwm` → `{ value: string | null }`.
  - `PUT /api/meta/ingest_hwm` with `{ value }` → `{ value }` (persisted).

- [ ] **Step 1: Write the failing tests**

Add to `test/integration.test.js`:

```javascript
test('meta watermark round-trips and PATCH accepts updated_by', async () => {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(makeRouter(db));
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // watermark starts null, then round-trips
  let hwm = await (await fetch(`${base}/api/meta/ingest_hwm`)).json();
  assert.equal(hwm.value, null);
  await fetch(`${base}/api/meta/ingest_hwm`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '200.5' }) });
  hwm = await (await fetch(`${base}/api/meta/ingest_hwm`)).json();
  assert.equal(hwm.value, '200.5');

  // PATCH carries updated_by through to the row
  const { id } = await (await fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'T', source_channel: 'C1', source_ts: '1.1' }) })).json();
  const patched = await (await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done', updated_by: 'slack' }) })).json();
  assert.equal(patched.updated_by, 'slack');
  server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/integration.test.js`
Expected: FAIL — `/api/meta/ingest_hwm` 404s (route not defined).

- [ ] **Step 3: Implement the routes**

In `src/routes.js`, replace the comments route (lines 63-71) so `updated_by` overrides the stamp author:

```javascript
  r.post('/api/tasks/:id/comments', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getTask(db, id)) return res.status(404).json({ error: 'not found' });
    const { author = 'me', body = '', ask_agent = false, updated_by } = req.body || {};
    const c = store.addComment(db, id, updated_by || author, body);
    const wantsAgent = ask_agent || (author === 'me' && /@claude\b/i.test(body));
    if (wantsAgent && onCommentAgent) setImmediate(() => Promise.resolve(onCommentAgent(id)).catch((e) => console.error('[onCommentAgent] failed', e)));
    res.json(c);
  });
```

Note: `patchTask` already reads `updated_by` from the body (Task 2), so the existing `PATCH` route at lines 57-61 needs no change.

Add the watermark routes (place them right after the `PATCH /api/tasks/:id` route, ~line 61):

```javascript
  r.get('/api/meta/ingest_hwm', (_req, res) => {
    res.json({ value: store.getMeta(db, 'ingest_hwm') });
  });

  r.put('/api/meta/ingest_hwm', (req, res) => {
    const { value } = req.body || {};
    if (value == null) return res.status(400).json({ error: 'value required' });
    store.setMeta(db, 'ingest_hwm', value);
    res.json({ value: store.getMeta(db, 'ingest_hwm') });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/integration.test.js`
Expected: PASS (new test plus all existing integration tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes.js test/integration.test.js
git commit --no-gpg-sign -m "feat(api): updated_by passthrough on comments + ingest_hwm meta endpoints"
```

---

### Task 4: Config knobs + reconcile-oriented ingest prompt

**Files:**
- Modify: `src/config.js` (add two knobs after line 28)
- Modify: `src/prompts.js` (`ingestPrompt` at lines 19-50)
- Modify: `src/cron.js` (`runIngest` at lines 10-14 — pass the knobs)
- Test: `test/prompts.test.js` (create)

**Interfaces:**
- Consumes: `loadContext` (existing, `src/prompts.js:9`), `config` knobs.
- Produces:
  - `config.INGEST_OVERLAP_MS` (default `600000`), `config.INGEST_BOOTSTRAP_MS` (default `604800000` = 7 days).
  - `ingestPrompt({ apiBase, overlapMs, bootstrapMs })` — returns the reconcile prompt string. It instructs the agent to: read `ingest_hwm` + open tasks, fetch the window with `oldest`, correlate thread-first then LLM-fallback, post updates as `slack` comments, mark completions done, run a `gh pr view` merged-PR sweep, and advance the watermark.

- [ ] **Step 1: Write the failing test**

Create `test/prompts.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestPrompt } from '../src/prompts.js';

test('ingest prompt drives incremental reconcile, not blind insert', () => {
  const p = ingestPrompt({ apiBase: 'http://api', overlapMs: 600000, bootstrapMs: 604800000 });
  // incremental: reads + advances the watermark
  assert.match(p, /ingest_hwm/);
  assert.match(p, /oldest=/);
  // reconcile against existing tasks
  assert.match(p, /status=open/);
  assert.match(p, /thread_ts/);
  // the four outcomes
  assert.match(p, /updated_by":\s*"slack"|updated_by":"slack"/);
  assert.match(p, /status":\s*"done"|status":"done"/);
  assert.match(p, /gh pr view/);
  // must stay off the Anthropic API
  assert.match(p, /do NOT use any Anthropic API/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prompts.test.js`
Expected: FAIL — current `ingestPrompt` has none of `ingest_hwm`, `gh pr view`, `oldest=`.

- [ ] **Step 3: Add config knobs**

In `src/config.js`, add after line 28 (the `DIGEST_TIMEOUT_MS` line, inside the exported object):

```javascript
  // Incremental ingest: re-scan this far below the high-water-mark to catch
  // edits/boundary messages (dedup absorbs the overlap). Bootstrap window is
  // used only on the very first run, when no high-water-mark exists yet.
  INGEST_OVERLAP_MS: Number(process.env.INGEST_OVERLAP_MS || 600000),
  INGEST_BOOTSTRAP_MS: Number(process.env.INGEST_BOOTSTRAP_MS || 604800000),
```

- [ ] **Step 4: Rewrite `ingestPrompt`**

Replace `ingestPrompt` (lines 19-50) in `src/prompts.js`:

```javascript
export function ingestPrompt({ apiBase, overlapMs = 600000, bootstrapMs = 604800000 }) {
  const overlapSec = Math.round(overlapMs / 1000);
  const bootstrapSec = Math.round(bootstrapMs / 1000);
  return `INGEST — Slack → tasklist (incremental reconcile).
You have SLACK_USER_TOKEN in env (scopes: ${SLACK_SCOPES}) and the local API at ${apiBase}.
Use Bash + curl + gh only. Do NOT use any Anthropic API. Do NOT use jq — build JSON with python3.

WHO I AM / WHAT'S RELEVANT TO ME (use this to judge what to surface):
${loadContext()}

GOAL: look only at what's NEW since the last run and reconcile it against the
existing tasklist — new items become tasks, updates fold into the task they
belong to, completed things get marked done, and tasks whose PR merged get closed.

Steps:
1. Read state:
   - High-water-mark: curl -s ${apiBase}/api/meta/ingest_hwm  → {"value": "<slack ts>" | null}.
     Compute the fetch floor OLDEST = (value − ${overlapSec}s overlap) if value is set,
     else now − ${bootstrapSec}s (first-run bootstrap). Slack ts is unix seconds with a
     ".xxxxxx" suffix; do the arithmetic on the integer-seconds part with python3.
   - Open tasks: curl -s "${apiBase}/api/tasks?status=open" — this is what you reconcile against.
     Note each task's id, source_thread_ts, and pr_url.
2. List my conversations:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200"
3. For each conversation id C, fetch only new messages:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.history?channel=C&oldest=OLDEST&limit=200"
   For any thread that saw new activity, also pull replies:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.replies?channel=C&ts=THREAD_TS&oldest=OLDEST"
4. Select messages RELEVANT TO ME (relevance is broader than a direct @-mention):
   a. Direct @-mentions of me, and DMs to me.
   b. @channel / @here / @everyone announcements in channels I'm a member of.
   c. Messages in my areas of responsibility per the context above (decisions,
      blockers, incidents, requests, questions in my domain) even when untagged.
   Skip pure FYI/social/bot noise and things fully owned by someone else.
5. RECONCILE each relevant message. Each Slack message has a thread_ts (its own ts
   if it is a thread root). Decide where it belongs:
   a. THREAD MATCH — its thread_ts equals an open task's source_thread_ts:
      it is an UPDATE to that task. Post it as a comment (this records who/when):
        curl -s -X POST ${apiBase}/api/tasks/ID/comments -H "content-type: application/json" \\
          --data "$(python3 -c 'import json,sys;print(json.dumps({"author":"slack","updated_by":"slack","body":sys.argv[1]}))' "<what changed>")"
      If the message signals I FINISHED the task (e.g. "done", "shipped", "merged",
      "thanks, closing"), also mark it done:
        curl -s -X PATCH ${apiBase}/api/tasks/ID -H "content-type: application/json" \\
          -d '{"status":"done","updated_by":"slack"}'
   b. NO THREAD MATCH — judge whether it relates to an existing open task by meaning.
      If yes, treat it as an UPDATE exactly as in (a) against that task's id.
      If no, it is NEW — create a task (carry the thread anchor so future replies
      fold in). Get a permalink first:
        curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/chat.getPermalink?channel=C&message_ts=TS"
        curl -s -X POST ${apiBase}/api/tasks -H "content-type: application/json" \\
          --data "$(python3 -c 'import json,sys;print(json.dumps({"title":sys.argv[1],"detail":sys.argv[2],"source_channel":sys.argv[3],"source_ts":sys.argv[4],"source_thread_ts":sys.argv[5],"source_permalink":sys.argv[6],"priority":int(sys.argv[7])}))' "TITLE" "DETAIL" "C" "TS" "THREAD_TS" "URL" "2")"
      Set priority by type: things I must DO or REPLY to = 1; things to just be
      AWARE of = 3; default 2. Keep titles short and imperative.
6. PR-MERGE SWEEP — for every open task that has a pr_url, check if it merged:
     gh pr view <pr_url> --json state,mergedAt
   If merged (mergedAt is non-null / state MERGED), close it:
     curl -s -X POST ${apiBase}/api/tasks/ID/comments -H "content-type: application/json" \\
       -d '{"author":"slack","updated_by":"slack","body":"PR merged — closing."}'
     curl -s -X PATCH ${apiBase}/api/tasks/ID -H "content-type: application/json" \\
       -d '{"status":"done","updated_by":"slack"}'
   Skip tasks whose pr_url is a local-branch placeholder (no real PR to query).
7. Advance the high-water-mark to the largest Slack ts you saw this run:
   curl -s -X PUT ${apiBase}/api/meta/ingest_hwm -H "content-type: application/json" \\
     --data "$(python3 -c 'import json,sys;print(json.dumps({"value":sys.argv[1]}))' "<max ts>")"
Output a one-line JSON summary at the end: {"new":N,"updated":N,"completed":N,"closed":N}.`;
}
```

- [ ] **Step 5: Wire the knobs through `runIngest`**

In `src/cron.js`, replace `runIngest` (lines 10-14):

```javascript
export async function runIngest(db) {
  if (!acquireLock(db, 'ingest')) return;
  try {
    await spawnAgent(db, {
      kind: 'ingest',
      prompt: ingestPrompt({
        apiBase: apiBase(),
        overlapMs: config.INGEST_OVERLAP_MS,
        bootstrapMs: config.INGEST_BOOTSTRAP_MS,
      }),
      timeoutMs: config.INGEST_TIMEOUT_MS,
    });
  } finally { releaseLock(db, 'ingest'); }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/prompts.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/prompts.js src/cron.js test/prompts.test.js
git commit --no-gpg-sign -m "feat(ingest): reconcile-oriented prompt with watermark + PR-merge sweep"
```

---

### Task 5: Stub + integration coverage for the reconcile flow

**Files:**
- Modify: `bin/stub-claude.js` (the `INGEST` branch, lines 22-34)
- Test: `test/integration.test.js`

**Interfaces:**
- Consumes: the reconcile API paths from Tasks 2-3 (`POST /comments` with `updated_by:"slack"`, `PATCH status:"done"`), `runIngest` from Task 4.
- Produces: an INGEST stub that, in addition to creating its two sample tasks, simulates the agent's reconcile tool-calls against whatever open tasks already exist: posts a `slack` comment to any open task that has a `source_thread_ts`, and marks done any open task that has a non-placeholder `pr_url`. This keeps the existing "creates 2 deduped tasks" test green (it starts empty → nothing to reconcile) while making the new behavior observable.

- [ ] **Step 1: Write the failing test**

Add to `test/integration.test.js`:

```javascript
test('ingest reconciles: thread task gets a slack update, merged-PR task closes', async () => {
  const { db, server, base } = await bootFull();
  const mk = (t) => fetch(`${base}/api/tasks`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) })
    .then((r) => r.json());

  const threaded = await mk({ title: 'Launch thread', source_channel: 'C9', source_ts: 'T9', source_thread_ts: 'T9' });
  const merged = await mk({ title: 'Ship fix', source_channel: 'C8', source_ts: '8.8' });
  await fetch(`${base}/api/tasks/${merged.id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7' }) });

  const { runIngest } = await import('../src/cron.js?reconcile');
  await runIngest(db);

  const threadedTask = getTask(db, threaded.id);
  assert.ok(threadedTask.comments.some((c) => c.author === 'slack'), 'thread task got a slack update');
  assert.equal(threadedTask.updated_by, 'slack');

  const mergedTask = getTask(db, merged.id);
  assert.equal(mergedTask.status, 'done', 'merged-PR task was closed');
  assert.equal(mergedTask.updated_by, 'slack');
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration.test.js`
Expected: FAIL — the stub does not reconcile; the thread task has no `slack` comment and the PR task is still `open`.

- [ ] **Step 3: Update the stub's INGEST branch**

In `bin/stub-claude.js`, replace the `if (/INGEST/.test(prompt)) { ... }` block (lines 22-34) with a version that reconciles existing open tasks first, then creates its samples:

```javascript
  if (/INGEST/.test(prompt)) {
    tool(`curl ${api}/api/tasks?status=open`);
    const open = await (await fetch(`${api}/api/tasks?status=open`)).json();
    toolResult(JSON.stringify(open));
    for (const t of open) {
      // simulate a merged-PR sweep: a real (non-placeholder) pr_url → close
      if (t.pr_url && !String(t.pr_url).startsWith('local-branch:')) {
        await fetch(`${api}/api/tasks/${t.id}/comments`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: 'slack', updated_by: 'slack', body: 'PR merged — closing.' }) });
        await fetch(`${api}/api/tasks/${t.id}`, { method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'done', updated_by: 'slack' }) });
      } else if (t.source_thread_ts) {
        // simulate a thread update folding into the existing task
        await fetch(`${api}/api/tasks/${t.id}/comments`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: 'slack', updated_by: 'slack', body: 'New reply in this thread.' }) });
      }
    }
    for (const t of [
      { title: 'Reply to Sam about launch', source_channel: 'C1', source_ts: '100.1', source_permalink: 'https://slack/x' },
      { title: 'Review PR 42', source_channel: 'C2', source_ts: '200.2' },
    ]) {
      tool(`curl -XPOST ${api}/api/tasks -d '${t.title}'`);
      await fetch(`${api}/api/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
      toolResult('created');
    }
    result('ingested 2');
  } else if (/REPLY task_id=(\d+)/.test(prompt)) {
```

(Only the `INGEST` branch changes; leave the `REPLY`/`DIGEST`/`DIAGNOSE`/`EXECUTE`/`else` branches exactly as they are.)

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: PASS — the new reconcile test passes, and the existing "creates 2 deduped tasks" test still sees exactly 2 tasks (it boots empty, so the reconcile loop is a no-op on the first run; the second run finds the 2 created tasks but neither has a `source_thread_ts` or real `pr_url`, so nothing changes).

- [ ] **Step 5: Commit**

```bash
git add bin/stub-claude.js test/integration.test.js
git commit --no-gpg-sign -m "test(ingest): stub + integration coverage for thread-update and PR-close reconcile"
```

---

### Task 6: UI — show "updated {time} · by {who}"

**Files:**
- Modify: `public/index.html` (`taskHtml` at lines 134-169)
- Test: manual (static HTML, no JS test harness in this repo)

**Interfaces:**
- Consumes: `t.updated_at` and `t.updated_by` (now present on every task via Tasks 1-2).
- Produces: a metadata line rendered under each task's source line.

- [ ] **Step 1: Add the meta line to `taskHtml`**

In `public/index.html`, inside `taskHtml` (after the `const src = ...` line at 137), add:

```javascript
  const who = esc(t.updated_by || 'me');
  const when = t.updated_at ? esc(t.updated_at.slice(11, 16)) : '';
  const meta = `<div class="meta ${who}">updated ${when} · by ${who}</div>`;
```

Then render it in the returned template — change the line that currently reads `${src}` (line 161) to:

```javascript
    ${src}${meta}
```

- [ ] **Step 2: Add styling for the actor**

In the `<style>` block of `public/index.html`, add a rule (near the existing `.cmt`/`.src` rules):

```css
    .meta { font-size: 11px; opacity: .6; margin: 2px 0; }
    .meta.slack { color: #4a90d9; }
    .meta.agent { color: #7c5cbf; }
```

- [ ] **Step 3: Verify manually**

Run the app and load the tasklist:

```bash
node server.js
```

Expected: each task shows an "updated HH:MM · by me/slack/agent" line; ingest-touched tasks read "by slack", agent-touched read "by agent". Confirm the page renders without a console error.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit --no-gpg-sign -m "feat(ui): show last-updated time and actor per task"
```

---

## Self-Review

**Spec coverage:**
- Incremental "since last run" → Task 4 (watermark read/advance) + Task 3 (endpoints) + Task 1 (implicit). ✓
- Update to existing task posted as such → Task 4 (thread-match/LLM-fallback → `slack` comment) + Task 1 (`findOpenTaskByThread`, thread anchor) + Task 2 (`addComment` stamps actor). ✓
- Completion → marked done → Task 4 (completion signal → `PATCH done`). ✓
- New tasks populated → Task 4 (no-match → `POST /api/tasks` with thread anchor) + Task 1 (`upsertTask` persists it). ✓
- Last-updated + by whom → Task 2 (store stamps `updated_by`) + Task 3 (API passthrough) + Task 6 (UI line). ✓
- PR merged → close → Task 4 (`gh pr view` sweep → `PATCH done`) + Task 5 (stub/integration proof). ✓
- Watermark strategy = global HWM w/ overlap → Task 3 (`meta` endpoints) + Task 4 (`INGEST_OVERLAP_MS`/`INGEST_BOOTSTRAP_MS`, `oldest` arithmetic). ✓
- Correlation = thread-primary, LLM-fallback → Task 4 step 5(a)/(b). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:** `findOpenTaskByThread` used consistently (Tasks 1); `updated_by` string vocabulary (`me`/`slack`/`agent`) consistent across store, API, prompt, stub, UI; `source_thread_ts` column name consistent (store insert, `findOpenTaskByThread`, prompt payload, stub, integration seed); watermark key `ingest_hwm` consistent (store meta, API routes, prompt). ✓

**Note on TDD ordering:** Tasks 1-3 and 5 are strict red→green. Task 4's prompt-content test is a guard that the reconcile instructions are present (the LLM judgment itself isn't unit-testable); the real behavioral proof is Task 5's stub-driven integration test. Task 6 (static HTML) is manually verified — this repo has no DOM test harness.
