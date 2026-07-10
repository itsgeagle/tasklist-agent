import cron from 'node-cron';
import config from './config.js';
import { acquireLock, releaseLock, getTask, getMeta, setMeta, createRun, finishRun } from './store.js';
import { spawnAgent } from './agent.js';
import { ingestPrompt, digestPrompt, replyPrompt } from './prompts.js';
import { hasNewSince } from './slack.js';

// Resolve at call time so tests can retarget the API per case (see agent.js note).
const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

export async function runIngest(db, { hasNew = hasNewSince, now = Date.now } = {}) {
  if (!acquireLock(db, 'ingest')) return;
  try {
    const hwm = getMeta(db, 'ingest_hwm');
    const lastFull = Number(getMeta(db, 'ingest_last_full')) || 0;
    const stale = (now() - lastFull) >= config.INGEST_MAX_QUIET_MS;
    // Skip the expensive LLM spawn only when we have a watermark (i.e. not the
    // first-run bootstrap), it isn't time for the forced full sweep, and Slack
    // genuinely has nothing new. Record a lightweight 'skipped' run so the UI
    // shows "skipped (quiet)" instead of looking dead.
    if (hwm && !stale && (await hasNew(hwm)) === false) {
      const runId = createRun(db, { kind: 'ingest' });
      finishRun(db, runId, 'skipped', 'quiet: no new Slack messages since high-water-mark');
      return;
    }
    await spawnAgent(db, {
      kind: 'ingest',
      model: config.MODEL_INGEST,
      prompt: ingestPrompt({
        apiBase: apiBase(),
        overlapMs: config.INGEST_OVERLAP_MS,
        bootstrapMs: config.INGEST_BOOTSTRAP_MS,
      }),
      timeoutMs: config.INGEST_TIMEOUT_MS,
    });
    setMeta(db, 'ingest_last_full', String(now()));
  } finally { releaseLock(db, 'ingest'); }
}

export async function runDigest(db) {
  if (!acquireLock(db, 'digest')) return;
  try { await spawnAgent(db, { kind: 'digest', prompt: digestPrompt({ apiBase: apiBase() }), timeoutMs: config.DIGEST_TIMEOUT_MS, model: config.MODEL_DIGEST }); }
  finally { releaseLock(db, 'digest'); }
}

export async function runReply(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return;
  if (!acquireLock(db, `reply:${taskId}`)) return;
  try {
    await spawnAgent(db, { kind: 'reply', task_id: taskId, prompt: replyPrompt({ apiBase: apiBase(), task }), model: config.MODEL_REPLY });
  } finally {
    releaseLock(db, `reply:${taskId}`);
  }
}

export function startSchedules(db) {
  cron.schedule('*/30 * * * *', () => runIngest(db));
  cron.schedule('0 8 * * *', () => runDigest(db));
}
