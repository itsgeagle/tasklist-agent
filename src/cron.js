import cron from 'node-cron';
import config from './config.js';
import { acquireLock, releaseLock, getTask } from './store.js';
import { spawnAgent } from './agent.js';
import { ingestPrompt, digestPrompt, replyPrompt } from './prompts.js';

// Resolve at call time so tests can retarget the API per case (see agent.js note).
const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

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

export async function runDigest(db) {
  if (!acquireLock(db, 'digest')) return;
  try { await spawnAgent(db, { kind: 'digest', prompt: digestPrompt({ apiBase: apiBase() }), timeoutMs: config.DIGEST_TIMEOUT_MS }); }
  finally { releaseLock(db, 'digest'); }
}

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

export function startSchedules(db) {
  cron.schedule('*/30 * * * *', () => runIngest(db));
  cron.schedule('0 8 * * *', () => runDigest(db));
}
