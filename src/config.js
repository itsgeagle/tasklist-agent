import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(root, '..');
const PORT = Number(process.env.PORT || 8787);

export default {
  PORT,
  HOST: '127.0.0.1',
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'tasks.db'),
  LOG_DIR: path.join(ROOT, 'logs'),
  // Tunable "who I am / what's relevant" context injected into ingest/reply
  // prompts. context.md is gitignored (personal); context.example.md is the
  // committed template used as a fallback.
  CONTEXT_PATH: process.env.CONTEXT_PATH || path.join(ROOT, 'context.md'),
  CONTEXT_EXAMPLE_PATH: path.join(ROOT, 'context.example.md'),
  CLAUDE_BIN: process.env.CLAUDE_BIN || 'claude',
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || '',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  API_BASE: process.env.TASKLIST_API || `http://127.0.0.1:${PORT}`,
  WORKTREE_DIR: process.env.WORKTREE_DIR || path.join(ROOT, 'data', 'worktrees'),
  MAX_AGENT_CONCURRENCY: Number(process.env.MAX_AGENT_CONCURRENCY || 2),
  // A full-workspace Slack scan can run several minutes; give it real headroom
  // (a live run measured 4m21s). 10 min default, override via env if needed.
  INGEST_TIMEOUT_MS: Number(process.env.INGEST_TIMEOUT_MS || 600000),
  DIGEST_TIMEOUT_MS: Number(process.env.DIGEST_TIMEOUT_MS || 600000),
  // Incremental ingest: re-scan this far below the high-water-mark to catch
  // edits/boundary messages (dedup absorbs the overlap). Bootstrap window is
  // used only on the very first run, when no high-water-mark exists yet.
  INGEST_OVERLAP_MS: Number(process.env.INGEST_OVERLAP_MS || 600000),
  INGEST_BOOTSTRAP_MS: Number(process.env.INGEST_BOOTSTRAP_MS || 604800000),
  DIAGNOSE_TIMEOUT_MS: Number(process.env.DIAGNOSE_TIMEOUT_MS || 600000),
  EXECUTE_TIMEOUT_MS: Number(process.env.EXECUTE_TIMEOUT_MS || 2700000),
};
