import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/core/scheduler.ts';
import { DEFAULT_CONFIG, deepMerge } from '../src/lib/config.ts';
import { HOUR, MINUTE } from '../src/lib/clock.ts';
import { makeStore } from './helpers.ts';

function setup(over: any = {}) {
  const env = makeStore();
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), over);
  const gate = { ok: true, reason: undefined as string | undefined };
  const sched = new Scheduler({ store: env.store, config: () => cfg, precheck: () => gate, clock: env.clock.fn });
  sched.attach();
  const finishEpisode = (reason: string, outcome = 'completed', end?: any) => {
    env.store.append('episode.start', { id: `ep${env.store.state.episodes.length}`, reason });
    env.clock.advance(MINUTE);
    env.store.append('episode.end', { id: `ep${env.store.state.episodes.length}`, outcome, costUsd: 0.1 });
    sched.onEpisodeEnd({ id: 'x', outcome: outcome as any, costUsd: 0.1, turns: 1, toolCalls: 0, durationMs: 1 }, end);
  };
  return { ...env, cfg, gate, sched, finishEpisode };
}

test('the very first episode is genesis, and genesis repeats until one completes', () => {
  const t = setup();
  let req = t.sched.tick();
  assert.equal(req?.triggers[0].kind, 'genesis');
  assert.equal(req?.tier, 'default');
  t.finishEpisode('genesis', 'error');
  t.clock.advance(HOUR);
  req = t.sched.tick();
  assert.equal(req?.triggers[0].kind, 'genesis', 'a failed genesis is retried');
  t.finishEpisode('genesis', 'completed');
  t.clock.advance(1);
  assert.equal(t.sched.tick(), undefined, 'nothing due right after a completed genesis');
});

test('heartbeat fires after the configured interval, not before', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis');
  t.clock.advance(59 * MINUTE);
  assert.equal(t.sched.tick(), undefined);
  t.clock.advance(2 * MINUTE);
  assert.deepEqual(t.sched.tick()?.triggers.map((x) => x.kind), ['heartbeat']);
});

test('operator messages wake the agent quickly; info incidents do not, warnings do', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis');
  t.clock.advance(15_000);
  t.store.append('incident', { id: 'i1', severity: 'info', kind: 'unpriced_assets', message: 'meh' });
  assert.equal(t.sched.tick(), undefined);
  t.store.append('incident', { id: 'i2', severity: 'warn', kind: 'nav_drop', message: 'down 30%' });
  t.clock.advance(15_000);
  const req = t.sched.tick();
  assert.deepEqual(req?.triggers.map((x) => x.kind), ['incident']);
  t.finishEpisode('incident');
  t.clock.advance(15_000);
  t.store.append('inbox.item', { id: 'm1', kind: 'message', from: 'operator', title: 'hello', body: 'hello' });
  assert.deepEqual(t.sched.tick()?.triggers.map((x) => x.kind), ['operator']);
});

test('triggers are coalesced into one episode and ordered by importance', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis');
  t.clock.advance(2 * HOUR);
  t.store.append('incident', { id: 'i1', severity: 'critical', kind: 'guard_tripped', message: 'x' });
  t.store.append('inbox.item', { id: 'm1', kind: 'message', from: 'operator', title: 'hi', body: 'hi' });
  t.store.append('strategy.exit', { name: 'momo', abnormal: true, detail: 'exit 1' });
  const req = t.sched.tick()!;
  assert.deepEqual(req.triggers.map((x) => x.kind), ['operator', 'incident', 'strategy', 'heartbeat']);
  assert.equal(t.sched.tick(), undefined, 'drained: nothing left pending');
});

test('pause and halt stop wake-ups; resume triggers one', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis');
  t.store.append('control', { action: 'pause', by: 'operator' });
  t.clock.advance(5 * HOUR);
  assert.equal(t.sched.tick(), undefined);
  assert.match(t.sched.blockedReason ?? '', /paused/);
  t.store.append('control', { action: 'resume', by: 'operator' });
  assert.equal(t.sched.tick()?.triggers[0].kind, 'resume');
});

test('minimum gap between episodes, with exponential backoff after failures', () => {
  const t = setup({ schedule: { minGapSec: 60 } });
  t.sched.tick();
  t.finishEpisode('genesis');
  t.store.append('inbox.item', { id: 'a', kind: 'message', from: 'operator', title: 'x', body: 'x' });
  t.clock.advance(5_000);
  assert.equal(t.sched.tick(), undefined, 'even urgent triggers wait a few seconds');
  t.clock.advance(6_000);
  assert.ok(t.sched.tick());
  t.finishEpisode('operator', 'error');
  t.finishEpisode('operator', 'error');
  t.store.append('inbox.item', { id: 'b', kind: 'message', from: 'operator', title: 'y', body: 'y' });
  t.clock.advance(2 * MINUTE);
  assert.equal(t.sched.tick(), undefined, 'two failures => backoff of 4 minutes');
  t.clock.advance(3 * MINUTE);
  assert.ok(t.sched.tick());
});

test('the agent can choose its next wake within bounds, and the request survives in the log', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis', 'completed', { handoff: 'h', nextWakeMinutes: 1000, reason: 'check funding' });
  const wakes = t.store.state.pendingWakes();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].reason, 'check funding');
  t.clock.advance(6 * HOUR + MINUTE);
  const kinds = t.sched.tick()!.triggers.map((x) => x.kind);
  assert.ok(kinds.includes('timer') || kinds.includes('heartbeat'));
  assert.equal(t.store.state.pendingWakes().length, 0, 'due wakes are consumed');
});

test('a cheap tier requested at episode end is honoured only for routine wake-ups', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis', 'completed', { handoff: 'h', nextWakeMinutes: 10, tier: 'cheap', reason: 'routine check' });
  t.clock.advance(15 * MINUTE);
  assert.equal(t.sched.tick()?.tier, 'cheap');
  t.finishEpisode('timer');
  t.clock.advance(2 * HOUR);
  t.store.append('incident', { id: 'x', severity: 'warn', kind: 'nav_drop', message: 'm' });
  assert.equal(t.sched.tick()?.tier, 'default');
});

test('when the runner cannot start (budget, key, charter) triggers stay pending and the reason is exposed', () => {
  const t = setup();
  t.sched.tick();
  t.finishEpisode('genesis');
  t.gate.ok = false;
  t.gate.reason = 'daily sponsor budget of $5.00 is spent';
  t.store.append('inbox.item', { id: 'a', kind: 'message', from: 'operator', title: 'x', body: 'x' });
  t.clock.advance(HOUR);
  assert.equal(t.sched.tick(), undefined);
  assert.match(t.sched.blockedReason!, /budget/);
  t.gate.ok = true;
  assert.deepEqual(t.sched.tick()?.triggers.map((x) => x.kind).slice(0, 1), ['operator']);
});
