// tests for the state fold: profit and loss, the wealth index, drawdown, subsidy and inbox state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR } from '../src/lib/clock.ts';
import { makeStore } from './helpers.ts';

function nav(store: ReturnType<typeof makeStore>['store'], usd: number) {
  store.append('nav', { usd });
}

test('P&L is NAV minus net contributions', () => {
  const { store, clock } = makeStore();
  store.append('capital.in', { usd: 1, by: 'operator' });
  store.append('valuation', { venue: 'wallet', totalUsd: 1, holdings: [] });
  nav(store, 1);
  clock.advance(HOUR);
  store.append('valuation', { venue: 'wallet', totalUsd: 1.4, holdings: [] });
  nav(store, 1.4);
  const m = store.state.metrics(clock.now());
  assert.equal(m.navUsd, 1.4);
  assert.equal(m.netContributedUsd, 1);
  assert.equal(m.pnlUsd, 0.4);
  assert.ok(Math.abs((m.pnlPct ?? 0) - 0.4) < 1e-9);
});

test('a deposit does not register as profit in the wealth index', () => {
  const { store, clock } = makeStore();
  store.append('capital.in', { usd: 1, by: 'operator' });
  store.append('valuation', { venue: 'w', totalUsd: 1, holdings: [] });
  nav(store, 1);
  clock.advance(DAY);
  store.append('capital.in', { usd: 1, by: 'operator' }); // deposit lands mid-interval
  store.append('valuation', { venue: 'w', totalUsd: 2, holdings: [] });
  nav(store, 2);
  const idx = store.state.wealthIndex();
  assert.equal(idx.length, 2);
  assert.ok(Math.abs(idx[1].index - 1) < 1e-9, `index=${idx[1].index}`);
  assert.equal(store.state.metrics(clock.now()).pnlUsd, 0);
});

test('growth per day and doubling time come from the flow-adjusted index', () => {
  const { store, clock } = makeStore();
  store.append('capital.in', { usd: 1 });
  store.append('valuation', { venue: 'w', totalUsd: 1, holdings: [] });
  nav(store, 1);
  clock.advance(DAY);
  store.append('valuation', { venue: 'w', totalUsd: 2, holdings: [] });
  nav(store, 2);
  const m = store.state.metrics(clock.now());
  assert.ok(Math.abs((m.growth.all ?? 0) - Math.LN2) < 1e-9);
  assert.ok(Math.abs((m.doublingDays ?? 0) - 1) < 1e-9);
});

test('drawdown tracks peak-to-trough on the index, ignoring flows', () => {
  const { store, clock } = makeStore();
  store.append('capital.in', { usd: 10 });
  for (const v of [10, 12, 6, 9]) {
    store.append('valuation', { venue: 'w', totalUsd: v, holdings: [] });
    nav(store, v);
    clock.advance(HOUR);
  }
  const dd = store.state.drawdown();
  assert.ok(Math.abs(dd.max - 0.5) < 1e-9);
  assert.ok(Math.abs(dd.current - 0.25) < 1e-9);
});

test('subsidy (sponsor-funded cost) is tracked separately from NAV', () => {
  const { store, clock } = makeStore();
  store.append('capital.in', { usd: 1 });
  store.append('valuation', { venue: 'w', totalUsd: 1, holdings: [] });
  nav(store, 1);
  store.append('llm.usage', { model: 'm', costUsd: 0.25, funding: 'sponsor', input: 10, output: 5 });
  store.append('expense', { usd: 0.05, category: 'data', funding: 'sponsor' });
  store.append('expense', { usd: 0.02, category: 'gas', funding: 'capital' });
  const m = store.state.metrics(clock.now());
  assert.equal(m.navUsd, 1);
  assert.equal(m.pnlUsd, 0);
  assert.equal(m.subsidyUsd, 0.3);
  assert.equal(m.pnlAfterSubsidyUsd, -0.3);
  assert.equal(store.state.expenses.byCategory.gas.capitalUsd, 0.02);
});

test('llm spend can be summed per local day and funding source', () => {
  const { store, clock } = makeStore();
  store.append('llm.usage', { model: 'm', costUsd: 0.5, funding: 'sponsor' });
  clock.advance(DAY);
  store.append('llm.usage', { model: 'm', costUsd: 0.25, funding: 'sponsor' });
  store.append('llm.usage', { model: 'm', costUsd: 0.1, funding: 'capital' });
  const today = new Date(clock.now()).toISOString().slice(0, 10);
  assert.equal(store.state.llmSpendUsd({ dayKey: today, tz: 'UTC', funding: 'sponsor' }), 0.25);
  assert.equal(store.state.llmSpendUsd({ funding: 'sponsor' }), 0.75);
});

test('inbox: operator replies mark items answered and show up as unseen for the agent', () => {
  const { store } = makeStore();
  store.append('inbox.item', { id: 'a1', kind: 'request', from: 'agent', title: 'Fund me', body: 'send $1', urgency: 'normal' });
  assert.equal(store.state.openInbox().length, 1);
  assert.equal(store.state.unseenForAgent().length, 0);
  store.append('inbox.reply', { id: 'a1', by: 'operator', text: 'done', channel: 'cli' });
  assert.equal(store.state.inbox.get('a1')!.status, 'answered');
  assert.equal(store.state.unseenForAgent().length, 1);
  store.append('inbox.ack', { ids: ['a1'] });
  assert.equal(store.state.unseenForAgent().length, 0);
  store.append('inbox.status', { id: 'a1', status: 'done', by: 'agent' });
  assert.equal(store.state.openInbox().length, 0);
});

test('selfmod promote/confirm/rollback maintain current, lkg and bad releases', () => {
  const { store, clock } = makeStore();
  store.append('selfmod.baseline', { sha: 'aaa' });
  store.append('selfmod.promote', { id: 'p1', sha: 'bbb', prev: 'aaa', probationUntil: clock.now() + 1000 });
  assert.equal(store.state.selfmod.current, 'bbb');
  assert.equal(store.state.selfmod.lkg, 'aaa');
  assert.equal(store.state.selfmod.probation?.sha, 'bbb');
  store.append('selfmod.rollback', { id: 'p1', from: 'bbb', to: 'aaa', reason: 'crash loop' });
  assert.equal(store.state.selfmod.current, 'aaa');
  assert.deepEqual(store.state.selfmod.bad, ['bbb']);
  assert.equal(store.state.selfmod.probation, undefined);
  store.append('selfmod.promote', { id: 'p2', sha: 'ccc', prev: 'aaa', probationUntil: clock.now() + 1 });
  store.append('selfmod.confirm', { id: 'p2', sha: 'ccc' });
  assert.equal(store.state.selfmod.lkg, 'ccc');
  assert.equal(store.state.selfmod.probation, undefined);
});

test('StateStore.sync picks up events appended by another writer', () => {
  const { store } = makeStore();
  store.append('capital.in', { usd: 1 });
  store.log.append('capital.in', { usd: 2 }); // bypasses the store, like another process
  assert.equal(store.state.contributedUsd, 1);
  assert.equal(store.sync(), 1);
  assert.equal(store.state.contributedUsd, 3);
});
