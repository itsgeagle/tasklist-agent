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
};
