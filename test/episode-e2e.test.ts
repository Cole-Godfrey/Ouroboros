// end to end: the real pi runs an episode against a scripted model through the metering proxy.

// full-stack test: real daemon + real EpisodeRunner + real Pi binary + real extension + real metering proxy.
// only the model is fake: a scripted Anthropic-compatible server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Daemon } from '../src/core/daemon.ts';
import { LlmProxy } from '../src/core/llm-proxy.ts';
import { ROOT_DIR } from '../src/lib/paths.ts';
import { tmpEnv, PAID_LLM } from './helpers.ts';

interface Step {
  text?: string;
  tool?: { name: string; input: unknown };
  usage?: { input: number; output: number };
}

function mockAnthropic(steps: Step[]): Promise<{ url: string; requests: Array<{ headers: http.IncomingHttpHeaders; body: any }>; close(): Promise<void> }> {
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        requests.push({ headers: req.headers, body });
        const turn = (body.messages ?? []).filter((m: any) => m.role === 'assistant').length;
        const step = steps[Math.min(turn, steps.length - 1)];
        const u = step.usage ?? { input: 1500, output: 60 };
        const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
        let out = ev('message_start', { type: 'message_start', message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
        let idx = 0;
        if (step.text) {
          out += ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
          out += ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: step.text } });
          out += ev('content_block_stop', { type: 'content_block_stop', index: idx });
          idx++;
        }
        if (step.tool) {
          out += ev('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: `toolu_${turn}`, name: step.tool.name, input: {} } });
          out += ev('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } });
          out += ev('content_block_stop', { type: 'content_block_stop', index: idx });
        }
        out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output } });
        out += ev('message_stop', { type: 'message_stop' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(out);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

async function boot(steps: Step[]) {
  const e = tmpEnv();
  fs.mkdirSync(e.paths.etc, { recursive: true });
  fs.writeFileSync(e.paths.config, JSON.stringify(PAID_LLM));
  const env = { ...e.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
  Object.assign(process.env, { PI_OFFLINE: '1' });
  const d = await Daemon.create({ env, selftest: true });
  d.vault.set('ANTHROPIC_API_KEY', 'sk-ant-real-key-0123456789abcdef');
  const up = await mockAnthropic(steps);
  const proxy = new LlmProxy({ meter: d.meter, config: () => d.cfg(), getSecret: (n) => d.vault.get(n), upstream: () => up.url });
  await proxy.start(0);
  d.proxy = proxy;
  await d.start();
  return { d, up, proxy, ...e, close: async () => { await d.close(); await up.close(); } };
}

test('a whole episode: Pi thinks through the proxy, uses Ouroboros tools against the daemon, and hands over', async () => {
  const t = await boot([
    { text: 'Let me look at where I stand.', tool: { name: 'ouro_status', input: {} } },
    { tool: { name: 'journal', input: { kind: 'lesson', text: 'Fixed costs dominate at $1; prefer venues with tiny fixed costs.' } } },
    { tool: { name: 'inbox', input: { action: 'send', kind: 'request', title: 'Please fund me with $1 USDC on Base', body: 'Send to my wallet address.', steps: ['Send 1 USDC (Base) to the address shown by `ouro wallet`', 'Run ouro fund add 1'], urgency: 'normal' } } },
    { tool: { name: 'episode_end', input: { handoff: 'Waiting for the funding; check the wallet balance at the next wake.', next_wake_minutes: 45, model_tier: 'cheap', wake_reason: 'check funding' } } },
  ]);
  try {
    const result = await t.d.runner.run({ triggers: [{ kind: 'manual', ts: Date.now() }] });
    assert.equal(result.outcome, 'completed', result.error);
    assert.ok(result.toolCalls >= 4, `tool calls: ${result.toolCalls}`);

    // the agent's tool calls landed in the audit log
    t.d.store.sync();
    assert.equal(t.d.store.state.journal.at(-1)?.kind, 'lesson');
    const items = [...t.d.store.state.inbox.values()];
    assert.equal(items.length, 1);
    assert.match(items[0].title, /fund me/i);
    assert.deepEqual(items[0].steps?.length, 2);

    // episode_end reached the runner with the agent's wishes
    assert.equal(t.d.runner._last?.end?.handoff.startsWith('Waiting for the funding'), true);
    assert.equal(t.d.runner._last?.end?.nextWakeMinutes, 45);
    assert.equal(t.d.runner._last?.end?.tier, 'cheap');

    // every model call went through the proxy and was metered from the real usage numbers
    const usage = t.d.store.state.llm.entries;
    assert.equal(usage.length, 4, `metered ${usage.length} calls`);
    assert.ok(usage.every((u) => u.usd > 0 && u.model === 'claude-sonnet-5-5'));
    assert.ok(t.d.store.state.llm.sponsorUsd > 0);

    // what the model actually saw
    const first = t.up.requests[0];
    assert.equal(first.headers['x-api-key'], 'sk-ant-real-key-0123456789abcdef', 'the proxy injects the real key');
    const sys = typeof first.body.system === 'string' ? first.body.system : JSON.stringify(first.body.system);
    if (process.env.OURO_DUMP) fs.writeFileSync(process.env.OURO_DUMP, sys + '\n\n=== TOOLS ===\n' + JSON.stringify(first.body.tools.map((x: any) => ({ name: x.name, description: x.description })), null, 1) + '\n\n=== FIRST USER MESSAGE ===\n' + JSON.stringify(first.body.messages[0], null, 1));
    assert.match(sys, /You are Ouroboros/);
    assert.match(sys, /## The ten rules/, 'the Charter is in the system prompt');
    const toolNames: string[] = first.body.tools.map((x: any) => x.name);
    for (const n of ['ouro_status', 'inbox', 'episode_end', 'venue', 'selfmod', 'strategy', 'secret_exec', 'web_fetch', 'bash', 'read', 'edit', 'write']) assert.ok(toolNames.includes(n), `tool ${n} offered to the model`);
    const userText = JSON.stringify(first.body.messages[0]);
    assert.match(userText, /## Money/, 'the briefing is the first user message');
    assert.ok(!JSON.stringify(t.up.requests.map((r) => r.body)).includes('sk-ant-real-key'), 'the real key never appears in any prompt');
    assert.ok(t.up.requests.every((r) => r.headers['x-api-key'] === 'sk-ant-real-key-0123456789abcdef'));
  } finally {
    await t.close();
  }
});

test('the vault is off limits to file tools, and secrets are redacted from every tool result before the model sees them', async () => {
  const steps: Step[] = [];
  const t = await boot(steps);
  try {
    const secret = 'tok_live_zzzzzzzzzzzzzzzzzz';
    t.d.vault.set('DEMO_TOKEN', secret);
    const masterKey = fs.readFileSync(t.d.paths.masterKey, 'utf8').trim();
    // an earlier accident left a secret in a workspace file, the model was never told the value
    fs.writeFileSync(path.join(t.d.paths.workspace, 'note.txt'), `remember: ${secret}\n`);
    steps.push(
      { tool: { name: 'bash', input: { command: 'cat note.txt' } } },
      { tool: { name: 'read', input: { path: t.d.paths.masterKey } } },
      { tool: { name: 'bash', input: { command: `cat ${path.join(t.d.paths.vaultDir, 'secrets.enc.json')}` } } },
      { tool: { name: 'secret_exec', input: { script: 'echo "using $DEMO_TOKEN"', secrets: ['DEMO_TOKEN'] } } },
      { tool: { name: 'episode_end', input: { handoff: 'done' } } },
    );
    const result = await t.d.runner.run({ triggers: [{ kind: 'manual', ts: Date.now() }] });
    assert.equal(result.outcome, 'completed', result.error);
    const all = JSON.stringify(t.up.requests.map((r) => r.body));
    assert.ok(!all.includes(secret), 'the secret value reached a model request');
    assert.ok(!all.includes(masterKey), 'the master key reached a model request');
    assert.ok(all.includes('«DEMO_TOKEN»'), 'redaction markers should appear in tool results');
    assert.match(all, /off limits to file and shell tools/, 'the vault guard explains itself to the model');
    assert.ok((all.match(/«DEMO_TOKEN»/g) ?? []).length >= 2, 'both the cat and the secret_exec output were redacted');
  } finally {
    await t.close();
  }
});
