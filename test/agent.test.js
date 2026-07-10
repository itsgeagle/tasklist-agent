import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/trace-dir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, latestRun } from '../src/store.js';

test('spawnAgent runs in cwd and passes allowedTools', async () => {
  // stub echoes argv + cwd into a file we can inspect
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.PROBE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));
process.stdout.write('{}');`);
  const probe = path.join(dir, 'probe.json');
  process.env.CLAUDE_BIN = 'node';                 // run the stub via: node <stub> -p ...
  process.env.PROBE = probe;
  const { spawnAgent } = await import('../src/agent.js?a1');
  const db = openDb(':memory:');
  // prepend the stub path so `claude` args land after it: emulate by using a wrapper prompt
  const res = await spawnAgent(db, { kind: 'diagnose', prompt: 'hi', tools: ['Bash', 'Read'], cwd: dir,
    // test hook: force argv0 to the stub
    _binOverride: stub });
  assert.equal(res.status, 'ok');
  const probed = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(probed.cwd, fs.realpathSync(dir));
  assert.ok(probed.argv.includes('--allowedTools'));
  assert.ok(probed.argv.includes('Bash') && probed.argv.includes('Read'));
  assert.equal(latestRun(db, 'diagnose').status, 'ok');
});

test('spawnAgent captures cost/token metrics from the result event', async () => {
  const STUB = new URL('../bin/stub-claude.js', import.meta.url).pathname;
  const { spawnAgent } = await import('../src/agent.js?a2');
  const { openDb, latestRun } = await import('../src/store.js');
  const db = openDb(':memory:');
  // DIGEST is the only stub path that emits a result event with NO network
  // calls, so it exercises metric capture without needing a live API server
  // (and never touches the real tasklist server).
  const res = await spawnAgent(db, { kind: 'digest', prompt: 'DIGEST', tools: ['Bash'], _binOverride: STUB });
  assert.equal(res.status, 'ok');
  const r = latestRun(db, 'digest');
  assert.equal(r.cost_usd, 0.01);
  assert.equal(r.cost_estimated, 0);
  assert.equal(r.input_tokens, 100);
  assert.equal(r.output_tokens, 50);
});

test('spawnAgent tees the trace to data/traces/<runId>.jsonl', async () => {
  const STUB = new URL('../bin/stub-claude.js', import.meta.url).pathname;
  const { spawnAgent } = await import('../src/agent.js?trace1');
  const { openDb } = await import('../src/store.js');
  const trace = await import('../src/trace.js');
  const db = openDb(':memory:');
  const res = await spawnAgent(db, { kind: 'digest', prompt: 'DIGEST', tools: ['Bash'], _binOverride: STUB });
  assert.equal(res.status, 'ok');
  const evs = trace.read(res.runId);
  const kinds = evs.map((e) => e.t);
  assert.ok(kinds.includes('start'), 'has start');
  assert.equal(evs.at(-1).t, 'end');
  assert.equal(evs.at(-1).status, 'ok');
  fs.rmSync(trace.fileFor(res.runId));
});

test('spawnAgent estimates cost from tokens when total_cost_usd is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'system',subtype:'init',model:'claude-haiku-4-5'})+'\\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,usage:{input_tokens:1000000,output_tokens:1000000}})+'\\n');`);
  process.env.CLAUDE_BIN = 'node';
  const { spawnAgent } = await import('../src/agent.js?a3');
  const { openDb, latestRun } = await import('../src/store.js');
  const db = openDb(':memory:');
  await spawnAgent(db, { kind: 'ingest', prompt: 'hi', tools: ['Bash'], _binOverride: stub });
  const r = latestRun(db, 'ingest');
  assert.equal(r.cost_estimated, 1);
  // 1M input @ $1 + 1M output @ $5 for haiku rate = 6.0
  assert.equal(Math.round(r.cost_usd), 6);
});

test('spawnAgent passes --model when set and omits it when not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const stub = path.join(dir, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.PROBE, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{}');`);
  const probe = path.join(dir, 'probe.json');
  process.env.CLAUDE_BIN = 'node';
  process.env.PROBE = probe;
  const { spawnAgent } = await import('../src/agent.js?a4');
  const { openDb } = await import('../src/store.js');
  const db = openDb(':memory:');
  await spawnAgent(db, { kind: 'ingest', prompt: 'hi', tools: ['Bash'], model: 'claude-haiku-4-5', _binOverride: stub });
  let argv = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.ok(argv.includes('--model') && argv.includes('claude-haiku-4-5'));
  await spawnAgent(db, { kind: 'ingest', prompt: 'hi', tools: ['Bash'], _binOverride: stub });
  argv = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(argv.includes('--model'), false);
});
