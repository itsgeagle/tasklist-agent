import fs from 'node:fs';
import config from './config.js';

const SLACK_SCOPES = 'channels/groups/im/mpim:history, channels/groups/im/mpim:read, users:read, search:read';

// Read the tunable personal-context file fresh each call so edits to context.md
// take effect on the next run without restarting the service. Prefer context.md,
// fall back to the committed example, then to a minimal inline default.
export function loadContext() {
  for (const p of [config.CONTEXT_PATH, config.CONTEXT_EXAMPLE_PATH]) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    } catch { /* missing/unreadable — try next */ }
  }
  return '- Role: (no context.md found — see context.example.md)';
}

export function ingestPrompt({ apiBase, overlapMs = 600000, bootstrapMs = 604800000 }) {
  const overlapSec = Math.round(overlapMs / 1000);
  const bootstrapSec = Math.round(bootstrapMs / 1000);
  return `INGEST — Slack → tasklist (incremental reconcile).
You have SLACK_USER_TOKEN in env (scopes: ${SLACK_SCOPES}) and the local API at ${apiBase}.
Use Bash + curl + gh only. Do NOT use any Anthropic API. Do NOT use jq — build JSON with python3.

WHO I AM / WHAT'S RELEVANT TO ME (use this to judge what to surface):
${loadContext()}

GOAL: look only at what's NEW since the last run and reconcile it against the
existing tasklist — new items become tasks, updates fold into the task they
belong to, completed things get marked done, and tasks whose PR merged get closed.

Steps:
1. Read state:
   - High-water-mark: curl -s ${apiBase}/api/meta/ingest_hwm  → {"value": "<slack ts>" | null}.
     Compute the fetch floor OLDEST = (value − ${overlapSec}s overlap) if value is set,
     else now − ${bootstrapSec}s (first-run bootstrap). Slack ts is unix seconds with a
     ".xxxxxx" suffix; do the arithmetic on the integer-seconds part with python3.
   - Open tasks: curl -s "${apiBase}/api/tasks?status=open" — this is what you reconcile against.
     Note each task's id, source_thread_ts, and pr_url.
2. List my conversations:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200"
3. For each conversation id C, fetch only new messages:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.history?channel=C&oldest=OLDEST&limit=200"
   For any thread that saw new activity, also pull replies:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.replies?channel=C&ts=THREAD_TS&oldest=OLDEST"
4. Select messages RELEVANT TO ME (relevance is broader than a direct @-mention):
   a. Direct @-mentions of me, and DMs to me.
   b. @channel / @here / @everyone announcements in channels I'm a member of.
   c. Messages in my areas of responsibility per the context above (decisions,
      blockers, incidents, requests, questions in my domain) even when untagged.
   Skip pure FYI/social/bot noise and things fully owned by someone else.
   d. ALWAYS judge a message IN CONTEXT of the surrounding conversation — read the
      messages before AND after it in that DM/channel/thread, not the one line in
      isolation. A request is only an OPEN action if it is still unresolved as of
      the latest message. If a LATER message already resolves it — ESPECIALLY one
      from ME (I replied "done", "merged", "shipped", "handled", or actually posted
      the answer/decision it asked for) — then it is NOT open work:
        - If no task exists for it yet, do NOT create an open one. (If it clearly
          maps to a real deliverable worth a record, create it and immediately mark
          it done in the same pass; otherwise just skip it.)
        - If an open task already exists for it, mark that task done (see step 5).
      Example: in a DM, someone asks me to merge a PR and two messages later I say
      "done" — that is already handled; do not surface it as a to-do.
      If it needs a fetch of a few earlier messages for context, pass a smaller
      "oldest"/"latest" window to conversations.history for that channel.
5. RECONCILE each relevant message. Each Slack message has a thread_ts (its own ts
   if it is a thread root). Decide where it belongs:
   a. THREAD MATCH — its thread_ts equals an open task's source_thread_ts:
      it is an UPDATE to that task. Post it as a comment (this records who/when):
        curl -s -X POST ${apiBase}/api/tasks/ID/comments -H "content-type: application/json" \\
          --data "$(python3 -c 'import json,sys;print(json.dumps({"author":"slack","updated_by":"slack","body":sys.argv[1]}))' "<what changed>")"
      If the message signals I FINISHED the task (e.g. "done", "shipped", "merged",
      "thanks, closing"), also mark it done:
        curl -s -X PATCH ${apiBase}/api/tasks/ID -H "content-type: application/json" \\
          -d '{"status":"done","updated_by":"slack"}'
   b. NO THREAD MATCH — judge whether it relates to an existing open task by meaning.
      If yes, treat it as an UPDATE exactly as in (a) against that task's id.
      If no, it is NEW — create a task (carry the thread anchor so future replies
      fold in). Get a permalink first:
        curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/chat.getPermalink?channel=C&message_ts=TS"
        curl -s -X POST ${apiBase}/api/tasks -H "content-type: application/json" \\
          --data "$(python3 -c 'import json,sys;print(json.dumps({"title":sys.argv[1],"detail":sys.argv[2],"source_channel":sys.argv[3],"source_ts":sys.argv[4],"source_thread_ts":sys.argv[5],"source_permalink":sys.argv[6],"priority":int(sys.argv[7])}))' "TITLE" "DETAIL" "C" "TS" "THREAD_TS" "URL" "2")"
      Set priority by type: things I must DO or REPLY to = 1; things to just be
      AWARE of = 3; default 2. Keep titles short and imperative.
6. PR-MERGE SWEEP — for every open task that has a pr_url, check if it merged:
     gh pr view <pr_url> --json state,mergedAt
   If merged (mergedAt is non-null / state MERGED), close it:
     curl -s -X POST ${apiBase}/api/tasks/ID/comments -H "content-type: application/json" \\
       -d '{"author":"slack","updated_by":"slack","body":"PR merged — closing."}'
     curl -s -X PATCH ${apiBase}/api/tasks/ID -H "content-type: application/json" \\
       -d '{"status":"done","updated_by":"slack"}'
   Skip tasks whose pr_url is a local-branch placeholder (no real PR to query).
7. Advance the high-water-mark to the largest Slack ts you saw this run:
   curl -s -X PUT ${apiBase}/api/meta/ingest_hwm -H "content-type: application/json" \\
     --data "$(python3 -c 'import json,sys;print(json.dumps({"value":sys.argv[1]}))' "<max ts>")"
Output a one-line JSON summary at the end: {"new":N,"updated":N,"completed":N,"closed":N}.`;
}

