import { spawn } from 'node:child_process';
import config from './config.js';
import { createRun, finishRun } from './store.js';

export function spawnAgent(db, { kind, task_id = null, prompt, timeoutMs = 300000 }) {
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

    const child = spawn(config.CLAUDE_BIN, [
      '-p', prompt,
      '--output-format', 'json',
      // Allow the Bash tool without an interactive approval prompt so the
      // headless run can execute the curl/Bash commands the prompts require.
      '--allowedTools', 'Bash',
    ], { env: childEnv });
    let out = '', err = '', done = false;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer);
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
