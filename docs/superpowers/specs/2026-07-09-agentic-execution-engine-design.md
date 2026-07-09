# Agentic Execution Engine — Design

**Date:** 2026-07-09
**Status:** Approved (pending spec review)
**Project:** `~/projects/tasklist-agent` (extends the existing local task dashboard)
**Builds on:** `docs/superpowers/specs/2026-07-09-tasklist-agent-design.md`

## 1. Purpose

Turn the task dashboard into a **unified agent dashboard**: every task is a thread you
and Claude Code agents collaborate in. From a task you can **dispatch an agent** to
diagnose and fix a bug in one of your repos — it investigates, proposes a plan, waits for
your approval, then executes the fix in an isolated git worktree and opens a **draft PR**,
streaming progress into the task thread the whole way.

This must stay useful independent of any employer: nothing is bluerobins-specific, and the
set of repos an agent may touch is a **user-editable allow-list**.

**Same hard constraint as the base app:** all agent reasoning runs through headless
**Claude Code (`claude -p`)**, billed to the subscription — never the paid Anthropic API.

## 2. Scope

**v1 ships one agent mode — `code`** (diagnose/fix in a repo) — on top of a **generic run
lifecycle**. Additional modes (research, draft-doc, draft-reply) are future work and, by
design, require only a new prompt + tool profile in `agent-modes.js`; no lifecycle changes.

Out of scope for v1 (YAGNI): non-code modes; multi-repo changes in one run; auto-merge or
any push to a protected branch; editing the user's working checkout; parallel agents on the
same task.

## 3. The loop (per task, in its thread)

```
dispatch → diagnose → plan → [you approve] → execute → report
```

