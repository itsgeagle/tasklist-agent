# Phase 0 — Cost Visibility + Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's LLM cost honest and visible, and add two reversible, off-by-default savings levers (skip-ingest-when-quiet, per-job model selection).

**Architecture:** Capture the token/cost metrics `claude -p` already emits in its final `result` event and persist them on the `runs` row; aggregate them into a truthful `/api/usage`; add a plain-`fetch` Slack pre-check so a quiet ingest tick skips the expensive LLM spawn; and thread an optional per-job `--model` flag through the single `spawnAgent` choke point.

**Tech Stack:** Node ≥18 ESM, Express, better-sqlite3, node-cron, vanilla HTML/JS, `node:test`. No new dependencies.

## Global Constraints

- All intelligence runs through headless `claude -p` on the **subscription** — never the paid Anthropic API. `agent.js` strips every `ANTHROPIC_*` var from the child; do not weaken that.
- Additive only: every new lever defaults to today's behavior. Unset config = no change.
- Git commits: `--no-gpg-sign`, and **never** add a `Co-Authored-By` trailer.
- Tokens are the source of truth; `total_cost_usd` is notional on a subscription and may be absent — always fall back to a token×rate estimate and flag it.
- Follow existing test conventions: `openDb(':memory:')`, `app.listen(0)` for ephemeral ports, `bin/stub-claude.js` (or an inline stub) via `CLAUDE_BIN`/`_binOverride`, set `process.env` before dynamically importing a module whose `config.js` reads env at import time.

---

### Task 1: Capture per-run cost/token metrics

**Files:**
- Modify: `src/store.js` (runs schema loop; `finishRun`)
- Modify: `src/config.js` (`MODEL_RATES`, `estimateCost`)
- Modify: `src/agent.js` (capture result metrics; pass to `finishRun`)
- Modify: `bin/stub-claude.js` (`result()` emits usage)
- Test: `test/store.test.js`, `test/agent.test.js`

**Interfaces:**
- Produces: `finishRun(db, id, status, log, metrics = {})` where `metrics` = `{ cost_usd, cost_estimated, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, num_turns, duration_ms, model }` (all optional).
- Produces: `estimateCost(model, inputTokens, outputTokens) → number` and `MODEL_RATES` (named exports from `config.js`).

- [ ] **Step 1: Write the failing test — `finishRun` persists metrics**

Add to `test/store.test.js` (import `latestRun` is already imported; add `createRun`, `finishRun` if not — both already imported):

```javascript
test('finishRun persists cost/token metrics on the run', () => {
  const d = db();
  const runId = createRun(d, { kind: 'ingest' });
  finishRun(d, runId, 'ok', 'log', {
    cost_usd: 0.0123, cost_estimated: false,
    input_tokens: 1000, output_tokens: 200,
    cache_read_tokens: 5, cache_write_tokens: 6,
    num_turns: 3, duration_ms: 4200, model: 'claude-opus-4-8',
  });
  const r = latestRun(d, 'ingest');
  assert.equal(r.cost_usd, 0.0123);
  assert.equal(r.cost_estimated, 0);
  assert.equal(r.input_tokens, 1000);
  assert.equal(r.output_tokens, 200);
  assert.equal(r.model, 'claude-opus-4-8');
});

test('finishRun without metrics leaves metric columns null (back-compat)', () => {
  const d = db();
  const runId = createRun(d, { kind: 'reply' });
  finishRun(d, runId, 'ok', 'log');
  const r = latestRun(d, 'reply');
  assert.equal(r.cost_usd, null);
  assert.equal(r.input_tokens, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `finishRun` ignores the 5th arg; `r.cost_usd` is `undefined` (column missing).

- [ ] **Step 3: Add the runs metric columns**

In `src/store.js`, immediately after the `tasks` column-add loop (ends `store.js:56`), add a matching loop for `runs`:

```javascript
  for (const [col, def] of [
    ['cost_usd', 'REAL'], ['cost_estimated', 'INTEGER'],
    ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
    ['cache_read_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'],
    ['num_turns', 'INTEGER'], ['duration_ms', 'INTEGER'], ['model', 'TEXT'],
  ]) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info('runs') WHERE name = ?`).get(col);
    if (!exists) db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
  }
```

