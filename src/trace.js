import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'traces');

export function fileFor(runId) { return path.join(DIR, `${runId}.jsonl`); }

// Start a fresh trace file for this run. Synchronous appends (below) keep the file
// read-after-write consistent — no flush race when a viewer replays a just-finished
// run. Event volume is curated/bounded, so per-event appends are cheap enough.
export function open(runId) {
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.writeFileSync(fileFor(runId), ''); } catch { /* non-fatal — a dead trace file must never break a run */ }
}

export function append(runId, ev) {
  try { fs.appendFileSync(fileFor(runId), JSON.stringify(ev) + '\n'); } catch { /* non-fatal */ }
}

// No-op: appends are synchronous, so there is no stream to flush/close. Kept for a
// symmetric open/close call-site contract.
export function close(_runId) { /* nothing to do */ }

export function read(runId) {
  let text;
  try { text = fs.readFileSync(fileFor(runId), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Keep the most-recent `keepRuns` trace files (runId is a monotonic autoincrement,
// so a larger id is newer); delete the rest. Best-effort; errors are ignored.
export function prune(keepRuns = 500) {
  let files;
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  const byNewest = files
    .map((f) => [Number(f.slice(0, -6)), f])
    .sort((a, b) => b[0] - a[0]);
  for (const [, f] of byNewest.slice(keepRuns)) { try { fs.rmSync(path.join(DIR, f)); } catch { /* gone */ } }
}
