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
