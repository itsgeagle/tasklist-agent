import { spawn } from 'node:child_process';
import config from './config.js';
import { createRun, finishRun } from './store.js';

const active = new Map(); // runId -> child

export function spawnAgent(db, { kind, task_id = null, prompt, tools = ['Bash'], cwd, timeoutMs = 300000, _binOverride } = {}) {
  const runId = createRun(db, { kind, task_id });
  return new Promise((resolve) => {
    // Start from a copy of process.env and strip every ANTHROPIC_* var so the
    // child never sees an API key. If it did, `claude` would bill the paid
    // Anthropic API instead of running against the subscription — never allowed.
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^ANTHROPIC_/.test(key)) delete childEnv[key];
    }
    childEnv.SLACK_USER_TOKEN = config.SLACK_USER_TOKEN;
    childEnv.DISCORD_WEBHOOK_URL = config.DISCORD_WEBHOOK_URL;
    // Read env at call time (not the cached config value) so tests that boot
    // an ephemeral-port server per case point the child at the right port.
    childEnv.TASKLIST_API = process.env.TASKLIST_API || config.API_BASE;

    // Allow the given tools without an interactive approval prompt so the
    // headless run can execute the commands the prompts require.
    const agentArgs = ['-p', prompt, '--output-format', 'json', '--allowedTools', ...tools];
    const bin = _binOverride || config.CLAUDE_BIN;
    const argv = _binOverride ? [bin, ...agentArgs] : agentArgs;
    const cmd = _binOverride ? 'node' : bin;
    const child = spawn(cmd, argv, { cwd, env: childEnv });

    active.set(runId, child);
    let out = '', err = '', done = false;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer); active.delete(runId);
      finishRun(db, runId, status, (out + err).slice(0, 20000));
      resolve({ status, log: out + err, runId });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('failed'); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { err += String(e); finish('failed'); });
    child.on('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
  });
}

export function cancelRun(db, runId) {
  const child = active.get(runId);
  if (!child) return false;
  child.kill('SIGKILL');           // 'close' handler finishes the run as failed
  return true;
}
