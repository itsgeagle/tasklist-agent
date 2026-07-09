// In-memory pub/sub for live run traces. Keyed by a stream key so the browser can
// tail "the active ingest" without knowing the run id (the lock guarantees one
// active ingest/digest at a time). Reply runs key by task so concurrent replies
// don't interleave. State is per-process — fine for a single always-on server.
const MAX = 500; // cap buffered events per key; a chatty run can't grow unbounded

const streams = new Map(); // key -> { runId, status, events:[], subs:Set }

export function streamKey({ kind, task_id }) {
  return kind === 'reply' && task_id != null ? `reply:${task_id}` : kind;
}

function ensure(key) {
  let s = streams.get(key);
  if (!s) { s = { runId: null, status: 'idle', events: [], subs: new Set() }; streams.set(key, s); }
  return s;
}

function push(s, ev) {
  s.events.push(ev);
  if (s.events.length > MAX) s.events.splice(0, s.events.length - MAX);
  for (const cb of s.subs) { try { cb(ev); } catch { /* a dead subscriber must not break others */ } }
}

// Start (or restart) a run on this key: clear the buffer and tell live viewers to reset.
export function begin(key, runId) {
  const s = ensure(key);
  s.runId = runId; s.status = 'running'; s.events = [];
  push(s, { t: 'reset', runId });
}

export function publish(key, ev) {
  const s = streams.get(key);
  if (s) push(s, ev);
}

export function end(key, status) {
  const s = streams.get(key);
  if (!s) return;
  s.status = status;
  push(s, { t: 'end', status });
}

// Replay the current buffer to cb, then stream new events. Returns an unsubscribe fn.
export function subscribe(key, cb) {
  const s = ensure(key);
  for (const ev of s.events) cb(ev);
  s.subs.add(cb);
  return () => s.subs.delete(cb);
}

export function snapshot(key) {
  const s = streams.get(key);
  return s ? { runId: s.runId, status: s.status, events: s.events.slice() } : null;
}

// Test hook: forget all stream state.
export function _reset() { streams.clear(); }
