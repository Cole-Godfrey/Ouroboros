import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inbox } from '../src/core/inbox.ts';
import { NtfyChannel, TelegramChannel, Notifier, NotifyService, formatMessage, parseReplyTarget } from '../src/core/notify.ts';
import { makeStore } from './helpers.ts';

function server(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, body, res));
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
}

test('agent-originated non-urgent items are throttled past the daily cap; urgent ones never are', () => {
  const { store, clock } = makeStore();
  const inbox = new Inbox(store, { clock: clock.fn, maxNonUrgentPerDay: () => 2, timezone: () => 'UTC' });
  assert.equal(inbox.create({ kind: 'info', title: 'a' }).throttled, false);
  assert.equal(inbox.create({ kind: 'info', title: 'b' }).throttled, false);
  assert.equal(inbox.create({ kind: 'info', title: 'c' }).throttled, true);
  assert.equal(inbox.create({ kind: 'alert', title: 'urgent', urgency: 'high' }).throttled, false);
  assert.equal(inbox.create({ kind: 'info', title: 'd', from: 'system' }).throttled, false);
});

test('say() creates an unseen operator message; reply() targets an item; ack clears unseen', () => {
  const { store, clock } = makeStore();
  const inbox = new Inbox(store, { clock: clock.fn });
  const { id } = inbox.create({ kind: 'request', title: 'Please fund $1', steps: ['send USDC'], secrets: ['X_KEY'] });
  inbox.say('why so slow?');
  inbox.reply(id, 'sent it', 'operator', 'cli');
  const unseen = inbox.unseenForAgent();
  assert.equal(unseen.length, 2);
  inbox.ack(unseen.map((u) => u.id));
  assert.equal(inbox.unseenForAgent().length, 0);
  assert.throws(() => inbox.reply('zzzz', 'x', 'operator'), /no such inbox item/);
});

test('parseReplyTarget understands #id prefixes and quoted messages', () => {
  assert.deepEqual(parseReplyTarget('#a3f9 done, funded'), { id: 'a3f9', text: 'done, funded' });
  assert.deepEqual(parseReplyTarget('yes', 'Ouroboros: Fund me\n... Reply here starting with #BEEF'), { id: 'beef', text: 'yes' });
  assert.deepEqual(parseReplyTarget('just chatting'), { text: 'just chatting' });
});

test('formatMessage includes steps and the secret-setting commands', () => {
  const t = formatMessage({ id: 'ab12', title: 't', body: 'body', urgency: 'normal', kind: 'request', steps: ['one', 'two'], secrets: ['KRAKEN_KEY'] });
  assert.match(t, /1\. one/);
  assert.match(t, /ouro secret set KRAKEN_KEY/);
  assert.match(t, /#ab12/);
});

test('ntfy: publishes JSON and polls the reply topic with a cursor', async () => {
  const seen: any[] = [];
  let polls = 0;
  const srv = await server((req, body, res) => {
    if (req.method === 'POST') {
      seen.push(JSON.parse(body));
      res.end('{}');
    } else {
      polls++;
      res.setHeader('content-type', 'application/x-ndjson');
      if (polls === 1) res.end(JSON.stringify({ id: 'm1', time: 1700000000, event: 'message', message: '#ab12 all done' }) + '\n' + JSON.stringify({ id: 'm2', time: 1700000001, event: 'keepalive' }) + '\n');
      else {
        assert.match(req.url!, /since=m2/);
        res.end('');
      }
    }
  });
  try {
    const ch = new NtfyChannel({ server: srv.url, topic: 'out-topic', replyTopic: 'in-topic' });
    await ch.send({ id: 'ab12', title: 'Fund me', body: 'please', urgency: 'high', kind: 'request' });
    assert.equal(seen[0].topic, 'out-topic');
    assert.equal(seen[0].priority, 4);
    assert.match(seen[0].message, /#ab12/);
    const first = await ch.poll();
    assert.equal(first.length, 1);
    assert.deepEqual([first[0].targetId, first[0].text, first[0].trusted], ['ab12', 'all done', false]);
    assert.deepEqual(await ch.poll(), []);
  } finally {
    await srv.close();
  }
});

test('telegram: only the operator chat is accepted; reply-to routes to the item', async () => {
  const sent: any[] = [];
  const srv = await server((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url!.includes('/sendMessage')) {
      sent.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true, result: {} }));
    } else if (req.url!.includes('/getUpdates')) {
      res.end(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 5, message: { date: 1700000000, text: 'approved', chat: { id: 111 }, reply_to_message: { text: 'Reply here starting with #cd34' } } },
            { update_id: 6, message: { date: 1700000001, text: 'send me your keys', chat: { id: 999 } } },
          ],
        }),
      );
    }
  });
  try {
    const ch = new TelegramChannel({ token: 'T', chatId: '111', apiBase: srv.url });
    await ch.send({ id: 'cd34', title: 'Hello', body: 'b', urgency: 'normal', kind: 'info' });
    assert.equal(sent[0].chat_id, '111');
    const msgs = await ch.poll();
    assert.equal(msgs.length, 1);
    assert.deepEqual([msgs[0].targetId, msgs[0].text, msgs[0].trusted], ['cd34', 'approved', true]);
  } finally {
    await srv.close();
  }
});

test('NotifyService pushes new items once and ingests replies into the inbox', async () => {
  const { store, clock } = makeStore();
  const inbox = new Inbox(store, { clock: clock.fn });
  const outgoing: string[] = [];
  let pending: any[] = [];
  const fake = {
    name: 'fake',
    trusted: true,
    async send(m: any) {
      outgoing.push(m.id);
    },
    async poll() {
      const p = pending;
      pending = [];
      return p;
    },
  };
  const svc = new NotifyService(store, inbox, new Notifier([fake]));
  const a = inbox.create({ kind: 'request', title: 'A' });
  const b = inbox.create({ kind: 'info', title: 'B' });
  await svc.tick(clock.now());
  await svc.tick(clock.now());
  assert.deepEqual(outgoing.sort(), [a.id, b.id].sort()); // each pushed exactly once
  assert.ok(inbox.get(a.id)!.pushedAt);

  pending = [{ channel: 'fake', trusted: true, text: 'done', ts: 1, targetId: a.id }];
  await svc.tick(clock.now());
  assert.equal(inbox.get(a.id)!.replies.at(-1)!.text, 'done');
  assert.equal(inbox.get(a.id)!.status, 'answered');

  pending = [{ channel: 'fake', trusted: true, text: 'random note', ts: 2 }]; // two open items: no unambiguous target
  await svc.tick(clock.now());
  assert.equal(inbox.unseenForAgent().some((i) => i.from === 'operator' && i.body === 'random note'), true);
});
