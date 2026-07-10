import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// node --test runs each test file in its own process, but every :memory: db restarts
// run ids at 1 — so without this, parallel files would write the same
// data/traces/1.jsonl and corrupt each other. Give each process its own trace dir.
process.env.TASKLIST_TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-trace-'));
