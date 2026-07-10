import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runbus from '../src/runbus.js';

test('subscribe replays buffer then streams new events; ids are isolated', () => {
  runbus._reset();
  runbus.begin(1);
  runbus.publish(1, { t: 'tool', text: 'a' });
  const seen = [];
  const unsub = runbus.subscribe(1, (ev) => seen.push(ev));
  runbus.publish(1, { t: 'result', text: 'b' });
  runbus.publish(2, { t: 'tool', text: 'other' }); // different run must not leak
  unsub();
  runbus.publish(1, { t: 'tool', text: 'after' });  // must not reach us
  const kinds = seen.map((e) => e.t);
  assert.deepEqual(kinds, ['reset', 'tool', 'result']);
});

test('end() pushes end to live subscribers then drops the stream', () => {
  runbus._reset();
  runbus.begin(5);
  const seen = [];
  runbus.subscribe(5, (ev) => seen.push(ev));
  runbus.end(5, 'ok');
  assert.equal(seen.at(-1).t, 'end');
  assert.equal(seen.at(-1).status, 'ok');
  assert.equal(runbus.snapshot(5), null); // dropped after end
});
