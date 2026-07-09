import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './src/config.js';
import { openDb, reconcile } from './src/store.js';
import { makeRouter } from './src/routes.js';
import { startSchedules, runReply } from './src/cron.js';
import { dispatch, approve, cancel } from './src/dispatch.js';
import { cleanupWorktree } from './src/worktree.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(config.DB_PATH);
// Clear any locks/running-runs left behind by a crash before we start
// accepting traffic or scheduling new work. reconcile() itself only touches
// the DB (see the comment on reconcile() in store.js for why); any tasks it
// found orphaned mid-diagnose/mid-execute get their worktrees reclaimed here.
const { orphanedWorktrees } = reconcile(db);
for (const { repo_path, worktree_path } of orphanedWorktrees) {
  try { cleanupWorktree(repo_path, worktree_path); }
  catch (e) { console.error('[boot] orphaned worktree cleanup failed', worktree_path, e); }
}

const onCommentAgent = (id) => runReply(db, id);
const onDispatch = (id, body) => dispatch(db, id, body);
const onApprove = (id, plan) => approve(db, id, { plan });
const onCancel = (id) => cancel(db, id);

const app = express();
app.use(express.json());
app.use(makeRouter(db, { onCommentAgent, onDispatch, onApprove, onCancel }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`tasklist listening on http://${config.HOST}:${config.PORT}`);
  startSchedules(db);
});