- [ ] **Step 4: Extend `finishRun`**

Replace `finishRun` in `src/store.js` (currently `store.js:140-143`):

```javascript
export function finishRun(db, id, status, log, metrics = {}) {
  const m = metrics || {};
  db.prepare(`UPDATE runs SET status = ?, log = ?, finished_at = datetime('now'),
      cost_usd = ?, cost_estimated = ?, input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_write_tokens = ?, num_turns = ?, duration_ms = ?, model = ?
    WHERE id = ?`)
    .run(status, String(log || '').slice(0, 20000),
      m.cost_usd ?? null, m.cost_estimated ? 1 : 0,
      m.input_tokens ?? null, m.output_tokens ?? null,
      m.cache_read_tokens ?? null, m.cache_write_tokens ?? null,
      m.num_turns ?? null, m.duration_ms ?? null, m.model ?? null, id);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS.

- [ ] **Step 6: Add the rate table + estimator to config**

In `src/config.js`, add named exports **above** the `export default` block:

```javascript
// Approximate list prices ($ per 1M tokens) used ONLY to estimate notional cost
// when claude -p omits total_cost_usd (e.g. on some subscription runs). Not a
// bill — the UI labels any estimated figure "est.". Tune freely; substring match
// tolerates dated model ids (e.g. "claude-haiku-4-5-20251001").
export const MODEL_RATES = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  default: { input: 3, output: 15 },
};

export function estimateCost(model, inputTokens = 0, outputTokens = 0) {
  const key = Object.keys(MODEL_RATES).find((k) => k !== 'default' && (model || '').includes(k)) || 'default';
  const r = MODEL_RATES[key];
  return (inputTokens / 1e6) * r.input + (outputTokens / 1e6) * r.output;
}
```

- [ ] **Step 7: Capture metrics in `agent.js`**

In `src/agent.js`, change the import line (`agent.js:2`) to also pull the estimator:

```javascript
import config, { estimateCost } from './config.js';
```

Inside `spawnAgent`, before the stdout handler, add two accumulators next to `let out = '', err = '', done = false, lineBuf = '';`:

```javascript
    let resultMeta = {}, model = null;
```

In the stdout line loop, right after `if (!line) continue;` parses `obj` (after the `let obj; try { obj = JSON.parse(line); } catch { continue; }` line, before `for (const ev of toEvents(obj))`):

```javascript
        if (obj.type === 'system' && obj.subtype === 'init') model = obj.model || model;
        if (obj.type === 'result') {
          const u = obj.usage || {};
          const input = u.input_tokens ?? null;
          const output = u.output_tokens ?? null;
          let cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
          let estimated = false;
          if (cost == null && (input != null || output != null)) {
            cost = estimateCost(model, input || 0, output || 0);
            estimated = true;
          }
          resultMeta = {
            cost_usd: cost, cost_estimated: estimated,
            input_tokens: input, output_tokens: output,
            cache_read_tokens: u.cache_read_input_tokens ?? null,
            cache_write_tokens: u.cache_creation_input_tokens ?? null,
            num_turns: obj.num_turns ?? null, duration_ms: obj.duration_ms ?? null,
            model,
          };
        }
```

In `finish(status)`, change the `finishRun` call (`agent.js:82`) to pass the metrics:

```javascript
      finishRun(db, runId, status, (out + err).slice(0, 20000), resultMeta);
```

- [ ] **Step 8: Make the stub emit usage**

In `bin/stub-claude.js`, replace the `result` helper (`stub-claude.js:18`):

```javascript
const result = (text) => emit({ type: 'result', subtype: 'success', is_error: false,
  num_turns: 2, duration_ms: 1234, total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  result: text });
