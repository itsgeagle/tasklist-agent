import config from './config.js';
import { getRepo, getTask, setAgentFields, acquireLock, releaseLock, activeAgentRuns, addComment } from './store.js';
import { spawnAgent } from './agent.js';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { MODES } from './agent-modes.js';

const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

export async function dispatch(db, taskId, opts) {
  try {
    await doDispatch(db, taskId, opts);
  } catch (e) {
    console.error('[dispatch] failed', e);
    try {
      if (getTask(db, taskId)) addComment(db, taskId, 'system', 'Dispatch error: ' + String((e && e.message) || e));
    } catch (e2) {
      console.error('[dispatch] failed to record error comment', e2);
    }
  }
}

async function doDispatch(db, taskId, { repo_id, base_branch, mode = 'code' } = {}) {
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
