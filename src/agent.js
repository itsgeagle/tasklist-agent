import { spawn } from 'node:child_process';
import config from './config.js';
import { createRun, finishRun } from './store.js';

export function spawnAgent(db, { kind, task_id = null, prompt, timeoutMs = 300000 }) {
  const runId = createRun(db, { kind, task_id });
  return new Promise((resolve) => {
    const child = spawn(config.CLAUDE_BIN, ['-p', prompt, '--output-format', 'json'], {
      env: {
        ...process.env,
        SLACK_USER_TOKEN: config.SLACK_USER_TOKEN,
        DISCORD_WEBHOOK_URL: config.DISCORD_WEBHOOK_URL,
        // Read env at call time (not the cached config value) so tests that boot
        // an ephemeral-port server per case point the child at the right port.
        TASKLIST_API: process.env.TASKLIST_API || config.API_BASE,
      },
    });
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