```

- [ ] **Step 9: Write the failing capture tests in `test/agent.test.js`**

Append two tests. The first uses the real stub; the second an inline stub that omits `total_cost_usd` to exercise the estimate fallback.

```javascript
test('spawnAgent captures cost/token metrics from the result event', async () => {
  const STUB = new URL('../bin/stub-claude.js', import.meta.url).pathname;
  process.env.CLAUDE_BIN = 'node';
  const { spawnAgent } = await import('../src/agent.js?a2');
  const { openDb, latestRun } = await import('../src/store.js');
  const db = openDb(':memory:');
  const res = await spawnAgent(db, { kind: 'diagnose', prompt: 'DIAGNOSE task_id=1', tools: ['Bash'], _binOverride: STUB });
  assert.equal(res.status, 'ok');
  const r = latestRun(db, 'diagnose');
  assert.equal(r.cost_usd, 0.01);
  assert.equal(r.cost_estimated, 0);
  assert.equal(r.input_tokens, 100);
  assert.equal(r.output_tokens, 50);
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
```

- [ ] **Step 10: Run the full suite**

Run: `node --test`
Expected: PASS (existing tests unaffected — `finishRun`'s new arg is optional; unset `--model` keeps argv identical).

- [ ] **Step 11: Commit**

```bash
git add src/store.js src/config.js src/agent.js bin/stub-claude.js test/store.test.js test/agent.test.js
git commit --no-gpg-sign -m "feat(cost): capture per-run token/cost metrics from claude -p"
```

---

### Task 2: Truthful usage aggregation, API, and UI meter

**Files:**
- Modify: `src/store.js` (`usageToday`, `usageByDay`)
- Modify: `src/config.js` (`DAILY_BUDGET`)
- Modify: `src/routes.js` (reshape `/api/usage`; add `/api/usage/history`)
- Modify: `public/index.html` (honest meter + budget banner)
- Modify: `test/engine.test.js` (fix the usage-shape assertion)
- Test: `test/store.test.js`, `test/routes.test.js`

**Interfaces:**
- Consumes: metric columns from Task 1.
- Produces: `usageToday(db) → { by_kind: { <kind>: { kind, runs, cost_usd, cost_estimated, input_tokens, output_tokens } }, total: { runs, cost_usd, cost_estimated, input_tokens, output_tokens }, active }`.
- Produces: `usageByDay(db, days=14) → [{ date, runs, cost_usd, cost_estimated, input_tokens, output_tokens }]` oldest→newest.
- Produces: `GET /api/usage → { today: <usageToday>, budget: { daily_usd, over }, active, cap }`; `GET /api/usage/history?days=N → usageByDay`.

- [ ] **Step 1: Write failing aggregation tests in `test/store.test.js`**

```javascript
test('usageToday sums metrics across all run kinds, excluding skipped', () => {
  const d = db();
  const a = createRun(d, { kind: 'ingest' });
  finishRun(d, a, 'ok', '', { cost_usd: 0.02, input_tokens: 100, output_tokens: 20 });
  const b = createRun(d, { kind: 'diagnose' });
  finishRun(d, b, 'ok', '', { cost_usd: 0.05, input_tokens: 200, output_tokens: 30 });
  const s = createRun(d, { kind: 'ingest' });
  finishRun(d, s, 'skipped', 'quiet');
  const u = usageToday(d);
  assert.equal(u.by_kind.ingest.runs, 1);      // skipped excluded
  assert.equal(u.by_kind.diagnose.cost_usd, 0.05);
  assert.equal(Math.round(u.total.cost_usd * 100), 7); // 0.07
  assert.equal(u.total.input_tokens, 300);
});
```

Add `usageToday`, `usageByDay` to the store import list at the top of `test/store.test.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `usageToday is not a function`.

- [ ] **Step 3: Implement the aggregation queries**

Add to `src/store.js` (near `agentRunsToday`, keep that function — dispatch's concurrency gate still uses `activeAgentRuns`):

```javascript
export function usageToday(db) {
  const rows = db.prepare(`SELECT kind,
      COUNT(*) runs,
      COALESCE(SUM(cost_usd), 0) cost_usd,
      MAX(COALESCE(cost_estimated, 0)) cost_estimated,
      COALESCE(SUM(input_tokens), 0) input_tokens,
      COALESCE(SUM(output_tokens), 0) output_tokens
    FROM runs
    WHERE date(started_at) = date('now') AND status != 'skipped'
    GROUP BY kind`).all();
  const by_kind = {};
  const total = { runs: 0, cost_usd: 0, cost_estimated: 0, input_tokens: 0, output_tokens: 0 };
  for (const r of rows) {
    by_kind[r.kind] = r;
    total.runs += r.runs;
    total.cost_usd += r.cost_usd;
    total.input_tokens += r.input_tokens;
    total.output_tokens += r.output_tokens;
    total.cost_estimated = total.cost_estimated || r.cost_estimated;
  }
  return { by_kind, total, active: activeAgentRuns(db) };
}

export function usageByDay(db, days = 14) {
  const d = Math.max(1, Math.min(90, Number(days) || 14));
  return db.prepare(`SELECT date(started_at) date,
      COUNT(*) runs,
      COALESCE(SUM(cost_usd), 0) cost_usd,
      MAX(COALESCE(cost_estimated, 0)) cost_estimated,
      COALESCE(SUM(input_tokens), 0) input_tokens,
      COALESCE(SUM(output_tokens), 0) output_tokens
    FROM runs
    WHERE started_at >= datetime('now', ?) AND status != 'skipped'
    GROUP BY date(started_at) ORDER BY date(started_at)`).all(`-${d} days`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Add `DAILY_BUDGET` to config**

In `src/config.js` default export, add:

```javascript
  DAILY_BUDGET: Number(process.env.DAILY_BUDGET || 0),
```

- [ ] **Step 6: Reshape the `/api/usage` route + add history**

In `src/routes.js`, replace the existing `/api/usage` handler (`routes.js:137-142`):

```javascript
  r.get('/api/usage', async (_req, res) => {
    // Lazy import so requiring this router in tests (before CLAUDE_BIN is set)
    // doesn't eagerly evaluate config.js's env capture.
    const { default: config } = await import('./config.js');
    const today = store.usageToday(db);
    const daily = config.DAILY_BUDGET;
    const over = daily > 0 && today.total.cost_usd > daily;
    res.json({ today, budget: { daily_usd: daily, over }, active: today.active, cap: config.MAX_AGENT_CONCURRENCY });
  });

  r.get('/api/usage/history', (req, res) => {
    res.json(store.usageByDay(db, req.query.days));
  });
```

- [ ] **Step 7: Write the failing route test in `test/routes.test.js`**

Follow that file's existing boot pattern (mirror how it constructs `makeRouter` + `app.listen(0)`; reuse its helper). Add:

```javascript
test('GET /api/usage returns shaped totals and over-budget flag', async () => {
  process.env.DAILY_BUDGET = '0.01';
  const { db, base, server } = await bootRoutes(); // use this file's existing boot helper
  const runId = createRun(db, { kind: 'ingest' });
  finishRun(db, runId, 'ok', '', { cost_usd: 0.5, input_tokens: 10, output_tokens: 5 });
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(u.today.total.cost_usd, 0.5);
  assert.equal(u.budget.over, true);
  assert.equal(u.cap, 2);
  const h = await (await fetch(`${base}/api/usage/history?days=7`)).json();
  assert.ok(Array.isArray(h));
  server.close();
  delete process.env.DAILY_BUDGET;
});
```

> Note: if `test/routes.test.js` has no reusable boot helper, construct the server inline exactly as the other tests in that file do (`const app = express(); app.use(express.json()); app.use(makeRouter(db, {})); const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });`), and `import { openDb, createRun, finishRun } from '../src/store.js'`.

- [ ] **Step 8: Run to verify it fails, then passes after Step 6 is in place**

Run: `node --test test/routes.test.js`
Expected: PASS once the route is implemented (write test first, confirm FAIL on old shape, then it PASSes).

- [ ] **Step 9: Fix the now-stale engine usage test**

In `test/engine.test.js`, the test `usage endpoint counts agent runs for today` (`engine.test.js:238-249`) asserts the old flat shape. Replace its assertions (`engine.test.js:245-247`):

```javascript
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.equal(u.today.by_kind.diagnose.runs >= 1, true);
  assert.equal(u.cap, 2);
```

- [ ] **Step 10: Update the UI meter + add a budget banner**

In `public/index.html`:

Add a second banner element right after the existing banner (`index.html:62`), using an amber warning style (distinct from the red fail banner):

```html
<div class="banner" id="budgetbanner" style="background:#b7791f;"><span id="budgetmsg"></span><button type="button" class="banner-x" title="Dismiss" onclick="dismissBudgetBanner()">✕</button></div>
```

Replace the usage line (`index.html:101-102`) and add the budget banner logic:

```javascript
  const u = await (await fetch('/api/usage')).json();
  const t = u.today.total;
  const tok = (t.input_tokens + t.output_tokens);
  const dollars = t.cost_usd ? `${t.cost_estimated ? '~$' : '$'}${t.cost_usd.toFixed(2)}${t.cost_estimated ? ' est.' : ''}` : '$0.00';
  document.getElementById('usage').textContent = `agents: ${u.active}/${u.cap} · ${dollars} · ${tok.toLocaleString()} tok today`;
  const bb = document.getElementById('budgetbanner');
  const showBudget = u.budget.over && localStorage.getItem('budgetBannerDismissed') !== new Date().toDateString();
  bb.style.display = showBudget ? 'flex' : 'none';
  if (showBudget) document.getElementById('budgetmsg').textContent =
    `Today's est. spend ${dollars} exceeds your $${u.budget.daily_usd} budget. Scheduled jobs are still running.`;
```

Add the dismiss handler next to `dismissBanner` (`index.html:85-88`):

```javascript
function dismissBudgetBanner() {
  localStorage.setItem('budgetBannerDismissed', new Date().toDateString());
  document.getElementById('budgetbanner').style.display = 'none';
}
```

- [ ] **Step 11: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/store.js src/config.js src/routes.js public/index.html test/store.test.js test/routes.test.js test/engine.test.js
git commit --no-gpg-sign -m "feat(cost): truthful /api/usage across all kinds + UI meter and budget banner"
```

---

### Task 3: Per-job model selection

**Files:**
- Modify: `src/agent.js` (`--model` passthrough)
- Modify: `src/config.js` (`MODEL_*`)
- Modify: `src/cron.js` (pass models for ingest/digest/reply)
- Modify: `src/dispatch.js` (pass models for diagnose/execute)
- Modify: `.env.example`
- Test: `test/agent.test.js`

**Interfaces:**
- Consumes: `spawnAgent` from Task 1.
- Produces: `spawnAgent(db, { ..., model })` — appends `--model <model>` only when `model` is a non-empty string.
- Produces: `config.MODEL_INGEST | MODEL_DIGEST | MODEL_REPLY | MODEL_DIAGNOSE | MODEL_EXECUTE` (default `''`).

- [ ] **Step 1: Write the failing passthrough test in `test/agent.test.js`**

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/agent.test.js`
Expected: FAIL — `--model` never appears.

- [ ] **Step 3: Add `model` to `spawnAgent`**

In `src/agent.js`, add `model` to the destructured opts (`agent.js:49`):

```javascript
export function spawnAgent(db, { kind, task_id = null, prompt, tools = ['Bash'], cwd, timeoutMs = 300000, model, _binOverride } = {}) {
```

After the `agentArgs` line (`agent.js:70`), append the flag conditionally:

```javascript
    if (model) agentArgs.push('--model', model);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/agent.test.js`
Expected: PASS.

- [ ] **Step 5: Add the `MODEL_*` config**

In `src/config.js` default export:

```javascript
  MODEL_INGEST: process.env.MODEL_INGEST || '',
  MODEL_DIGEST: process.env.MODEL_DIGEST || '',
  MODEL_REPLY: process.env.MODEL_REPLY || '',
  MODEL_DIAGNOSE: process.env.MODEL_DIAGNOSE || '',
  MODEL_EXECUTE: process.env.MODEL_EXECUTE || '',
```

- [ ] **Step 6: Wire cron + dispatch to pass models**

In `src/cron.js`, add `model` to each `spawnAgent` call:
- `runIngest` (`cron.js:13`): add `model: config.MODEL_INGEST,`
- `runDigest` (`cron.js:27`): add `model: config.MODEL_DIGEST,`
- `runReply` (`cron.js:36`): add `model: config.MODEL_REPLY,`

In `src/dispatch.js`, add `model` to the two `spawnAgent` calls (`config` is already imported):
- diagnose spawn (`dispatch.js:38`): add `model: config.MODEL_DIAGNOSE,`
- execute spawn (`dispatch.js:77`): add `model: config.MODEL_EXECUTE,`

- [ ] **Step 7: Document in `.env.example`**

Append to `.env.example`:

```bash
# Optional per-job model override. Unset = the subscription default (current
# behavior). Downgrading ingest (e.g. to a cheaper model) risks relevance-
# judging quality — measure the cost/quality tradeoff via the usage meter first.
# MODEL_INGEST=
# MODEL_DIGEST=
# MODEL_REPLY=
# MODEL_DIAGNOSE=
# MODEL_EXECUTE=
# Daily notional-$ budget; shows a warning banner when exceeded. 0/unset = off.
# DAILY_BUDGET=
```

- [ ] **Step 8: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/agent.js src/config.js src/cron.js src/dispatch.js .env.example test/agent.test.js
git commit --no-gpg-sign -m "feat(cost): optional per-job model selection (default unchanged)"
```

---

### Task 4: Slack "anything new?" pre-check module

**Files:**
- Create: `src/slack.js`
- Modify: `src/config.js` (`SLACK_API_BASE`)
- Test: `test/slack.test.js`

**Interfaces:**
- Produces: `hasNewSince(hwm, { baseUrl, token } = {}) → Promise<boolean>`. `baseUrl` defaults to `config.SLACK_API_BASE`, `token` to `config.SLACK_USER_TOKEN`. Returns `true` when there is new activity, `false` when quiet, and `true` (fail-open) on any error or when `hwm` is falsy.

- [ ] **Step 1: Add `SLACK_API_BASE` to config**

In `src/config.js` default export:

```javascript
  SLACK_API_BASE: process.env.SLACK_API_BASE || 'https://slack.com/api',
```

- [ ] **Step 2: Write the failing test with a fake Slack server**

Create `test/slack.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

async function fakeSlack(handlers) {
  const app = express();
  app.get('/users.conversations', (_req, res) => res.json(handlers.conversations()));
  app.get('/conversations.history', (req, res) => res.json(handlers.history(req.query.channel)));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, server };
}

test('hasNewSince returns true when a conversation has a new message', async () => {
  const { hasNewSince } = await import('../src/slack.js');
  const { baseUrl, server } = await fakeSlack({
    conversations: () => ({ ok: true, channels: [{ id: 'C1' }, { id: 'C2' }] }),
    history: (c) => c === 'C2' ? ({ ok: true, messages: [{ ts: '9.9' }] }) : ({ ok: true, messages: [] }),
  });
  assert.equal(await hasNewSince('1.0', { baseUrl, token: 'x' }), true);
  server.close();
});

test('hasNewSince returns false when every conversation is empty', async () => {
  const { hasNewSince } = await import('../src/slack.js');
  const { baseUrl, server } = await fakeSlack({
    conversations: () => ({ ok: true, channels: [{ id: 'C1' }, { id: 'C2' }] }),
    history: () => ({ ok: true, messages: [] }),
  });
  assert.equal(await hasNewSince('1.0', { baseUrl, token: 'x' }), false);
  server.close();
});

test('hasNewSince fails open (true) on a Slack error and on missing hwm', async () => {
  const { hasNewSince } = await import('../src/slack.js');
  const { baseUrl, server } = await fakeSlack({
    conversations: () => ({ ok: false, error: 'ratelimited' }),
    history: () => ({ ok: true, messages: [] }),
  });
  assert.equal(await hasNewSince('1.0', { baseUrl, token: 'x' }), true);
  assert.equal(await hasNewSince(null, { baseUrl, token: 'x' }), true);
  server.close();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/slack.test.js`
Expected: FAIL — `Cannot find module '../src/slack.js'`.

- [ ] **Step 4: Implement `src/slack.js`**

```javascript
import config from './config.js';

// Cheap, LLM-free "is there anything new since the high-water-mark?" probe used
// to skip an expensive ingest spawn on quiet ticks. Walks the user's
// conversations and asks each for a single message newer than `hwm`, early-
// exiting on the first hit. Fails OPEN (returns true) on any error so a Slack
// outage never silently suppresses ingest.
export async function hasNewSince(hwm, { baseUrl = config.SLACK_API_BASE, token = config.SLACK_USER_TOKEN } = {}) {
  if (!hwm) return true;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  try {
    const convRes = await fetch(`${baseUrl}/users.conversations?types=public_channel,private_channel,im,mpim&limit=200`, auth);
    const conv = await convRes.json();
    if (!conv.ok) return true;
    for (const c of conv.channels || []) {
      const hRes = await fetch(`${baseUrl}/conversations.history?channel=${encodeURIComponent(c.id)}&oldest=${encodeURIComponent(hwm)}&limit=1`, auth);
      const h = await hRes.json();
      if (!h.ok) return true;                 // can't be sure it's quiet — fail open
      if ((h.messages || []).length > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/slack.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/slack.js src/config.js test/slack.test.js
git commit --no-gpg-sign -m "feat(ingest): LLM-free Slack 'anything new?' pre-check (fail-open)"
```

---

### Task 5: Skip ingest when quiet, force full run every N hours

**Files:**
- Modify: `src/cron.js` (`runIngest` skip logic)
- Modify: `src/config.js` (`INGEST_MAX_QUIET_MS`)
- Test: `test/cron.test.js`

**Interfaces:**
- Consumes: `hasNewSince` (Task 4), `createRun`/`finishRun`/`getMeta`/`setMeta` (store), `config.INGEST_MAX_QUIET_MS`, `config.MODEL_INGEST` (Task 3).
- Produces: `runIngest(db, { hasNew = hasNewSince, now = Date.now } = {})` — injectable clock + quiet-check for tests. On a quiet, non-stale tick it records a `status:'skipped'` ingest run and does **not** spawn `claude`; otherwise it runs the full LLM ingest and stamps `ingest_last_full`.

- [ ] **Step 1: Add `INGEST_MAX_QUIET_MS` to config**

In `src/config.js` default export:

```javascript
  // Even when Slack looks quiet, force a full LLM ingest at least this often so
  // the PR-merge sweep and any missed edges still run. Default 3h.
  INGEST_MAX_QUIET_MS: Number(process.env.INGEST_MAX_QUIET_MS || 10800000),
```

- [ ] **Step 2: Write failing cron tests**

Create `test/cron.test.js`. The stub records nothing on skip; we assert via `latestRun('ingest').status`.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, latestRun, setMeta } from '../src/store.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stub-claude.js');

