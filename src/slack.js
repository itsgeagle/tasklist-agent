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
