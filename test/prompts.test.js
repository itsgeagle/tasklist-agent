import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestPrompt, replyPrompt, renderThread, AGENT_RULES } from '../src/prompts.js';
import { openDb, upsertTask, addComment } from '../src/store.js';

test('renderThread includes task + comments; replyPrompt inlines it, no discovery curl', () => {
  const db = openDb(':memory:');
  const { id } = upsertTask(db, { title: 'Ship launch', detail: 'blocking', source_channel: 'C1', source_ts: '1.1' });
  addComment(db, id, 'me', '@claude summarize this');
  const thread = renderThread(db, id);
  assert.ok(thread.includes('Ship launch'));
  assert.ok(thread.includes('@claude summarize this'));
  const p = replyPrompt({ apiBase: 'http://api', db, task: { id, title: 'Ship launch' } });
  assert.ok(p.includes('Ship launch'));                 // thread inlined
  assert.ok(p.includes(AGENT_RULES));                   // shared preamble
  assert.ok(!/Fetch the task and its comment thread/i.test(p)); // discovery step gone
});

test('ingestPrompt carries the shared AGENT_RULES', () => {
  assert.ok(ingestPrompt({ apiBase: 'http://api' }).includes(AGENT_RULES));
});

test('ingest prompt drives incremental reconcile, not blind insert', () => {
  const p = ingestPrompt({ apiBase: 'http://api', overlapMs: 600000, bootstrapMs: 604800000 });
  // incremental: reads + advances the watermark
  assert.match(p, /ingest_hwm/);
  assert.match(p, /oldest=/);
  // reconcile against existing tasks
  assert.match(p, /status=open/);
  assert.match(p, /thread_ts/);
  // the four outcomes
  assert.match(p, /updated_by":\s*"slack"|updated_by":"slack"/);
  assert.match(p, /status":\s*"done"|status":"done"/);
  assert.match(p, /gh pr view/);
  // must stay off the Anthropic API
  assert.match(p, /do NOT use any Anthropic API/i);
});

test('ingest prompt judges messages in context, not in isolation', () => {
  const p = ingestPrompt({ apiBase: 'http://api' });
  // read surrounding conversation, and treat self-resolution as already-handled
  assert.match(p, /IN CONTEXT/);
  assert.match(p, /still unresolved as of\s+the latest message|still unresolved/);
  assert.match(p, /from ME/);
  assert.match(p, /do NOT create an open one/);
});