export function replyPrompt({ apiBase, task }) {
  return `REPLY task_id=${task.id}.
WHO I AM (context): ${loadContext()}
Fetch the task and its comment thread: curl -s ${apiBase}/api/tasks/${task.id}
The latest 'me' comment is my request. Help with THIS task only.
You may read Slack via SLACK_USER_TOKEN + curl (do NOT use any Anthropic API), draft messages, and reason.
When done, post your answer as an agent comment:
  curl -s -X POST ${apiBase}/api/tasks/${task.id}/comments -H "content-type: application/json" \\
    -d '{"author":"agent","body":"<your reply>"}'
Task title: ${task.title}`;
}

export function digestPrompt({ apiBase }) {
  return `DIGEST — daily summary.
Fetch open tasks: curl -s "${apiBase}/api/tasks?status=open"
Fetch done today: curl -s "${apiBase}/api/tasks?status=done"
Write a concise Discord-formatted digest (markdown, <1800 chars): what's open by priority,
what got done, and any Slack items that look urgent.
Post it to Discord. Do NOT use jq (it may not be installed) — build the JSON payload
with python3 instead, which is always available:
  curl -s -X POST "$DISCORD_WEBHOOK_URL" -H "content-type: application/json" \\
    --data "$(python3 -c 'import json,sys;print(json.dumps({"content":sys.argv[1]}))' "<digest text>")"
Do NOT use any Anthropic API. Output a one-line JSON summary.`;
}
