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
export function reconcile(db) {
  db.prepare("DELETE FROM meta WHERE key LIKE 'lock:%'").run();
  db.prepare(
    "UPDATE runs SET status='failed', finished_at=datetime('now'), " +
    "log = COALESCE(log,'') || '[reconciled: interrupted at boot]' " +
    "WHERE status='running'"
  ).run();
}