test('runIngest skips the LLM spawn when quiet and not stale', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c1');
  const db = openDb(':memory:');
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => false, now: () => 1_000_000 + 60_000 }); // 1 min later
  assert.equal(latestRun(db, 'ingest').status, 'skipped');
});

test('runIngest runs the full LLM ingest when quiet but stale', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c2');
  const db = openDb(':memory:');
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => false, now: () => 1_000_000 + 4 * 3600_000 }); // 4h later > 3h
  assert.equal(latestRun(db, 'ingest').status, 'ok');
});

test('runIngest runs the full LLM ingest when Slack has new activity', async () => {
  process.env.CLAUDE_BIN = STUB;
  const { runIngest } = await import('../src/cron.js?c3');
  const db = openDb(':memory:');
  setMeta(db, 'ingest_hwm', '100.0');
  setMeta(db, 'ingest_last_full', String(1_000_000));
  await runIngest(db, { hasNew: async () => true, now: () => 1_000_000 + 60_000 });
  assert.equal(latestRun(db, 'ingest').status, 'ok');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/cron.test.js`
Expected: FAIL — `runIngest` ignores the options and always spawns (first test gets `ok`, not `skipped`).

- [ ] **Step 4: Implement the skip logic in `cron.js`**

Update the imports at the top of `src/cron.js`:

```javascript
import { acquireLock, releaseLock, getTask, getMeta, setMeta, createRun, finishRun } from './store.js';
import { spawnAgent } from './agent.js';
import { ingestPrompt, digestPrompt, replyPrompt } from './prompts.js';
import { hasNewSince } from './slack.js';
```

Replace `runIngest` (`cron.js:10-23`):

```javascript
export async function runIngest(db, { hasNew = hasNewSince, now = Date.now } = {}) {
  if (!acquireLock(db, 'ingest')) return;
  try {
    const hwm = getMeta(db, 'ingest_hwm');
    const lastFull = Number(getMeta(db, 'ingest_last_full')) || 0;
    const stale = (now() - lastFull) >= config.INGEST_MAX_QUIET_MS;
    // Skip the expensive LLM spawn only when we have a watermark (i.e. not the
    // first-run bootstrap), it isn't time for the forced full sweep, and Slack
    // genuinely has nothing new. Record a lightweight 'skipped' run so the UI
    // shows "skipped (quiet)" instead of looking dead.
    if (hwm && !stale && (await hasNew(hwm)) === false) {
      const runId = createRun(db, { kind: 'ingest' });
      finishRun(db, runId, 'skipped', 'quiet: no new Slack messages since high-water-mark');
      return;
    }
    await spawnAgent(db, {
      kind: 'ingest',
      model: config.MODEL_INGEST,
      prompt: ingestPrompt({
        apiBase: apiBase(),
        overlapMs: config.INGEST_OVERLAP_MS,
        bootstrapMs: config.INGEST_BOOTSTRAP_MS,
      }),
      timeoutMs: config.INGEST_TIMEOUT_MS,
    });
    setMeta(db, 'ingest_last_full', String(now()));
  } finally { releaseLock(db, 'ingest'); }
}
```

(Leave `startSchedules` calling `runIngest(db)` — the defaults apply in production.)

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/cron.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cron.js src/config.js test/cron.test.js
git commit --no-gpg-sign -m "feat(ingest): skip LLM ingest on quiet ticks, force a full run every 3h"
```

---

## Self-Review

**Spec coverage:**
- Cost accounting (capture, tokens-as-truth, $ fallback, schema, aggregation counting all kinds, API, UI, stub, tests) → Tasks 1 & 2. ✓
- Skip-ingest-when-quiet (`src/slack.js` `hasNewSince`, forced-full via `INGEST_MAX_QUIET_MS`, `ingest_last_full`, `skipped` run row, fail-open) → Tasks 4 & 5. ✓
- Model tiering (per-job `MODEL_*` default unset, `--model` passthrough, wired cron+dispatch, `.env.example`) → Task 3. ✓
- Budget behavior (track + display + soft-cap banner, scheduled jobs not paused) → Task 2 (route `over` flag + UI budget banner). ✓
- Files-touched table in the spec all appear across Tasks 1–5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; the one prose note (routes boot helper) points at the concrete inline pattern used elsewhere in that file. ✓

**Type consistency:** `finishRun(db, id, status, log, metrics)` used consistently (Tasks 1, 2, 5). `usageToday`/`usageByDay` shapes match between store impl, route, and UI reads (`u.today.total.*`, `u.today.by_kind.*`, `u.budget.over`, `u.budget.daily_usd`). `hasNewSince(hwm, {baseUrl, token})` signature matches its test and its `runIngest` call (`hasNew(hwm)`). `spawnAgent({ model })` matches Task 3 test and the cron/dispatch call sites. `skipped` status string is consistent across cron write, store aggregation filter, and UI. ✓
