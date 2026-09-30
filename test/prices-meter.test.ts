import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceOracle, normalizeAsset, coinbaseSource } from '../src/core/prices.ts';
import { Meter, costOf, DEFAULT_PRICING, FALLBACK_PRICING, priceFor } from '../src/core/meter.ts';
import { DEFAULT_CONFIG, deepMerge, effectiveBudget, type OuroConfig } from '../src/lib/config.ts';
import { DAY } from '../src/lib/clock.ts';
import { makeStore } from './helpers.ts';

test('oracle: stablecoins are $1, overrides win, aliases collapse, unknown assets are reported unpriced', async () => {
  const calls: string[] = [];
  const oracle = new PriceOracle({
    sources: [{ name: 'fake', get: async (a) => { calls.push(a); return a === 'ETH' ? 3000 : undefined; } }],
    overrides: { FOO: 2 },
  });
  assert.equal(await oracle.usd('usdc'), 1);
  assert.equal(await oracle.usd('FOO'), 2);
  assert.equal(await oracle.usd('WETH'), 3000);
  assert.equal(normalizeAsset(' weth '), 'ETH');
  const v = await oracle.value([
    { asset: 'USDC', qty: 0.5 },
    { asset: 'ETH', qty: 0.001 },
    { asset: 'MYSTERY', qty: 10 },
    { asset: 'SHARES', qty: 4, valueUsd: 1.25 },
    { asset: 'DUST', qty: 0 },
  ]);
  assert.deepEqual(v.unpriced, ['MYSTERY']);
  assert.equal(v.totalUsd, 0.5 + 3 + 1.25);
  assert.equal(v.holdings.length, 4); // zero-qty dust is dropped
});

test('oracle caches lookups within the ttl', async () => {
  let n = 0;
  const now = { t: 0 };
  const oracle = new PriceOracle({ sources: [{ name: 's', get: async () => { n++; return 10; } }], ttlMs: 1000, clock: () => now.t });
  await oracle.usd('ABC');
  await oracle.usd('ABC');
  assert.equal(n, 1);
  now.t = 2000;
  await oracle.usd('ABC');
  assert.equal(n, 2);
});

test('coinbase source parses the spot response and rejects odd symbols', async () => {
  const src = coinbaseSource((async (url: string) => {
    assert.match(url, /prices\/BTC-USD\/spot/);
    return { data: { amount: '65000.12' } };
  }) as any);
  assert.equal(await src.get('BTC'), 65000.12);
  assert.equal(await src.get('bad/symbol'), undefined);
});

test('costOf uses per-million rates, handles dated model ids and falls back to the priciest rate', () => {
  // 100k input, 10k output on sonnet 5.5: 0.2 + 0.1
  assert.equal(costOf('claude-sonnet-5-5', { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 }), 0.3);
  assert.equal(costOf('claude-haiku-4-5-20251001', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 1);
  assert.equal(priceFor('some-new-model', DEFAULT_PRICING), FALLBACK_PRICING);
  assert.equal(costOf('anthropic/claude-sonnet-5-5', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }), 0.2);
});

function meterEnv(over: Partial<OuroConfig> = {}, limits = {}) {
  const env = makeStore();
  const cfg: OuroConfig = deepMerge(structuredClone(DEFAULT_CONFIG), { budget: { sponsorDailyUsd: 2, perEpisodeUsd: 1 }, ...over });
  const meter = new Meter({ store: env.store, config: () => cfg, limits: () => limits, clock: env.clock.fn });
  return { ...env, cfg, meter };
}

test('sponsor budget: daily cap, per-episode cap and exhaustion reason', () => {
  const { meter, clock } = meterEnv();
  assert.equal(meter.episodeBudgetUsd(), 1);
  assert.equal(meter.canStartEpisode().ok, true);
  meter.record({ provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1.5, source: 'pi' });
  assert.equal(meter.status().remainingTodayUsd, 0.5);
  assert.equal(meter.episodeBudgetUsd(), 0.5);
  meter.record({ provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.6, source: 'pi' });
  const s = meter.status();
  assert.equal(s.exhausted, true);
  assert.match(s.reason!, /daily sponsor budget/);
  assert.equal(meter.canStartEpisode().ok, false);
  clock.advance(DAY); // a new day resets the daily cap
  assert.equal(meter.canStartEpisode().ok, true);
});

test('operator limits (root-owned) can only tighten the budget, never loosen it', () => {
  const { cfg } = meterEnv();
  const b = effectiveBudget(cfg, { sponsorDailyUsd: 0.5, perEpisodeUsd: 5 });
  assert.equal(b.dailyUsd, 0.5);
  assert.equal(b.perEpisodeUsd, 1);
  assert.equal(effectiveBudget(cfg, { sponsorTotalUsd: 10 }).totalUsd, 10);
  assert.equal(effectiveBudget(cfg, {}).totalUsd, null);
});

test('total sponsor budget stops the agent for good', () => {
  const { meter } = meterEnv({ budget: { sponsorTotalUsd: 1, sponsorDailyUsd: 100, perEpisodeUsd: 100 } as any });
  meter.record({ provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1.2, source: 'pi' });
  assert.equal(meter.status().exhausted, true);
  assert.match(meter.status().reason!, /total sponsor budget/);
});

test('capital mode: inference is capped at a share of NAV per day', () => {
  const { meter, store } = meterEnv({ budget: { mode: 'capital', capitalMaxDailyPctNav: 0.05, perEpisodeUsd: 10 } as any });
  store.append('capital.in', { usd: 100 });
  store.append('valuation', { venue: 'w', totalUsd: 100, holdings: [] });
  store.append('nav', { usd: 100 });
  assert.equal(meter.status().dailyLimitUsd, 5);
  assert.equal(meter.episodeBudgetUsd(), 5);
  assert.equal(meter.record({ provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 4, source: 'pi' }).funding, 'capital');
  assert.equal(meter.episodeBudgetUsd(), 1);
});
