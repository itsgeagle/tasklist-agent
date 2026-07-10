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
    ['source_thread_ts', 'TEXT'], ['updated_by', "TEXT NOT NULL DEFAULT 'me'"],
  ]) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?`).get(col);
    if (!exists) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`);
  }
  for (const [col, def] of [
    ['cost_usd', 'REAL'], ['cost_estimated', 'INTEGER'],
    ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'],
    ['num_turns', 'INTEGER'], ['duration_ms', 'INTEGER'], ['model', 'TEXT'],
  ]) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info('runs') WHERE name = ?`).get(col);
    if (!exists) db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
  }
  return db;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function fingerprint(channel, ts, title) {
  // Titles are LLM-generated fresh on every ingest, so hashing them makes the
  // fingerprint non-deterministic across runs of the *same* Slack message —
  // that caused duplicate tasks and resurrected "done" items. Key on the
  // stable Slack identity (channel + ts) whenever ts is present; only fall
  // back to the title slug when there's no ts to anchor on.
  const base = ts ? `${channel}:${ts}` : `${channel}:${slug(title)}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

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

export function listTasks(db, status = 'open') {
  const q = status === 'all'
    ? 'SELECT * FROM tasks ORDER BY status, priority, updated_at DESC'
    : 'SELECT * FROM tasks WHERE status = ? ORDER BY priority, updated_at DESC';
  const rows = status === 'all' ? db.prepare(q).all() : db.prepare(q).all(status);
  for (const t of rows) {
    t.comments = listComments(db, t.id);
    t.active_run = activeRunForTask(db, t.id);
  }
  return rows;
}

export function getTask(db, id) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return null;
  t.comments = listComments(db, id);
  t.active_run = activeRunForTask(db, id);
  return t;
}

export function findOpenTaskByThread(db, threadTs) {
  if (!threadTs) return null;
  return db.prepare("SELECT * FROM tasks WHERE source_thread_ts = ? AND status = 'open' ORDER BY id LIMIT 1")
    .get(threadTs) || null;
}

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

export function addComment(db, taskId, author, body) {
  const info = db.prepare('INSERT INTO comments (task_id, author, body) VALUES (?, ?, ?)')
    .run(taskId, author, body);
  db.prepare("UPDATE tasks SET updated_at = datetime('now'), updated_by = ? WHERE id = ?").run(author, taskId);
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
}

export function listComments(db, taskId) {
  return db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(taskId);
}

export function createRun(db, { kind, task_id = null }) {
  return db.prepare('INSERT INTO runs (kind, task_id) VALUES (?, ?)').run(kind, task_id).lastInsertRowid;
}

export function finishRun(db, id, status, log, metrics = {}) {
  const m = metrics || {};
  db.prepare(`UPDATE runs SET status = ?, log = ?, finished_at = datetime('now'),
      cost_usd = ?, cost_estimated = ?, input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_write_tokens = ?, num_turns = ?, duration_ms = ?, model = ?
    WHERE id = ?`)
    .run(status, String(log || '').slice(0, 20000),
      m.cost_usd ?? null, m.cost_estimated ? 1 : 0,
      m.input_tokens ?? null, m.output_tokens ?? null,
      m.cache_read_tokens ?? null, m.cache_write_tokens ?? null,
      m.num_turns ?? null, m.duration_ms ?? null, m.model ?? null, id);
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
  } catch (err) {
    // Only a UNIQUE/PK violation means "lock already held" — that's the
    // expected contention case. Anything else (disk full, corruption, etc.)
    // must not be swallowed as a false "lock held".
    if (err.code?.startsWith('SQLITE_CONSTRAINT')) return false;
    throw err;
  }
}

export function releaseLock(db, key) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(`lock:${key}`);
}

