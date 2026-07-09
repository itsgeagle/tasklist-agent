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
  CLAUDE_BIN: process.env.CLAUDE_BIN || 'claude',
  SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || '',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  API_BASE: process.env.TASKLIST_API || `http://127.0.0.1:${PORT}`,
  WORKTREE_DIR: process.env.WORKTREE_DIR || path.join(ROOT, 'data', 'worktrees'),
  MAX_AGENT_CONCURRENCY: Number(process.env.MAX_AGENT_CONCURRENCY || 2),
  DIAGNOSE_TIMEOUT_MS: Number(process.env.DIAGNOSE_TIMEOUT_MS || 600000),
  EXECUTE_TIMEOUT_MS: Number(process.env.EXECUTE_TIMEOUT_MS || 2700000),
};
