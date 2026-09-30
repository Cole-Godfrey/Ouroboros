// tests for free models, model id handling and switching the agent's model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Daemon } from '../src/core/daemon.ts';
import { isFreeModel, modelId } from '../src/core/llm.ts';
import { costOf } from '../src/core/meter.ts';
import { tmpEnv } from './helpers.ts';

const USAGE = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

test('free models cost nothing and unknown paid models are still priced high', () => {
  assert.equal(costOf('openrouter/free', USAGE), 0);
  assert.equal(costOf('qwen/qwen3-coder:free', USAGE), 0);
  assert.ok(costOf('some-unknown-paid-model', USAGE) > 0);
  assert.ok(isFreeModel('openrouter/free') && !isFreeModel('claude-sonnet-5-5'));
});

test('model ids keep openrouter slashes and drop a matching provider prefix elsewhere', () => {
  assert.equal(modelId('openrouter/free', 'openrouter'), 'openrouter/free');
  assert.equal(modelId('anthropic/claude-sonnet-5-5', 'anthropic'), 'claude-sonnet-5-5');
  assert.equal(modelId('claude-sonnet-5-5', 'anthropic'), 'claude-sonnet-5-5');
});

async function boot(config: object = {}) {
  const e = tmpEnv();
  fs.mkdirSync(e.paths.etc, { recursive: true });
  fs.writeFileSync(e.paths.config, JSON.stringify(config));
  const d = await Daemon.create({ env: e.env, selftest: true });
  return { d, close: () => d.close() };
}

test('the agent starts on a free model and is never blocked by an empty budget', async () => {
  const t = await boot();
  assert.equal(t.d.modelInfo().free, true);
  assert.equal(t.d.meter.canStartEpisode().ok, true);
  assert.equal(t.d.meter.status().exhausted, false);
  await t.close();
});

test('switching models needs the provider key, and a paid model needs an allowance that can pay for it', async () => {
  const t = await boot();
  // no key for the provider yet: refused with the exact command to ask the operator for
  const noKey = t.d.setModel({ provider: 'anthropic', model: 'claude-sonnet-5-5', by: 'agent' });
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason!, /ouro secret set ANTHROPIC_API_KEY/);

  t.d.vault.set('ANTHROPIC_API_KEY', 'sk-ant-real-key-0123456789abcdef');
  // capital mode with no NAV: the daily allowance is zero, so a paid model is refused
  const poor = t.d.setModel({ provider: 'anthropic', model: 'claude-sonnet-5-5', by: 'agent' });
  assert.equal(poor.ok, false);
  assert.match(poor.reason!, /free model/);
  assert.equal(t.d.cfg().llm.provider, 'openrouter');

  // another free model is always fine
  t.d.vault.set('OPENROUTER_API_KEY', 'sk-or-real-key-0123456789abcdef');
  assert.equal(t.d.setModel({ model: 'qwen/qwen3-coder:free', by: 'agent' }).ok, true);
  assert.equal(t.d.cfg().llm.model, 'qwen/qwen3-coder:free');
  await t.close();
});

test('a paid model is allowed when the operator sponsors inference, and the switch is logged', async () => {
  const t = await boot({ budget: { mode: 'sponsor' } });
  t.d.vault.set('ANTHROPIC_API_KEY', 'sk-ant-real-key-0123456789abcdef');
  const r = t.d.setModel({ provider: 'anthropic', model: 'claude-sonnet-5-5', by: 'agent' });
  assert.equal(r.ok, true);
  assert.equal(t.d.cfg().llm.provider, 'anthropic');
  assert.equal(t.d.cfg().llm.cheapModel, 'claude-sonnet-5-5');
  assert.equal(t.d.modelInfo().free, false);
  assert.ok(t.d.store.log.tail(20).some((ev) => ev.type === 'model.set'));
  await t.close();
});

test('two failed episodes on a pinned free model fall back to the free router', async () => {
  const t = await boot();
  assert.match(t.d.cfg().llm.model, /nemotron.*:free$/);
  // simulate two failed episodes, then let the daemon react the way it does after a real one
  for (const id of ['ep_a', 'ep_b']) t.d.store.append('episode.end', { id, outcome: 'error', costUsd: 0 });
  (t.d as unknown as { afterEpisode(r: { outcome: string }): void }).afterEpisode({ outcome: 'error' });
  assert.equal(t.d.cfg().llm.model, 'openrouter/free');
  await t.close();
});
