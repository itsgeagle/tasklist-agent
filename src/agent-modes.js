export const MODES = {
  code: {
    diagnoseTools: ['Bash', 'Read', 'Grep'],
    executeTools: ['Bash', 'Read', 'Write', 'Edit'],
    diagnosePrompt: ({ apiBase, task, worktreePath }) => `DIAGNOSE task_id=${task.id}.
You are in a git worktree at ${worktreePath} (already checked out, do NOT switch branches).
Investigate this issue READ-ONLY (do not modify files). Task: "${task.title}". ${task.detail || ''}
Find the root cause, then post a concise plan (root cause + the fix you propose + files to touch)
as a comment via:
  curl -s -X POST ${apiBase}/api/tasks/${task.id}/comments -H "content-type: application/json" \\
    -d "$(python3 -c 'import json,sys;print(json.dumps({"author":"agent","body":sys.argv[1]}))' "<your plan>")"
Do NOT use any Anthropic API. Output a one-line JSON summary.`,
    executePrompt: ({ apiBase, task, worktreePath, plan }) => `EXECUTE task_id=${task.id}.
You are in a git worktree at ${worktreePath} on a fresh branch. Implement this approved plan:
---
${plan}
---
Follow TDD, run the repo's tests, and commit with --no-gpg-sign (no Co-Authored-By).
Then open a DRAFT PR: \`gh pr create --draft --fill\`. NEVER push to main/master; never force-push.
If gh is unavailable or there is no remote, skip the PR and report the branch name instead.
Record the PR url:
  curl -s -X PATCH ${apiBase}/api/tasks/${task.id} -H "content-type: application/json" \\
    -d "$(python3 -c 'import json,sys;print(json.dumps({"pr_url":sys.argv[1]}))' "<pr url or branch>")"
Post a short summary comment (author "agent"). Do NOT use any Anthropic API.`,
  },
};
