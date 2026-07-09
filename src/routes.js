import express from 'express';
import * as store from './store.js';
import { validateRepo } from './repos.js';

const JOBS = ['ingest', 'digest'];

export function makeRouter(db, { onCommentAgent, onDispatch, onApprove, onCancel, onRunJob } = {}) {
  const r = express.Router();

  // Manually trigger a scheduled job. runIngest/runDigest each take a lock and
  // no-op if that job is already in flight, so this is safe against a concurrent
  // scheduled run or a double-click. Fire-and-forget like dispatch/reply.
  r.post('/api/run/:job', (req, res) => {
    const { job } = req.params;
    if (!JOBS.includes(job)) return res.status(400).json({ error: 'unknown job' });
    if (onRunJob) setImmediate(() => Promise.resolve(onRunJob(job)).catch((e) => console.error('[onRunJob] failed', e)));
    res.json({ ok: true });
  });

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
    if (wantsAgent && onCommentAgent) setImmediate(() => Promise.resolve(onCommentAgent(id)).catch((e) => console.error('[onCommentAgent] failed', e)));
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

  r.post('/api/tasks/:id/dispatch', (req, res) => {
    const id = Number(req.params.id);
    const task = store.getTask(db, id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.agent_phase && !['idle', 'done', 'failed'].includes(task.agent_phase))
      return res.status(409).json({ error: 'agent already active on this task' });
    const { repo_id, base_branch, mode } = req.body || {};
    if (!repo_id) return res.status(400).json({ error: 'repo_id required' });
    if (!Number.isInteger(Number(repo_id))) return res.status(400).json({ error: 'repo_id must be an integer' });
    if (onDispatch) setImmediate(() => Promise.resolve(onDispatch(id, { repo_id: Number(repo_id), base_branch, mode })).catch((e) => console.error('[onDispatch] failed', e)));
    res.json({ ok: true });
  });

  r.post('/api/tasks/:id/approve', (req, res) => {
    const id = Number(req.params.id);
    const task = store.getTask(db, id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.agent_phase !== 'awaiting_approval') return res.status(409).json({ error: 'not awaiting approval' });
    if (onApprove) setImmediate(() => Promise.resolve(onApprove(id, (req.body || {}).plan)).catch((e) => console.error('[onApprove] failed', e)));
    res.json({ ok: true });
  });

  r.post('/api/tasks/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getTask(db, id)) return res.status(404).json({ error: 'not found' });
    if (onCancel) {
      try { onCancel(id); } catch (e) { console.error('[onCancel] failed', e); }
    }
    res.json({ ok: true });
  });

  r.get('/api/usage', async (_req, res) => {
    // Import config lazily so requiring this router (e.g. in tests, before
    // CLAUDE_BIN is set) doesn't eagerly evaluate config.js's env capture.
    const { default: config } = await import('./config.js');
    res.json({ today: store.agentRunsToday(db), active: store.activeAgentRuns(db), cap: config.MAX_AGENT_CONCURRENCY });
  });

  return r;
}