- **Dispatch.** On a task, "Hand to agent" → choose a **repo** (from the allow-list), a
  **base branch** (default: the repo's `default_branch`), and a **mode** (`code`).
- **Diagnose (read-only).** Spawns `claude -p` in a **fresh git worktree** off the base
  branch, tool profile = `Bash, Read, Grep` (no writes). It investigates and posts
  **root cause + a proposed fix plan** as an `agent` comment. Task → `awaiting_approval`.
- **Approve.** The thread shows **Approve / Edit-plan / Cancel**. Approving (optionally with
  an edited plan) spawns the **execute** run.
- **Execute (autonomous).** Reuses the same worktree, tool profile = `Bash, Read, Write,
  Edit`. Follows TDD, runs the repo's tests, commits, opens a **draft PR**, and posts the PR
  URL + summary. Worktree is then cleaned up. Task → `done` (or `failed`).
- **Streaming.** Both phases post interim `agent` comments into the thread as they work
  (the agent already can `POST` to the local API; v1 widens its tool profile and instructs
  it to post progress). The page's existing 3s poll renders them live.

Because `claude -p` is **stateless per invocation**, each phase is a **fresh spawn** handed
its context from the thread (the base branch, the worktree path, and — for execute — the
approved plan text). No paused long-lived process to keep alive.

## 4. Data model additions

New table:
- `repos(id, name, path UNIQUE, default_branch, added_at)` — the editable allow-list.

`tasks` gains (all nullable / defaulted, additive):
- `repo_id` (FK → repos), `agent_mode` (text, e.g. `code`), `base_branch` (text),
  `agent_phase` (text: `idle`|`diagnosing`|`awaiting_approval`|`executing`|`done`|`failed`,
  default `idle`), `worktree_path` (text), `pr_url` (text).

`runs` changes:
- `kind` now also takes `diagnose` and `execute` (alongside `ingest`/`reply`/`digest`).

Migration is additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` style (SQLite: guarded
`ALTER` in `openDb`), preserving the base app's existing schema.

## 5. HTTP API additions

- `GET/POST/DELETE /api/repos` — list / add (validate path is a git repo, read
  `default_branch`) / remove allow-listed repos.
- `POST /api/tasks/:id/dispatch` — body `{repo_id, base_branch?, mode}` → creates the
  worktree, sets `agent_phase='diagnosing'`, spawns the diagnose run. 409 if the task
  already has an active agent run.
- `POST /api/tasks/:id/approve` — body `{plan?}` (optional edited plan) → only valid when
  `awaiting_approval`; spawns the execute run.
- `POST /api/tasks/:id/cancel` — kills the in-flight child for this task, cleans the
  worktree, sets `agent_phase='failed'` (or back to `idle` if pre-execute).
- `GET /api/usage` — today's agent-run count + active-run count (for the UI cost view).

## 6. Interaction surface

- **Task detail = thread.** Existing comment thread, plus: a **status pill** (`diagnosing…`
  / `awaiting approval` / `executing…` / `PR ready` / `failed`), a **plan card** when
  `awaiting_approval` with **Approve / Edit-plan / Cancel**, live agent progress comments,
  and the **draft-PR link** on completion.
- **Dispatch control** on each task: "Hand to agent" → repo picker + base-branch + mode.
- **Repos settings page**: add/remove repo paths; each add validates it's a git worktree
  and stores its default branch.
- **Usage indicator**: today's run count + "N running" from `GET /api/usage`.

## 7. Guardrails & cost

- Agents may only act on **allow-listed repos**. Execute always runs in a **fresh worktree**
  off the base branch — the user's working checkout is never modified.
- **Draft PR only** (`gh pr create --draft`). **Never** push to `main`/`master`, never
  force-push, never merge. If the repo has **no remote**, leave the local branch + commits
  and report the branch name/path instead of opening a PR.
- **Phase-aware, cancellable timeouts** replace the base app's fixed 5-min kill:
  diagnose ≈ 10 min, execute ≈ 45 min. Values live in config. A cancelled/timed-out run
  SIGKILLs the child, marks the run `failed`, and cleans the worktree.
- **Concurrency cap: 2** simultaneous agent runs (config), to bound token burn; further
  dispatches queue or 409 with a "busy" message. Diagnosis is auto-run (cheap); the
  **expensive execute step is gated by your approval**.
- **Secrets:** the child env is built from a scrubbed copy (no `ANTHROPIC_*`, per base app),
  plus only what the mode needs. Run logs (which may capture tool output) stay local and
  are not rendered to the thread verbatim.

## 8. What's reused vs new

**Reused:** `spawnAgent` + run-tracking + boot `reconcile` (extended to clean orphaned
worktrees too), the localhost API + polling UI, the stub-`claude` test pattern.

**Extended:** `spawnAgent(db, {kind, task_id, prompt, tools, cwd, timeoutMs})` — adds a
**tool profile** (`--allowedTools` list), a **working directory** (the worktree), a
**phase-aware timeout**, and **cancellation** via an in-memory registry mapping `run.id →
child process` (so `/cancel` can find and kill it). On process exit the registry entry is
removed.

**New modules:**
- `src/agent-modes.js` — per-mode `{ diagnosePrompt, executePrompt, diagnoseTools,
  executeTools }`. v1 defines `code`.
- `src/worktree.js` — `create(repoPath, baseBranch) → {worktreePath, branch}`,
  `cleanup(worktreePath)`, `listStale()`; worktrees live under a scratch dir, on a fresh
  branch named e.g. `agent/task-<id>-<shortts>`.
- `src/repos.js` — allow-list CRUD + git validation (`git -C <path> rev-parse`, read
  default branch).
- Routes for §5; a `src/dispatch.js` orchestrating phase transitions (mirrors `cron.js`'s
  lock-guarded run pattern, one lock per task: `agent:<taskId>`).

## 9. Error handling

- Dispatch on a non-git or missing repo path → 400, no run.
- Diagnose/execute child crash or timeout → run `failed`, worktree cleaned, `agent_phase`
  = `failed`, thread gets a `system` comment with the failure + a **Retry** affordance.
- `approve` when not `awaiting_approval`, or `dispatch` when already active → 409.
- Boot `reconcile` also removes worktrees for tasks left mid-run and marks them `failed`
  (extends the base app's lock/run reconciliation).
- `gh` not installed / not authed → execute still commits locally, reports "PR step
  skipped: gh unavailable" with the branch name.

## 10. Testing

Follows the base app's stubbed-`claude` pattern — **no subscription used**:
- A **git repo fixture** (created in a temp dir in-test) stands in for an allow-listed repo.
- The **stub `claude`**, keyed on `DIAGNOSE`/`EXECUTE` prompt markers, posts a canned plan
  comment (diagnose) and, for execute, makes a commit in the worktree + posts a summary.
- Assert: dispatch creates a worktree + `diagnosing` phase; diagnose → `awaiting_approval`
  with a plan comment; **execute does not run until `approve`**; execute commits in the
  worktree (not the source checkout) and never touches `main`; worktree cleanup on
  done/cancel; concurrency cap enforced; boot reconcile cleans a mid-run worktree.
- `repos.js` unit tests: validating a real temp git repo vs a non-git dir.

## 11. Build phases

1. **Repos allow-list** — `repos` table, `repos.js`, `/api/repos`, settings UI. Standalone.
2. **Worktree + spawnAgent extension** — `worktree.js`, extend `spawnAgent` (tools/cwd/
   timeout/cancellation registry), reconcile worktree cleanup.
3. **Diagnose phase** — `agent-modes.js` (`code` diagnose), `dispatch.js`, `/dispatch`,
   thread status pill + progress rendering.
4. **Approve + execute phase** — plan card + Approve/Edit/Cancel, `/approve`, `/cancel`,
   execute prompt/tools, draft-PR flow, `pr_url` in thread.
5. **Usage/cost view** — `/api/usage`, concurrency cap, per-day counter in UI.

## 12. Open defaults (recorded; easy to change later)

- Worktree branch name: `agent/task-<id>-<shortts>`; worktrees under a config scratch dir.
- Timeouts: diagnose 10 min, execute 45 min. Concurrency cap: 2.
- Base branch default = repo `default_branch`; user may override per dispatch.
