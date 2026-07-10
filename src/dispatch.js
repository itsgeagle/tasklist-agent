import config from './config.js';
import { getRepo, getTask, setAgentFields, acquireLock, releaseLock, activeAgentRuns, addComment, activeRunIdForTask, listComments } from './store.js';
import { spawnAgent, cancelRun } from './agent.js';
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
      model: config.MODEL_DIAGNOSE,
      prompt: modeDef.diagnosePrompt({ apiBase: apiBase(), task: t, worktreePath: wt.worktreePath, db }),
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

export async function approve(db, taskId, opts = {}) {
  try {
    await doApprove(db, taskId, opts);
  } catch (e) {
    console.error('[approve] failed', e);
    try {
      if (getTask(db, taskId)) addComment(db, taskId, 'system', 'Approve error: ' + String((e && e.message) || e));
    } catch (e2) {
      console.error('[approve] failed to record error comment', e2);
    }
  }
}

async function doApprove(db, taskId, { plan } = {}) {
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
      model: config.MODEL_EXECUTE,
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
  if (runId && cancelRun(db, runId)) {
    // A live child was found and killed. The owning dispatch()/approve() call
    // is still awaiting spawnAgent — when that (now-killed) promise resolves,
    // ITS OWN finally will release the lock, set agent_phase to 'failed', and
    // clean up the worktree. If we also did those things here, the lock could
    // be re-acquired by a fresh dispatch in between, and the stale owner's
    // later releaseLock would then rip the lock out from under the NEW run
    // (and duplicate the "cancelled" system comment). So the owner is the
    // sole releaser whenever a run was actually in flight; we just ask it to
    // stop and get out of the way.
    addComment(db, taskId, 'system', 'Cancellation requested — the in-flight run will stop.');
    return;
  }
  // No in-flight run (e.g. awaiting_approval, or the run already finished) —
  // nothing is going to release the lock/worktree/phase on its own, so do it
  // here, defensively.
  if (task.agent_phase === 'done' || task.agent_phase === 'failed') return;
  releaseLock(db, `agent:${taskId}`);
  const repo = getRepo(db, task.repo_id);
  if (repo && task.worktree_path) cleanupWorktree(repo.path, task.worktree_path);
  setAgentFields(db, taskId, { agent_phase: 'failed' });
  addComment(db, taskId, 'system', 'Agent run cancelled.');
}
