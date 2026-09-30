import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler, type VenueCall } from '../src/core/reconciler.ts';
import { PriceOracle } from '../src/core/prices.ts';
import { DEFAULT_CONFIG, deepMerge } from '../src/lib/config.ts';
import { HOUR } from '../src/lib/clock.ts';
import { makeStore } from './helpers.ts';

function setup(cfgOver: any = {}) {
  const env = makeStore();
  const answers = new Map<string, any>(); // venue id -> snapshot | Error | {flows}
  const callVenue: VenueCall = async (v, method) => {
    const a = answers.get(v.id);
    if (method === 'flows') return a?.flows ? { ok: true, result: a.flows, durationMs: 1 } : { ok: false, error: 'no flows()', durationMs: 1 };
    if (a instanceof Error) return { ok: false, error: a.message, durationMs: 1 };
    return { ok: true, result: a, durationMs: 1 };
  };
  const oracle = new PriceOracle({ sources: [{ name: 'fake', get: async (a) => (a === 'ETH' ? 2000 : undefined) }] });
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), cfgOver);
  const guardCalls: string[] = [];
  const rec = new Reconciler({ store: env.store, oracle, callVenue, config: () => cfg, clock: env.clock.fn, onGuardTripped: (v) => { guardCalls.push(v.id); } });
  const register = (id: string, extra: any = {}) => env.store.append('venue.register', { id, module: `builtin/${id}`, ...extra });
  const incidents = () => [...env.store.state.incidents.values()];
  return { ...env, answers, rec, register, incidents, guardCalls, cfg };
}

test('a round values every venue, appends valuations and one NAV point', async () => {
  const t = setup();
  t.register('wallet');
  t.register('cex');
  t.answers.set('wallet', { holdings: [{ asset: 'USDC', qty: 0.6 }, { asset: 'ETH', qty: 0.0001 }] });
  t.answers.set('cex', { holdings: [{ asset: 'USD', qty: 0.2 }] });
  const r = await t.rec.round();
  assert.equal(r.navUsd, 0.6 + 0.2 + 0.2);
  assert.equal(t.store.state.navSeries.length, 1);
  assert.equal(t.store.state.venues.get('wallet')!.latest!.totalUsd, 0.8);
});

test('a failing venue keeps its last valuation (no phantom loss) and raises one incident after 3 failures', async () => {
  const t = setup();
  t.register('cex');
  t.answers.set('cex', { holdings: [{ asset: 'USD', qty: 5 }] });
  await t.rec.round();
  t.answers.set('cex', new Error('503 upstream'));
  for (let i = 0; i < 4; i++) {
    t.clock.advance(HOUR);
    const r = await t.rec.round();
    assert.equal(r.navUsd, 5);
  }
  const unreachable = t.incidents().filter((i) => i.kind === 'venue_unreachable');
  assert.equal(unreachable.length, 1);
  assert.deepEqual(t.store.state.navSeries.at(-1)!.stale, ['cex']);
  // recovery clears the error state
  t.answers.set('cex', { holdings: [{ asset: 'USD', qty: 6 }] });
  await t.rec.round();
  assert.equal(t.store.state.venues.get('cex')!.lastError, undefined);
});

test('an unexplained NAV jump is flagged; a recorded deposit explains it', async () => {
  const t = setup();
  t.register('w');
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 1 }] });
  await t.rec.round();
  t.clock.advance(HOUR);
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 2 }] });
  await t.rec.round();
  assert.equal(t.incidents().filter((i) => i.kind === 'unexplained_jump').length, 1);

  // same jump, but the operator recorded the deposit
  const u = setup();
  u.register('w');
  u.store.append('capital.in', { usd: 1, venue: 'w', by: 'operator' });
  u.answers.set('w', { holdings: [{ asset: 'USD', qty: 1 }] });
  await u.rec.round();
  u.clock.advance(HOUR);
  u.store.append('capital.in', { usd: 1, venue: 'w', by: 'operator' });
  u.answers.set('w', { holdings: [{ asset: 'USD', qty: 2 }] });
  await u.rec.round();
  assert.equal(u.incidents().filter((i) => i.kind === 'unexplained_jump').length, 0);
  assert.equal(u.store.state.metrics(u.clock.now()).pnlUsd, 0);
});

test('a jump backed by logged trade P&L is not flagged', async () => {
  const t = setup();
  t.register('w');
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 1 }] });
  await t.rec.round();
  t.clock.advance(HOUR);
  t.store.append('trade', { venue: 'w', market: 'X', side: 'sell', qty: 1, price: 1, pnlUsd: 0.5 });
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 1.5 }] });
  await t.rec.round();
  assert.equal(t.incidents().filter((i) => i.kind === 'unexplained_jump').length, 0);
});

test('a sharp NAV drop raises nav_drop (critical past 50%)', async () => {
  const t = setup();
  t.register('w');
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 10 }] });
  await t.rec.round();
  t.clock.advance(HOUR);
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 4 }] });
  await t.rec.round();
  const drop = t.incidents().find((i) => i.kind === 'nav_drop')!;
  assert.equal(drop.severity, 'critical');
});

test('per-venue drawdown guard fires once and calls back', async () => {
  const t = setup();
  t.register('pod', { strategy: 'momo', guard: { maxDrawdownPct: 0.3 } });
  t.answers.set('pod', { holdings: [{ asset: 'USD', qty: 10 }] });
  await t.rec.round();
  t.clock.advance(HOUR);
  t.answers.set('pod', { holdings: [{ asset: 'USD', qty: 6 }] });
  await t.rec.round();
  t.clock.advance(HOUR);
  await t.rec.round();
  assert.equal(t.incidents().filter((i) => i.kind === 'guard_tripped').length, 1);
  assert.deepEqual(t.guardCalls, ['pod']);
});

test('adapter-reported flows: operator deposits become capital, unknown senders become unclassified inflows, duplicates are ignored', async () => {
  const t = setup({ operator: { addresses: ['0xAbC0000000000000000000000000000000000001'] } });
  t.register('w');
  t.answers.set('w', {
    holdings: [{ asset: 'USDC', qty: 3 }],
    flows: [
      { kind: 'deposit', asset: 'USDC', qty: 1, ref: '0xtx1', from: '0xabc0000000000000000000000000000000000001' },
      { kind: 'deposit', asset: 'USDC', qty: 2, ref: '0xtx2', from: '0xstranger' },
    ],
  });
  await t.rec.round();
  assert.equal(t.store.state.contributedUsd, 1);
  assert.equal(t.store.state.unclassifiedInflows().length, 1);
  assert.equal(t.incidents().filter((i) => i.kind === 'unclassified_inflow').length, 1);
  t.clock.advance(HOUR);
  await t.rec.round(); // same flows reported again
  assert.equal(t.store.state.contributedUsd, 1);
  assert.equal(t.store.state.unclassifiedInflows().length, 1);
});

test('unpriced assets are excluded from NAV and surfaced as an incident', async () => {
  const t = setup();
  t.register('w');
  t.answers.set('w', { holdings: [{ asset: 'USD', qty: 1 }, { asset: 'OBSCURE', qty: 100 }] });
  const r = await t.rec.round();
  assert.equal(r.navUsd, 1);
  assert.equal(t.incidents().filter((i) => i.kind === 'unpriced_assets').length, 1);
  assert.deepEqual(t.store.state.metrics(t.clock.now()).unpricedAssets, ['w:OBSCURE']);
});
