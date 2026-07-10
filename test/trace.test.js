import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/trace-dir.js';
import fs from 'node:fs';
import * as trace from '../src/trace.js';

test('open/append/close then read round-trips; missing → []', () => {
  const id = 9000001;
  trace.open(id);
  trace.append(id, { t: 'start', text: 'go' });
  trace.append(id, { t: 'end', status: 'ok' });
  trace.close(id);
  const evs = trace.read(id);
  assert.deepEqual(evs.map((e) => e.t), ['start', 'end']);
  assert.deepEqual(trace.read(9999999), []); // no file
  fs.rmSync(trace.fileFor(id));
});

test('prune keeps the most-recent N and deletes older', () => {
  for (const id of [9000010, 9000011, 9000012]) { trace.open(id); trace.append(id, { t: 'start' }); trace.close(id); }
  trace.prune(2);
  assert.equal(fs.existsSync(trace.fileFor(9000010)), false);
  assert.equal(fs.existsSync(trace.fileFor(9000012)), true);
  fs.rmSync(trace.fileFor(9000011)); fs.rmSync(trace.fileFor(9000012));
});
