import { test } from 'node:test';
import assert from 'node:assert/strict';
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
