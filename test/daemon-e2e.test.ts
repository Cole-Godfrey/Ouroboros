// end to end: a real daemon with a scripted model, fake notification server and fake chain rpc.

// the daemon on its own: real Daemon (all loops), real Pi, scripted model, mock ntfy, mock RPC node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Daemon } from '../src/core/daemon.ts';
import { Vault } from '../src/core/vault.ts';
import { tmpEnv } from './helpers.ts';

function listen(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => handler(req, b, res));
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) }));
  });
}

const sse = (turn: number, step: { text?: string; tool?: { name: string; input: unknown } }) => {
  const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  let out = ev('message_start', { type: 'message_start', message: { id: `m${turn}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 2000, output_tokens: 1 } } });
  let i = 0;
  if (step.text) {
    out += ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: step.text } }) + ev('content_block_stop', { type: 'content_block_stop', index: i });
    i++;
  }
  if (step.tool) out += ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `t${turn}`, name: step.tool.name, input: {} } }) + ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }) + ev('content_block_stop', { type: 'content_block_stop', index: i });
  return out + ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 80 } }) + ev('message_stop', { type: 'message_stop' });
};

test('the daemon runs the genesis episode by itself, notifies the operator, meters the cost and reconciles', { timeout: 120_000 }, async () => {
  const e = tmpEnv();
  fs.mkdirSync(e.paths.etc, { recursive: true });
  process.env.PI_OFFLINE = '1';

  const script = [
    { text: 'Orienting.', tool: { name: 'ouro_status', input: {} } },
    { tool: { name: 'inbox', input: { action: 'send', kind: 'request', title: 'Fund my wallet with 1 USDC on Base', body: 'Address in `ouro wallet`.', steps: ['send 1 USDC', 'ouro fund add 1 --venue evm-wallet'], urgency: 'normal' } } },
    { tool: { name: 'episode_end', input: { handoff: 'Waiting for funds.', next_wake_minutes: 60, model_tier: 'cheap', wake_reason: 'check balance' } } },
  ];
  const model = await listen((req, body, res) => {
    const j = JSON.parse(body || '{}');
    const turn = (j.messages ?? []).filter((m: any) => m.role === 'assistant').length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(turn, script[Math.min(turn, script.length - 1)]));
  });
  const pushes: any[] = [];
  const ntfy = await listen((_req, body, res) => {
    try { pushes.push(JSON.parse(body)); } catch { /* ignore */ }
    res.end('{}');
  });
  const rpc = await listen((_req, body, res) => {
    const j = JSON.parse(body);
    const one = (m: any) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_getBalance' ? '0x0' : '0x' + '0'.repeat(64) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
  });

  // configuration and keys exist before the daemon starts, as after `ouro init`
  fs.mkdirSync(e.paths.home, { recursive: true });
  fs.writeFileSync(e.paths.config, JSON.stringify({
    llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', cheapModel: 'claude-haiku-4-5', proxy: true, proxyPort: 0, upstreams: { anthropic: model.url } },
    budget: { mode: 'sponsor' },
    schedule: { minGapSec: 1 },
    dashboard: { port: 0 },
    notify: { ntfy: { server: ntfy.url, topic: 'test-topic', replyTopic: 'test-topic-reply' } },
  }));
  new Vault(e.paths).set('ANTHROPIC_API_KEY', 'sk-ant-real-key-0123456789abcdef');
  const venueDir = path.join(e.paths.data, 'venues', 'evm-wallet');
  fs.mkdirSync(venueDir, { recursive: true });
  fs.writeFileSync(path.join(venueDir, 'config.json'), JSON.stringify({ chains: ['base'], rpc: { base: rpc.url } }));

  const d = await Daemon.create({ env: e.env });
  try {
    await d.start();
    const waitFor = async (cond: () => boolean, ms: number, what: string) => {
      const t0 = Date.now();
      while (!cond() && Date.now() - t0 < ms) {
        d.store.sync();
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(cond(), `timed out waiting for ${what}`);
    };

    await waitFor(() => d.store.state.episodes.some((x) => x.outcome), 60_000, 'the genesis episode to finish');
    const ep = d.store.state.episodes[0];
    assert.equal(ep.reason, 'genesis');
    assert.equal(ep.outcome, 'completed', ep.error);
    assert.equal(ep.handoff, 'Waiting for funds.');
    assert.equal(ep.error, undefined, 'a clean episode carries no error');

    // the operator was pinged with the agent's request, steps included
    await waitFor(() => pushes.length > 0, 40_000, 'the ntfy push');
    assert.equal(pushes[0].topic, 'test-topic');
    assert.match(pushes[0].title, /Fund my wallet/);
    assert.match(pushes[0].message, /1\. send 1 USDC/);
    assert.ok([...d.store.state.inbox.values()][0].pushedAt);

    // cost was metered from the provider's usage numbers, by the proxy
    assert.ok(d.store.state.llm.entries.length >= 3);
    assert.ok(d.store.state.llm.sponsorUsd > 0);
    assert.ok(d.store.state.llm.entries.every((x) => x.funding === 'sponsor'));

    // the agent asked for a wake-up in an hour, the scheduler persisted it
    assert.ok(d.store.state.pendingWakes().some((w) => /check balance/.test(w.reason) && w.tier === 'cheap'));

    // the reconciler produced a NAV point from the (mock) chain
    await waitFor(() => d.store.state.navSeries.length >= 1, 45_000, 'a reconciliation round');
    assert.equal(d.store.state.metrics(Date.now()).navUsd, 0);

    // heartbeat file and dashboard
    const hb = JSON.parse(fs.readFileSync(d.paths.heartbeat, 'utf8'));
    assert.equal(hb.pid, process.pid);
    const html = await fetch(`http://127.0.0.1:${d.dashboardPort}/`).then((r) => r.text());
    assert.match(html, /Ouroboros/);
    const token = fs.readFileSync(d.paths.dashboardToken, 'utf8').trim();
    const dash: any = await fetch(`http://127.0.0.1:${d.dashboardPort}/v1/dashboard?token=${token}`).then((r) => r.json());
    assert.equal(dash.episodes[0].outcome, 'completed');
    const report: any = await fetch(`http://127.0.0.1:${d.dashboardPort}/v1/report?token=${token}&now=1`).then((r) => r.json());
    assert.doesNotMatch(report.text, /Waiting for funds/);
    assert.match(report.text, /Contributions:/);
    assert.equal(report.complete, false);
    assert.equal((await fetch(`http://127.0.0.1:${d.dashboardPort}/v1/report`)).status, 401);
    const artwork = await fetch(`http://127.0.0.1:${d.dashboardPort}/ouroboros.png`);
    assert.equal(artwork.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await artwork.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
    // operator events must reach the scheduler through its live subscription.
    d.inbox.say('Review the latest report.');
    assert.ok(d.scheduler.status().pending.some((t) => t.kind === 'operator'));
    assert.equal((await fetch(`http://127.0.0.1:${d.dashboardPort}/v1/control`, { method: 'POST' })).status, 401);
    assert.equal(d.store.log.verify().ok, true);
  } finally {
    await d.close();
    await Promise.all([model.close(), ntfy.close(), rpc.close()]);
  }
});

test('the default free model completes an episode through the OpenRouter proxy with no capital', { timeout: 90_000 }, async () => {
  const e = tmpEnv();
  process.env.PI_OFFLINE = '1';
  const requests: { url: string; body: any; authorization?: string }[] = [];
  const model = await listen((req, body, res) => {
    const input = JSON.parse(body);
    requests.push({ url: req.url!, body: input, authorization: req.headers.authorization });
    // exercise the real Pi's OpenAI-compatible streaming/tool-call decoder.
    const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({
      id: 'free-test', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: input.model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250, cost: 0 } } : {}),
    })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'end-free', type: 'function', function: {
      name: 'episode_end', arguments: JSON.stringify({ handoff: 'Free model ready without funding.', next_wake_minutes: 60 }),
    } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  fs.writeFileSync(e.paths.config, JSON.stringify({ llm: { proxyPort: 0, upstreams: { openrouter: model.url } }, dashboard: { port: 0 } }));
  new Vault(e.paths).set('OPENROUTER_API_KEY', 'sk-or-v1-local-test-not-a-real-key');
  const d = await Daemon.create({ env: e.env });
  try {
    await d.start();
    const deadline = Date.now() + 60_000;
    while (!d.store.state.episodes.some((ep) => ep.outcome) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const episode = d.store.state.episodes[0];
    assert.equal(episode?.outcome, 'completed', episode?.error);
    assert.equal(episode.handoff, 'Free model ready without funding.');
    assert.ok(requests.length >= 1);
    assert.equal(requests[0].url, '/api/v1/chat/completions');
    assert.equal(requests[0].body.model, d.cfg().llm.model);
    assert.equal(requests[0].authorization, 'Bearer sk-or-v1-local-test-not-a-real-key');
    assert.ok(d.store.state.llm.entries.length >= 1);
    assert.equal(d.store.state.llm.capitalUsd, 0);
    assert.equal(d.store.state.metrics(Date.now()).navUsd, 0);
  } finally {
    await d.close();
    await model.close();
  }
});
