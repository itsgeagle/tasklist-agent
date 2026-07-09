import express from 'express';
import * as store from './store.js';
import { validateRepo } from './repos.js';

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

  return r;
}
