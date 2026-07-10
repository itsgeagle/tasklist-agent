// In-memory pub/sub for live run traces, keyed by runId. A run's events live here
// only while it is active; end() drops the stream so finished runs replay from their
// persisted JSONL trace instead (see trace.js). State is per-process — fine for a
// single always-on server.
const MAX = 500; // cap buffered events per run; a chatty run can't grow unbounded

const streams = new Map(); // runId -> { status, events:[], subs:Set }

function ensure(runId) {
  let s = streams.get(runId);
  if (!s) { s = { status: 'idle', events: [], subs: new Set() }; streams.set(runId, s); }
  return s;
}

function push(s, ev) {
  s.events.push(ev);
  if (s.events.length > MAX) s.events.splice(0, s.events.length - MAX);
  for (const cb of s.subs) { try { cb(ev); } catch { /* a dead subscriber must not break others */ } }
}

// Start a run: clear the buffer and tell live viewers to reset.
export function begin(runId) {
  const s = ensure(runId);
  s.status = 'running'; s.events = [];
  push(s, { t: 'reset', runId });
}

export function publish(runId, ev) {
  const s = streams.get(runId);
  if (s) push(s, ev);
}

export function end(runId, status) {
  const s = streams.get(runId);
  if (!s) return;
  s.status = status;
  push(s, { t: 'end', status });
  streams.delete(runId); // finished runs are served from the trace file, not memory
}

// Replay the current buffer to cb, then stream new events. Returns an unsubscribe fn.
export function subscribe(runId, cb) {
  const s = ensure(runId);
  for (const ev of s.events) cb(ev);
  s.subs.add(cb);
  return () => s.subs.delete(cb);
}

export function snapshot(runId) {
  const s = streams.get(runId);
  return s ? { status: s.status, events: s.events.slice() } : null;
}

// Test hook: forget all stream state.
export function _reset() { streams.clear(); }
