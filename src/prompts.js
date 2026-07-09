const SLACK_SCOPES = 'channels/groups/im/mpim:history, channels/groups/im/mpim:read, users:read, search:read';

export function ingestPrompt({ apiBase }) {
  return `INGEST — Slack → tasklist.
You have SLACK_USER_TOKEN in env (scopes: ${SLACK_SCOPES}) and the local API at ${apiBase}.
Use Bash + curl only. Do NOT use any Anthropic API.

Steps:
1. List my conversations:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200"
2. For each conversation id C, fetch recent messages:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/conversations.history?channel=C&limit=50"
   Also check mentions: search.messages?query=to:me OR your @handle.
3. Identify concrete action items directed at or owned by me (things I must DO or REPLY to).
   Skip pure FYI/noise.
4. For each action item, get a permalink:
   curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" "https://slack.com/api/chat.getPermalink?channel=C&message_ts=TS"
5. POST each to the tasklist (server dedups by fingerprint — safe to re-post):
   curl -s -X POST ${apiBase}/api/tasks -H "content-type: application/json" \\
     -d '{"title":"...","detail":"...","source_channel":"C","source_ts":"TS","source_permalink":"URL","priority":2}'
Keep titles short and imperative. Output a one-line JSON summary at the end.`;
}

export function replyPrompt({ apiBase, task }) {
  return `REPLY task_id=${task.id}.
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
Post it to Discord:
  curl -s -X POST "$DISCORD_WEBHOOK_URL" -H "content-type: application/json" \\
    -d "$(jq -n --arg c "<digest text>" '{content:$c}')"
Do NOT use any Anthropic API. Output a one-line JSON summary.`;
}
