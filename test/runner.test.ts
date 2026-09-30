// tests for the episode runner, with a fake pi process that speaks the rpc protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EpisodeRunner, type RunnerDeps } from '../src/core/runner.ts';
import { PiRpc, type PiSpawnOptions } from '../src/core/pi-rpc.ts';
import { Meter } from '../src/core/meter.ts';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { DEFAULT_CONFIG, deepMerge, type OuroConfig } from '../src/lib/config.ts';
import { ROOT_DIR } from '../src/lib/paths.ts';
import { sealCharter } from '../src/core/charter.ts';
import { tmpEnv, PAID_LLM } from './helpers.ts';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/fake-pi.mjs');

function setup(script: object, cfgOver: any = {}, opts: { proxy?: boolean } = {}) {
  const e = tmpEnv();
  for (const d of [e.paths.run, e.paths.memory, e.paths.logs]) fs.mkdirSync(d, { recursive: true });
  sealCharter(e.paths, ROOT_DIR);
  const store = new StateStore(new EventLog(e.paths.events));
  const cfg: OuroConfig = deepMerge(deepMerge(structuredClone(DEFAULT_CONFIG), PAID_LLM), { schedule: { stallSec: 2, episodeTimeoutSec: 30 }, budget: { perEpisodeUsd: 1, sponsorDailyUsd: 5 }, ...cfgOver });
  const meter = new Meter({ store, config: () => cfg, limits: () => ({}) });
  const logFile = path.join(e.dir, 'fake-pi.log');
  const spawnLog: PiSpawnOptions[] = [];
  const issued: Array<{ token: string; cap?: number; episode?: string }> = [];
  const revoked: string[] = [];
  const deps: RunnerDeps = {
    paths: e.paths,
    store,
    meter,
    config: () => cfg,
    limits: () => ({}),
    getSecret: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-real-key-should-not-leak' : undefined),
    strategies: () => [],
    releaseSha: () => 'abc1234567',
    proxy: opts.proxy
      ? () => ({
          url: 'http://127.0.0.1:9999',
          issueToken: (o) => {
            const token = `ouro-tok-${issued.length}`;
            issued.push({ token, cap: o.capUsd, episode: o.episode });
            return token;
          },
          revokeToken: (t) => void revoked.push(t),
          spentUsd: () => 0,
        })
      : undefined,
    spawn: (o) => {
      spawnLog.push(o);
      return PiRpc.spawn({ ...o, command: process.execPath, args: [FIXTURE, ...o.args], env: { ...o.env, FAKE_PI_SCRIPT: JSON.stringify(script), FAKE_PI_LOG: logFile } });
    },
  };
  const runner = new EpisodeRunner(deps);
  return { ...e, store, cfg, meter, runner, logFile, spawnLog, issued, revoked };
}

const assistant = (cost: number, extra: any = {}) => ({
  type: 'message_end',
  message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', content: [{ type: 'text', text: 'thinking about money' }], usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, ...extra },
});
const request = { triggers: [{ kind: 'heartbeat' as const, ts: Date.now() }] };

test('a normal episode: briefing sent, cost recorded once, handoff captured, episode events in the log', async () => {
  const t = setup({ events: [{ type: 'tool_execution_start', toolName: 'ouro_status' }, assistant(0.05), assistant(0.03)] });
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'completed', result.error);
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.costUsd, 0.08);
  assert.equal(t.store.state.llm.sponsorUsd, 0.08);
  assert.equal(t.store.state.episodes.length, 1);
  assert.equal(t.store.state.episodes[0].outcome, 'completed');
  assert.match(result.handoff ?? '', /thinking about money/);
  // the runner passed the briefing as the prompt, and started pi with the right flags
  const logged = fs.readFileSync(t.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const prompt = logged.find((l) => l.cmd.type === 'prompt');
  assert.match(prompt.cmd.message, /## Money/);
  assert.match(prompt.cmd.message, /Episode 1/);
  const args = t.spawnLog[0].args;
  assert.equal(args[args.indexOf('--mode') + 1], 'rpc');
  assert.equal(args[args.indexOf('--provider') + 1], 'anthropic');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.ok(args.includes('-e'));
  assert.equal(t.runner.running(), false);
});

