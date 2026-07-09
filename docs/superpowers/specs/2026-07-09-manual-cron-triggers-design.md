# Manual cron triggers — design

**Date:** 2026-07-09
**Status:** approved (design)

## Problem

The two scheduled jobs — Slack **ingest** (`*/30 * * * *`) and Discord **digest**
(`0 8 * * *`) — can only run on their cron schedule. There's no way to kick one off
on demand from the dashboard (e.g. "pull Slack now", "send the digest now"). Add a
button for each.

## Scope

- Manual trigger for `ingest` ("Pull Slack") and `digest` ("Run digest").
- Reuse the existing `runIngest`/`runDigest` functions unchanged.
- Minimal feedback: transient button state + a small last-run status label per job.

Out of scope: manual reply runs (already on-demand via `@claude`), scheduling
changes, new job types.

## Design

### Backend

`src/cron.js` already exposes `runIngest(db)` and `runDigest(db)`. Both begin with
`acquireLock(db, kind)` and no-op if the lock is held, so a manual trigger is safe
against a concurrent scheduled run or a double-click — it simply does nothing when a
run of that job is already in flight.

**New route** in `src/routes.js`:

```
POST /api/run/:job        job ∈ { ingest, digest }
```

- Validate `:job` against the allow-list `['ingest', 'digest']`; unknown → `400
  { error: 'unknown job' }`.
- Fire the work via `setImmediate(() => Promise.resolve(onRunJob(job)).catch(...))`,
  matching the existing dispatch/reply fire-and-forget pattern (never block the
  response, never crash on rejection).
- Respond `200 { ok: true }`.

`makeRouter` gains an `onRunJob` callback in its options object, alongside
`onCommentAgent`/`onDispatch`/`onApprove`/`onCancel`.

**Wiring** in `server.js`:

```js
const onRunJob = (job) => (job === 'ingest' ? runIngest(db) : runDigest(db));
```

`server.js` currently imports only `runReply` from `./cron.js`; add `runIngest` and
`runDigest` to that import.

### Frontend (`public/index.html`)

Two buttons in the header, after the tabs (or next to the usage counter):

```
[ Pull Slack ]  [ Run digest ]
```

On click (`runJob('ingest'|'digest', btn)`):
1. Disable the button and set its label to `Pulling…` / `Running…`.
2. `POST /api/run/:job`.
3. Re-enable + restore the label after a short delay (~1.5s). Live state comes from
   the existing 3s `/api/status` poll, not from awaiting the job.

**Status label:** extend `loadStatusBanner()` (which already fetches `/api/status`
returning `{ ingest: latestRun, digest: latestRun }`) to render a small per-job
label near the buttons, e.g. `ingest: ok · 14:30` / `digest: failed · 08:00`, using
each run's `status` and `finished_at`. The existing red failure banner for a failed
ingest stays as-is.

No new polling loop — reuse the 3s interval already in place.

### Tests (`test/integration.test.js`)

- `POST /api/run/ingest` → `200 { ok: true }` and the `onRunJob` callback is invoked
  with `'ingest'` (spy/stub, same style as existing dispatch/reply tests).
- `POST /api/run/digest` → invokes callback with `'digest'`.
- `POST /api/run/bogus` → `400`, callback not invoked.

## Files touched

- `src/routes.js` — new `POST /api/run/:job` route + `onRunJob` option.
- `server.js` — import `runIngest`/`runDigest`, define `onRunJob`, pass it in.
- `public/index.html` — two buttons, `runJob()` handler, per-job status label.
- `test/integration.test.js` — route tests.

## Risks / notes

- Lock contention is a feature, not a bug: triggering a job that's already running is
  a silent no-op. The button's transient state doesn't claim success — the status
  label (driven by real run records) tells the truth once the run finishes.
