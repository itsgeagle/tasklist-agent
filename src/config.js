import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(root, '..');
const PORT = Number(process.env.PORT || 8787);

// Approximate list prices ($ per 1M tokens) used ONLY to estimate notional cost
// when claude -p omits total_cost_usd (e.g. on some subscription runs). Not a
// bill — the UI labels any estimated figure "est.". Tune freely; substring match
// tolerates dated model ids (e.g. "claude-haiku-4-5-20251001").
export const MODEL_RATES = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  default: { input: 3, output: 15 },
};

export function estimateCost(model, inputTokens = 0, outputTokens = 0) {
  const key = Object.keys(MODEL_RATES).find((k) => k !== 'default' && (model || '').includes(k)) || 'default';
  const r = MODEL_RATES[key];
  return (inputTokens / 1e6) * r.input + (outputTokens / 1e6) * r.output;
}

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
  SLACK_API_BASE: process.env.SLACK_API_BASE || 'https://slack.com/api',
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
  DAILY_BUDGET: Number(process.env.DAILY_BUDGET || 0),
  MODEL_INGEST: process.env.MODEL_INGEST || '',
  MODEL_DIGEST: process.env.MODEL_DIGEST || '',
  MODEL_REPLY: process.env.MODEL_REPLY || '',
  MODEL_DIAGNOSE: process.env.MODEL_DIAGNOSE || '',
  MODEL_EXECUTE: process.env.MODEL_EXECUTE || '',
  // Even when Slack looks quiet, force a full LLM ingest at least this often so
  // the PR-merge sweep and any missed edges still run. Default 3h.
  INGEST_MAX_QUIET_MS: Number(process.env.INGEST_MAX_QUIET_MS || 10800000),
};
