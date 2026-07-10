import express from 'express';
import * as store from './store.js';
import * as runbus from './runbus.js';
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

  // Live trace of a run via Server-Sent Events. Replays the current buffer, then
  // streams events until the run ends or the client disconnects.
  r.get('/api/runs/:kind/stream', (req, res) => {
    const { kind } = req.params;
    if (!JOBS.includes(kind)) return res.status(400).json({ error: 'unknown kind' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    let closed = false;
    let unsub = () => {};
    const send = (ev) => { if (!closed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, 15000);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(hb); unsub(); try { res.end(); } catch { /* already gone */ } };
    req.on('close', cleanup);
    // subscribe() replays the buffer synchronously; if that buffer already ends
    // the run, cleanup() runs here with unsub still a no-op — so drop the just-
    // added subscriber afterwards.
    unsub = runbus.subscribe(kind, (ev) => { send(ev); if (ev.t === 'end') cleanup(); });
    if (closed) unsub();
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

  r.get('/api/meta/ingest_hwm', (_req, res) => {
    res.json({ value: store.getMeta(db, 'ingest_hwm') });
  });

  r.put('/api/meta/ingest_hwm', (req, res) => {
    const { value } = req.body || {};
    if (value == null) return res.status(400).json({ error: 'value required' });
    store.setMeta(db, 'ingest_hwm', value);
    res.json({ value: store.getMeta(db, 'ingest_hwm') });
  });

  r.post('/api/tasks/:id/comments', (req, res) => {
    const id = Number(req.params.id);
    if (!store.getTask(db, id)) return res.status(404).json({ error: 'not found' });
    const { author = 'me', body = '', ask_agent = false, updated_by } = req.body || {};
    const c = store.addComment(db, id, updated_by || author, body);
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
    // Lazy import so requiring this router in tests (before CLAUDE_BIN is set)
    // doesn't eagerly evaluate config.js's env capture.
    const { default: config } = await import('./config.js');
    const today = store.usageToday(db);
    const daily = config.DAILY_BUDGET;
    const over = daily > 0 && today.total.cost_usd > daily;
    res.json({ today, budget: { daily_usd: daily, over }, active: today.active, cap: config.MAX_AGENT_CONCURRENCY });
  });

  r.get('/api/usage/history', (req, res) => {
    res.json(store.usageByDay(db, req.query.days));
  });

  return r;
}
