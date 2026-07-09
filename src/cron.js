import cron from 'node-cron';
import config from './config.js';
import { acquireLock, releaseLock } from './store.js';
import { spawnAgent } from './agent.js';
import { ingestPrompt, digestPrompt } from './prompts.js';

// Resolve at call time so tests can retarget the API per case (see agent.js note).
const apiBase = () => process.env.TASKLIST_API || config.API_BASE;

export async function runIngest(db) {
  if (!acquireLock(db, 'ingest')) return;
  try { await spawnAgent(db, { kind: 'ingest', prompt: ingestPrompt({ apiBase: apiBase() }) }); }
  finally { releaseLock(db, 'ingest'); }
}

export async function runDigest(db) {
  if (!acquireLock(db, 'digest')) return;
  try { await spawnAgent(db, { kind: 'digest', prompt: digestPrompt({ apiBase: apiBase() }) }); }
  finally { releaseLock(db, 'digest'); }
}

export function startSchedules(db) {
  cron.schedule('*/30 * * * *', () => runIngest(db));
  cron.schedule('0 8 * * *', () => runDigest(db));
}
