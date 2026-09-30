import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlmProxy, UsageSniffer } from '../src/core/llm-proxy.ts';
import { Meter } from '../src/core/meter.ts';
import { DEFAULT_CONFIG, deepMerge } from '../src/lib/config.ts';
import { makeStore } from './helpers.ts';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }

function upstream(respond: (seen: Seen) => { status?: number; type?: string; body: string; chunk?: number }): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let body: any = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        const item: Seen = { method: req.method!, url: req.url!, headers: req.headers, body };
        seen.push(item);
        const r = respond(item);
        res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' });
        const size = r.chunk ?? r.body.length;
        for (let i = 0; i < r.body.length; i += size) {
          res.write(r.body.slice(i, i + size));
          if (r.chunk) await new Promise((x) => setTimeout(x, 1));
        }
        res.end();
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) }));
  });
}

const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const anthropicStream = (usageIn = 25, usageOut = 15, cacheRead = 100, cacheWrite = 50) =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage: { input_tokens: usageIn, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usageOut } }],
    ['message_stop', { type: 'message_stop' }],
  ]);

async function setup(over: any = {}) {
  const env = makeStore();
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), { budget: { sponsorDailyUsd: 5, perEpisodeUsd: 5 }, ...over });
  const meter = new Meter({ store: env.store, config: () => cfg, limits: () => ({}), clock: env.clock.fn });
  let upUrl = '';
  const proxy = new LlmProxy({ meter, config: () => cfg, getSecret: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-ant-real-key-0123456789' : n === 'OPENAI_API_KEY' ? 'sk-openai-real-key-0123456789' : undefined), upstream: () => upUrl });
  await proxy.start(0);
  return { ...env, cfg, meter, proxy, setUpstream: (u: string) => (upUrl = u) };
}

const call = (proxy: LlmProxy, path: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  fetch(proxy.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-api-key': token } : {}), ...headers }, body: JSON.stringify(body) });

test('streaming Anthropic call: forwarded byte-for-byte, real key injected, usage and cost recorded', async () => {
  const t = await setup();
  const payload = anthropicStream();
  const up = await upstream(() => ({ type: 'text/event-stream', body: payload, chunk: 7 })); // chunks split events mid-line
  t.setUpstream(up.url);
  try {
    const token = t.proxy.issueToken({ label: 'test', episode: 'ep1' });
    const res = await call(t.proxy, '/anthropic/v1/messages', token, { model: 'claude-sonnet-5-5', stream: true, max_tokens: 10, messages: [] }, { 'anthropic-version': '2023-06-01' });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, payload);
    assert.equal(up.seen[0].headers['x-api-key'], 'sk-ant-real-key-0123456789');
    assert.equal(up.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.ok(!JSON.stringify(up.seen[0].headers).includes(token), 'the episode token never reaches the provider');
    assert.ok(!text.includes('sk-ant-real'), 'the real key never reaches the caller');
    const e = t.store.state.llm.entries;
    assert.equal(e.length, 1);
    // 25 in, 15 out, 100 cache read, 50 cache write on sonnet 5.5: (50 + 150 + 20 + 125) / 1e6
    assert.equal(e[0].usd, 0.000345);
    assert.equal(e[0].episode, 'ep1');
    assert.equal(t.proxy.spentUsd(token), 0.000345);
    assert.equal(t.store.state.llm.tokens.cacheRead, 100);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('non-streaming Anthropic call is metered from the JSON body', async () => {
  const t = await setup();
  const up = await upstream(() => ({ body: JSON.stringify({ id: 'm', model: 'claude-haiku-4-5-20251001', content: [], usage: { input_tokens: 1000, output_tokens: 200 } }) }));
  t.setUpstream(up.url);
  try {
    const token = t.proxy.issueToken({ label: 't' });
    const res = await call(t.proxy, '/anthropic/v1/messages', token, { model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [] });
    assert.equal(((await res.json()) as any).model, 'claude-haiku-4-5-20251001');
    assert.equal(t.store.state.llm.entries[0].usd, 0.002); // 1000 * $1/M + 200 * $5/M
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('unknown or missing tokens are rejected and nothing reaches the provider', async () => {
  const t = await setup();
  const up = await upstream(() => ({ body: '{}' }));
  t.setUpstream(up.url);
  try {
    assert.equal((await call(t.proxy, '/anthropic/v1/messages', undefined, {})).status, 401);
    assert.equal((await call(t.proxy, '/anthropic/v1/messages', 'ouro-not-a-real-token', {})).status, 401);
    const token = t.proxy.issueToken({ label: 't' });
    t.proxy.revokeToken(token);
    assert.equal((await call(t.proxy, '/anthropic/v1/messages', token, {})).status, 401);
    assert.equal((await call(t.proxy, '/nope/v1/x', 'x', {})).status, 404);
    assert.equal(up.seen.length, 0);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('an exhausted operator budget blocks every caller with a billing error', async () => {
  const t = await setup({ budget: { sponsorDailyUsd: 0.01 } });
  const up = await upstream(() => ({ body: JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 10 } }) }));
  t.setUpstream(up.url);
  try {
    const token = t.proxy.issueToken({ label: 't' });
    t.meter.record({ provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, source: 'pi' });
    const res = await call(t.proxy, '/anthropic/v1/messages', token, { model: 'x', messages: [] });
    assert.equal(res.status, 402);
    const j = (await res.json()) as any;
    assert.equal(j.error.type, 'billing_error');
    assert.match(j.error.message, /daily sponsor budget/);
    assert.equal(up.seen.length, 0);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('a per-episode cap stops that token but not others', async () => {
  const t = await setup();
  const up = await upstream(() => ({ body: JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 100_000, output_tokens: 10_000 } }) })); // $0.30 per call
  t.setUpstream(up.url);
  try {
    const capped = t.proxy.issueToken({ label: 'a', episode: 'ep1', capUsd: 0.25 });
    const other = t.proxy.issueToken({ label: 'b', episode: 'ep2', capUsd: 5 });
    assert.equal((await call(t.proxy, '/anthropic/v1/messages', capped, { model: 'x', messages: [] })).status, 200);
    const second = await call(t.proxy, '/anthropic/v1/messages', capped, { model: 'x', messages: [] });
    assert.equal(second.status, 402);
    assert.match(((await second.json()) as any).error.message, /episode's cap/);
    assert.equal((await call(t.proxy, '/anthropic/v1/messages', other, { model: 'x', messages: [] })).status, 200);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('OpenAI-style streaming: usage is requested, cached tokens are priced separately, bearer auth is swapped', async () => {
  const t = await setup();
  const chunks = [
    { id: 'c1', model: 'gpt-x', choices: [{ delta: { content: 'hi' } }] },
    { id: 'c1', model: 'gpt-x', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 }, cost: 0.0123 } },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const up = await upstream(() => ({ type: 'text/event-stream', body }));
  t.setUpstream(up.url);
  try {
    const token = t.proxy.issueToken({ label: 't' });
    const res = await fetch(t.proxy.url + '/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model: 'gpt-x', stream: true, messages: [] }) });
    assert.equal(await res.text(), body);
    assert.equal(up.seen[0].body.stream_options.include_usage, true);
    assert.equal(up.seen[0].headers.authorization, 'Bearer sk-openai-real-key-0123456789');
    const e = t.store.state.llm.entries[0];
    assert.equal(e.usd, 0.0123, 'a provider-reported cost wins over the price table');
    assert.deepEqual([t.store.state.llm.tokens.input, t.store.state.llm.tokens.cacheRead, t.store.state.llm.tokens.output], [600, 400, 100]);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('upstream errors pass through untouched and cost nothing', async () => {
  const t = await setup();
  const up = await upstream(() => ({ status: 529, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }) }));
  t.setUpstream(up.url);
  try {
    const token = t.proxy.issueToken({ label: 't' });
    const res = await call(t.proxy, '/anthropic/v1/messages', token, { model: 'x', messages: [] });
    assert.equal(res.status, 529);
    assert.equal(((await res.json()) as any).error.type, 'overloaded_error');
    assert.equal(t.store.state.llm.entries.length, 0);
  } finally {
    await up.close();
    await t.proxy.stop();
  }
});

test('UsageSniffer keeps the maximum of cumulative usage fields and survives arbitrary chunking', () => {
  const s = new UsageSniffer('anthropic', true);
  const payload = anthropicStream(10, 99, 0, 0);
  for (let i = 0; i < payload.length; i += 3) s.push(Buffer.from(payload.slice(i, i + 3)));
  const r = s.finish();
  assert.deepEqual(r.usage, { input: 10, output: 99, cacheRead: 0, cacheWrite: 0 });
  assert.equal(r.model, 'claude-sonnet-5-5');
});