// Reconcile persisted locks and orphaned runs left behind by a crash. A dead
// process between acquire/release leaves `lock:*` rows in `meta` forever
// (launchd KeepAlive just restarts us, it doesn't clear them), permanently
// blocking ingest/digest; likewise any `runs` row still 'running' at boot
// died mid-flight and should surface as a failure, not a stuck UI spinner.
// Store.js deliberately does NOT import worktree.js: that module pulls in
// config.js (env-driven CLAUDE_BIN/WORKTREE_DIR etc.), and store.js is
// statically imported very early (e.g. at the top of test files, before a
// test's boot() helper gets a chance to set CLAUDE_BIN for the run). Loading
// config.js that early froze CLAUDE_BIN on its default ('claude') instead of
// the test stub, hanging every agent-spawning test — confirmed by adding
// that import and watching diagnose never leave 'diagnosing'. So reconcile()
// only touches the DB here and returns the {repo_path, worktree_path} pairs
// that need cleaning; the caller (server.js, which already imports
// worktree.js for the dispatch/approve/cancel flows) does the actual
// filesystem cleanup right after calling reconcile() at boot.
export function reconcile(db) {
  db.prepare("DELETE FROM meta WHERE key LIKE 'lock:%'").run();
  db.prepare(
    "UPDATE runs SET status='failed', finished_at=datetime('now'), " +
    "log = COALESCE(log,'') || '[reconciled: interrupted at boot]' " +
    "WHERE status='running'"
  ).run();
  // A crash mid-diagnose/mid-execute leaves the task pinned in a transient
  // phase forever (nothing else ever transitions it out) and its worktree
  // still checked out on disk. Surface it as a failure and hand back what
  // needs reclaiming.
  const orphaned = db.prepare(
    "SELECT id, repo_id, worktree_path FROM tasks WHERE agent_phase IN ('diagnosing','executing')"
  ).all();
  const orphanedWorktrees = [];
  for (const t of orphaned) {
    const repo = t.repo_id ? getRepo(db, t.repo_id) : null;
    if (repo && t.worktree_path) orphanedWorktrees.push({ repo_path: repo.path, worktree_path: t.worktree_path });
    db.prepare("UPDATE tasks SET agent_phase='failed', updated_at=datetime('now') WHERE id = ?").run(t.id);
  }
  return { orphanedWorktrees };
}

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

export function usageToday(db) {
  const rows = db.prepare(`SELECT kind,
      COUNT(*) runs,
      COALESCE(SUM(cost_usd), 0) cost_usd,
      MAX(COALESCE(cost_estimated, 0)) cost_estimated,
      COALESCE(SUM(input_tokens), 0) input_tokens,
      COALESCE(SUM(output_tokens), 0) output_tokens
    FROM runs
    WHERE date(started_at) = date('now') AND status != 'skipped'
    GROUP BY kind`).all();
  const by_kind = {};
  const total = { runs: 0, cost_usd: 0, cost_estimated: 0, input_tokens: 0, output_tokens: 0 };
  for (const r of rows) {
    by_kind[r.kind] = r;
    total.runs += r.runs;
    total.cost_usd += r.cost_usd;
    total.input_tokens += r.input_tokens;
    total.output_tokens += r.output_tokens;
    total.cost_estimated = total.cost_estimated || r.cost_estimated;
  }
  return { by_kind, total, active: activeAgentRuns(db) };
}

export function usageByDay(db, days = 14) {
  const d = Math.max(1, Math.min(90, Number(days) || 14));
  return db.prepare(`SELECT date(started_at) date,
      COUNT(*) runs,
      COALESCE(SUM(cost_usd), 0) cost_usd,
      MAX(COALESCE(cost_estimated, 0)) cost_estimated,
      COALESCE(SUM(input_tokens), 0) input_tokens,
      COALESCE(SUM(output_tokens), 0) output_tokens
    FROM runs
    WHERE started_at >= datetime('now', ?) AND status != 'skipped'
    GROUP BY date(started_at) ORDER BY date(started_at)`).all(`-${d} days`);
}