test('the agent\'s episode_end note becomes the handoff for the next briefing', async () => {
  const t = setup({ events: [assistant(0.01), { type: 'tool_execution_start', delayMs: 1500 }] });
  const p = t.runner.run(request);
  for (let i = 0; i < 100 && !t.runner.current(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.runner.noteEnd(t.runner.current()!.id, { handoff: 'watch the ETH funding rate at 14:00', nextWakeMinutes: 90 }), true);
  const result = await p;
  assert.equal(result.handoff, 'watch the ETH funding rate at 14:00');
  assert.equal(t.runner._last?.end?.nextWakeMinutes, 90);
  assert.equal(t.runner.noteEnd('wrong-id', { handoff: 'x' }), false);
  const second = await t.runner.run(request);
  const logged = fs.readFileSync(t.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cmd.type === 'prompt');
  assert.match(logged.at(-1).cmd.message, /watch the ETH funding rate at 14:00/);
  assert.equal(second.outcome, 'completed');
});

test('an episode that reaches its budget is aborted and reported as budget', async () => {
  const t = setup({ events: [assistant(0.6), assistant(0.6, {}), { type: 'message_end', delayMs: 500, message: { role: 'assistant', content: [], usage: {} } }] });
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'budget');
  assert.ok(result.costUsd >= 1);
});

test('a hung pi is caught by the stall watchdog and killed', async () => {
  const t = setup({ hang: true });
  const started = Date.now();
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'stalled');
  assert.ok(Date.now() - started < 20_000);
  assert.equal(t.runner.running(), false);
});

test('a pi that crashes mid-episode is reported as error and leaves no active episode', async () => {
  const t = setup({ crashAfterMs: 200, events: [{ type: 'tool_execution_start', delayMs: 3000 }] });
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'error');
  assert.match(result.error ?? '', /exited/);
  assert.equal(t.runner.running(), false);
  assert.equal(t.store.state.currentEpisode, undefined);
});

test('a pi that ignores abort is killed after the grace period', async () => {
  const t = setup({ ignoreAbort: true, events: [assistant(2), { type: 'tool_execution_start', delayMs: 100 }] }, { budget: { perEpisodeUsd: 1 } });
  const started = Date.now();
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'budget');
  assert.ok(Date.now() - started < 60_000);
  assert.equal(t.runner.running(), false);
});

test('precheck refuses when the budget is spent, the key is missing or the charter fails', async () => {
  const t = setup({ events: [] });
  t.meter.record({ provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 99, source: 'pi' });
  let r = await t.runner.run(request);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.error!, /daily sponsor budget/);

  const noKey = setup({ events: [] });
  (noKey.runner as any).d.getSecret = () => undefined;
  r = await noKey.runner.run(request);
  assert.match(r.error!, /ANTHROPIC_API_KEY/);

  const tampered = setup({ events: [] });
  fs.writeFileSync(tampered.paths.charterSeal, '0'.repeat(64) + '\n');
  r = await tampered.runner.run(request);
  assert.match(r.error!, /charter/);
  assert.equal(tampered.store.state.episodes.length, 0, 'a refused episode leaves no trace in the episode list');
});

test('with the proxy on, pi only ever sees a per-episode token, never the real key, and the token is revoked', async () => {
  const t = setup({ events: [assistant(0.02)] }, {}, { proxy: true });
  const result = await t.runner.run(request);
  assert.equal(result.outcome, 'completed', result.error);
  const env = t.spawnLog[0].env;
  assert.equal(env.ANTHROPIC_API_KEY, 'ouro-tok-0');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999/anthropic');
  assert.equal(env.OURO_LLM_PROXY_URL, 'http://127.0.0.1:9999');
  assert.ok(!JSON.stringify(env).includes('sk-real-key-should-not-leak'));
  assert.equal(t.issued[0].cap, 1);
  assert.deepEqual(t.revoked, ['ouro-tok-0']);
  // the proxy is the ledger's source when enabled, so the runner must not double-record
  assert.equal(t.store.state.llm.entries.length, 0);
});

test('without the proxy, pi gets the real key and the runner records usage itself', async () => {
  const t = setup({ events: [assistant(0.04)] });
  await t.runner.run(request);
  assert.equal(t.spawnLog[0].env.ANTHROPIC_API_KEY, 'sk-real-key-should-not-leak');
  assert.equal(t.store.state.llm.entries.length, 1);
});
