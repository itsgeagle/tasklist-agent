import { spawn } from 'node:child_process';
import config, { estimateCost } from './config.js';
import { createRun, finishRun } from './store.js';
import * as runbus from './runbus.js';

const active = new Map(); // runId -> child

const truncate = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Pull the plain text out of a tool_result's `content` (string, or array of blocks).
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ');
  return '';
}

// Map one claude stream-json event to a concise console event, or null to skip.
function toEvents(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'system' && obj.subtype === 'init') return [{ t: 'start', text: `started · ${obj.model || 'claude'}` }];
  if (obj.type === 'assistant') {
    const blocks = obj.message?.content || [];
    const out = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) out.push({ t: 'text', text: truncate(b.text, 300) });
      else if (b.type === 'tool_use') {
        const summary = b.name === 'Bash' ? (b.input?.command || '') : JSON.stringify(b.input || {});
        out.push({ t: 'tool', text: `${b.name}: ${truncate(summary)}` });
      }
    }
    return out;
  }
  if (obj.type === 'user') {
    const blocks = obj.message?.content || [];
    return blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ t: 'result', text: truncate(resultText(b.content)), ok: !b.is_error }));
  }
  if (obj.type === 'result') {
    const turns = obj.num_turns ? ` · ${obj.num_turns} turns` : '';
    return [{ t: 'done', text: `done — ${obj.is_error ? 'error' : 'ok'}${turns}` }];
  }
  return [];
}

export function spawnAgent(db, { kind, task_id = null, prompt, tools = ['Bash'], cwd, timeoutMs = 300000, _binOverride } = {}) {
  const runId = createRun(db, { kind, task_id });
  const key = runbus.streamKey({ kind, task_id });
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
    // headless run can execute the commands the prompts require. stream-json +
    // --verbose makes claude emit newline-delimited events as they happen, which
    // we fan out live over runbus (see toEvents); the raw stream is still saved.
    const agentArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...tools];
    const bin = _binOverride || config.CLAUDE_BIN;
    const argv = _binOverride ? [bin, ...agentArgs] : agentArgs;
    const cmd = _binOverride ? 'node' : bin;
    const child = spawn(cmd, argv, { cwd, env: childEnv });

    active.set(runId, child);
    runbus.begin(key, runId);
    let out = '', err = '', done = false, lineBuf = '';
    let resultMeta = {}, model = null;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer); active.delete(runId);
      finishRun(db, runId, status, (out + err).slice(0, 20000), resultMeta);
      runbus.end(key, status);
      resolve({ status, log: out + err, runId });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('failed'); }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      lineBuf += d;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; } // ignore non-JSON noise
        if (obj.type === 'system' && obj.subtype === 'init') model = obj.model || model;
        if (obj.type === 'result') {
          const u = obj.usage || {};
          const input = u.input_tokens ?? null;
          const output = u.output_tokens ?? null;
          let cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
          let estimated = false;
          if (cost == null && (input != null || output != null)) {
            cost = estimateCost(model, input || 0, output || 0);
            estimated = true;
          }
          resultMeta = {
            cost_usd: cost, cost_estimated: estimated,
            input_tokens: input, output_tokens: output,
            cache_read_tokens: u.cache_read_input_tokens ?? null,
            cache_write_tokens: u.cache_creation_input_tokens ?? null,
            num_turns: obj.num_turns ?? null, duration_ms: obj.duration_ms ?? null,
            model,
          };
        }
        for (const ev of toEvents(obj)) runbus.publish(key, ev);
      }
    });
    child.stderr.on('data', (d) => { err += d; runbus.publish(key, { t: 'stderr', text: truncate(String(d), 300) }); });
    child.on('error', (e) => { err += String(e); runbus.publish(key, { t: 'stderr', text: String(e) }); finish('failed'); });
    child.on('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
  });
}

export function cancelRun(db, runId) {
  const child = active.get(runId);
  if (!child) return false;
  child.kill('SIGKILL');           // 'close' handler finishes the run as failed
  return true;
}
