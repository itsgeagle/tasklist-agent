#!/usr/bin/env node
// Test/dev stand-in for `claude -p`. Performs the API writes a real run would,
// driven by keywords in the prompt, then prints stream-json events (one JSON
// object per line) so agent.js's parser and the live console see realistic
// traffic. The real `claude` emits the same event shapes under
// --output-format stream-json --verbose.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const api = process.env.TASKLIST_API;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const init = () => emit({ type: 'system', subtype: 'init', model: 'stub-claude' });
const tool = (command) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const toolResult = (text, is_error = false) => emit({ type: 'user', message: { content: [{ type: 'tool_result', content: text, is_error }] } });
const result = (text) => emit({ type: 'result', subtype: 'success', is_error: false,
  num_turns: 2, duration_ms: 1234, total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  result: text });

async function main() {
  init();
  if (/INGEST/.test(prompt)) {
    tool(`curl ${api}/api/tasks?status=open`);
    // Best-effort read: some traces drive ingest against an API-less app, and a
    // real agent that can't read open tasks simply reconciles nothing.
    let open = [];
    try { open = await (await fetch(`${api}/api/tasks?status=open`)).json(); } catch { open = []; }
    if (!Array.isArray(open)) open = [];
    toolResult(JSON.stringify(open));
    for (const t of open) {
      // simulate a merged-PR sweep: a real (non-placeholder) pr_url → close
      if (t.pr_url && !String(t.pr_url).startsWith('local-branch:')) {
        await fetch(`${api}/api/tasks/${t.id}/comments`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: 'slack', updated_by: 'slack', body: 'PR merged — closing.' }) });
        await fetch(`${api}/api/tasks/${t.id}`, { method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'done', updated_by: 'slack' }) });
      } else if (t.source_thread_ts) {
        // simulate a thread update folding into the existing task
        await fetch(`${api}/api/tasks/${t.id}/comments`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: 'slack', updated_by: 'slack', body: 'New reply in this thread.' }) });
      }
    }
    for (const t of [
      { title: 'Reply to Sam about launch', source_channel: 'C1', source_ts: '100.1', source_permalink: 'https://slack/x' },
      { title: 'Review PR 42', source_channel: 'C2', source_ts: '200.2' },
    ]) {
      tool(`curl -XPOST ${api}/api/tasks -d '${t.title}'`);
      await fetch(`${api}/api/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
      toolResult('created');
    }
    result('ingested 2');
  } else if (/REPLY task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/REPLY task_id=(\d+)/)[1];
    tool(`curl -XPOST ${api}/api/tasks/${id}/comments`);
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Here is my help on this task.' }) });
    result('replied');
  } else if (/DIGEST/.test(prompt)) {
    tool('curl -XPOST https://discord/webhook');
    toolResult('204');
    result('digest posted');
  } else if (/DIAGNOSE task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/DIAGNOSE task_id=(\d+)/)[1];
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Root cause: X. Plan: change file Y.' }) });
    result('diagnosed');
  } else if (/EXECUTE task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/EXECUTE task_id=(\d+)/)[1];
    fs.writeFileSync('fix.txt', 'fixed');                  // cwd is the worktree
    execSync('git add -A && git commit --no-gpg-sign -m "fix" ', { stdio: 'ignore' });
    await fetch(`${api}/api/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pr_url: 'local-branch:agent/task-' + id }) });
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Done. Draft PR opened.' }) });
    result('executed');
  } else {
    result('noop');
  }
}
main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
