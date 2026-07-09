# tasklist-agent

A local, always-on task dashboard at **`http://tasklist`** that reads your Slack,
turns it into a deduplicated task list you can check off / comment on in the browser,
lets you ask Claude for help per-task, and pushes a daily digest to Discord.

**No paid API.** All the "intelligence" runs through **headless Claude Code
(`claude -p`)**, billed to your existing Claude Code subscription — never the
Anthropic API. Slack's Web API and Discord webhooks are free.

## How it works

A Node + Express server (bound to `127.0.0.1`, kept alive by macOS `launchd`) owns a
SQLite store and serves one HTML page. It has no LLM logic itself — it spawns
`claude -p` for three jobs, and those runs talk back over the localhost API:

- **Ingest — every 30 min:** reads your Slack (public/private channels, DMs, mentions)
  via your user token, extracts action items, upserts them as tasks (deduped by
  `channel:message-ts`).
- **Reply — on demand:** comment `@claude …` on a task → a `claude -p` run answers in
  that task's thread (and can search Slack / draft for you). The page polls and shows it.
- **Digest — daily 08:00:** summarizes tasks + Slack highlights and posts to Discord.

## Prerequisites

- macOS, Node ≥18, and the `claude` CLI installed and logged into your subscription.
- **Slack user token** (`xoxp-…`): create a Slack app → *User Token Scopes*:
  `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `search:read`
  → install to your workspace → copy the token.
- **Discord webhook URL**: target channel → *Integrations → Webhooks → New Webhook* → copy URL.

## Setup (one-time)

```bash
cd ~/projects/tasklist-agent
npm install
cp .env.example .env        # then edit: SLACK_USER_TOKEN=..., DISCORD_WEBHOOK_URL=...
./setup.sh                  # writes /etc/hosts + pf redirect (sudo), installs the launchd agent
```

`setup.sh` also pins an absolute `CLAUDE_BIN` into `.env` and a working `PATH` into the
launchd plist so the always-on service can find `claude`/`node`. Then open
**http://tasklist** (fallback if you skip the `pf` step: **http://tasklist:8787**).

## First-run checklist (important — tests pass with a stub, so verify the *real* path)

The automated suite exercises a stubbed `claude`; these only surface on a live run:

1. **Tool permission.** Runs are spawned with `--allowedTools Bash` so `claude -p` can
   `curl`. Sanity-check once by hand: `SLACK_USER_TOKEN=… TASKLIST_API=http://127.0.0.1:8787 claude -p "$(node -e 'import("./src/prompts.js").then(m=>console.log(m.ingestPrompt({apiBase:"http://127.0.0.1:8787"})))')" --allowedTools Bash --output-format json` and confirm it actually hits Slack + posts tasks.
2. **Run under launchd, not just your shell** — PATH differs. Check `launchctl list | grep tasklist` shows a PID, and watch `logs/err.log`.
3. **Slack mentions query** in `src/prompts.js` (`search.messages?query=to:me`) may need
   your real handle/user-id; adjust if mentions don't show up.
4. **Watch the Open list** over the first hour or two for duplicates (dedup is keyed on
   `channel + message-ts`).

## Tunables

- Schedules: `src/cron.js` (`*/30 * * * *` ingest, `0 8 * * *` digest).
- What counts as an action item / digest format: `src/prompts.js`.
- Port: `PORT` in `.env` (default 8787).

## Uninstall

```bash
./teardown.sh    # unloads launchd agent, removes hosts entry + pf redirect
```

## Notes & known follow-ups

- **Dedup key** is `channel:message-ts` (not the task title). This deliberately deviates
  from the original spec's title-based fingerprint: titles are LLM-generated and change
  each ingest, which would flood duplicates. Trade-off: two action items in the *same*
  Slack message collapse to one task.
- The localhost API has no auth — fine for a single-user `127.0.0.1` tool. Don't rebind
  to `0.0.0.0` without adding auth (a `@claude` comment spawns a subscription-billed run).
- Minor deferred: on a catastrophic SQLite error (disk full/corruption) a lock acquire can
  throw unhandled in the cron/reply callbacks; it self-heals on the next launchd restart
  (boot reconcile clears stale locks). Wrap those callbacks in `.catch()` when convenient.

Full design + build history: `docs/superpowers/specs/` and `docs/superpowers/plans/`.
