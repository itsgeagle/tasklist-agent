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

export function ingestPrompt({ apiBase }) {
  return `INGEST — Slack → tasklist.
You have SLACK_USER_TOKEN in env (scopes: ${SLACK_SCOPES}) and the local API at ${apiBase}.
Use Bash + curl only. Do NOT use any Anthropic API.

WHO I AM / WHAT'S RELEVANT TO ME (use this to judge what to surface):
${loadContext()}

Steps:
1. List my conversations:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200"
2. For each conversation id C, fetch recent messages:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.history?channel=C&limit=50"
   Also check mentions: search.messages?query=to:me OR your @handle.
3. Select messages RELEVANT TO ME. Relevance is broader than a direct @-mention — include:
   a. Direct @-mentions of me, and DMs to me.
   b. @channel / @here / @everyone announcements in channels I'm a member of.
   c. Messages that concern my areas of responsibility per the context above
      (decisions, blockers, incidents, requests, questions in my domain) even
      when I'm NOT explicitly tagged.
   Be selective: skip pure FYI/social/bot noise and things fully owned by someone
   else that need nothing from me. Prefer recent activity.
4. Turn each into a task. Set priority by type: things I must DO or REPLY to = higher
   priority (1); things I should just be AWARE of / may need to follow up on = lower (3).
   For each, get a permalink:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/chat.getPermalink?channel=C&message_ts=TS"
5. POST each to the tasklist (server dedups by fingerprint — safe to re-post):
   curl -s -X POST ${apiBase}/api/tasks -H "content-type: application/json" \\
     -d '{"title":"...","detail":"...","source_channel":"C","source_ts":"TS","source_permalink":"URL","priority":2}'
Keep titles short and imperative; put the "why it's relevant to me" in detail when not obvious.
Output a one-line JSON summary at the end.`;
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
