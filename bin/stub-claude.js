#!/usr/bin/env node
// Test/dev stand-in for `claude -p`. Performs the API writes a real run would,
// driven by keywords in the prompt, then prints canned JSON.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const api = process.env.TASKLIST_API;

async function main() {
  if (/INGEST/.test(prompt)) {
    for (const t of [
      { title: 'Reply to Sam about launch', source_channel: 'C1', source_ts: '100.1', source_permalink: 'https://slack/x' },
      { title: 'Review PR 42', source_channel: 'C2', source_ts: '200.2' },
    ]) {
      await fetch(`${api}/api/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) });
    }
    process.stdout.write(JSON.stringify({ result: 'ingested 2' }));
  } else if (/REPLY task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/REPLY task_id=(\d+)/)[1];
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Here is my help on this task.' }) });
    process.stdout.write(JSON.stringify({ result: 'replied' }));
  } else if (/DIGEST/.test(prompt)) {
    process.stdout.write(JSON.stringify({ result: 'digest posted' }));
  } else if (/DIAGNOSE task_id=(\d+)/.test(prompt)) {
    const id = prompt.match(/DIAGNOSE task_id=(\d+)/)[1];
    await fetch(`${api}/api/tasks/${id}/comments`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'agent', body: 'Root cause: X. Plan: change file Y.' }) });
    process.stdout.write(JSON.stringify({ result: 'diagnosed' }));
  } else {
    process.stdout.write(JSON.stringify({ result: 'noop' }));
  }
}
main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
