import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestPrompt } from '../src/prompts.js';

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
