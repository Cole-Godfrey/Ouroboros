import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProcMan } from '../src/core/procman.ts';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { tmpEnv } from './helpers.ts';

function setup(secrets: Record<string, string> = {}) {
  const e = tmpEnv();
  fs.mkdirSync(e.paths.workspace, { recursive: true });
  fs.mkdirSync(e.paths.logs, { recursive: true });
  const store = new StateStore(new EventLog(e.paths.events));
  const env = (names: string[]) => ({ env: Object.fromEntries(names.filter((n) => n in secrets).map((n) => [n, secrets[n]])), missing: names.filter((n) => !(n in secrets)) });
  const pm = new ProcMan({ paths: e.paths, store, env });
  return { ...e, store, pm, env };
}
const wait = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond(), 'condition not reached in time');
};
const sleeper = (name: string, extra: any = {}) => ({ name, cmd: [process.execPath, '-e', 'setInterval(() => console.log("tick", process.env.MY_SECRET ?? ""), 200)'], restart: 'always' as const, ...extra });

test('start, log, stop; secrets reach the process environment and nothing else from the daemon does', async () => {
  const t = setup({ MY_SECRET: 'shh-123' });
  process.env.DAEMON_ONLY = 'nope';
  t.pm.register(sleeper('probe', { secrets: ['MY_SECRET'], cmd: [process.execPath, '-e', 'console.log("env:", process.env.MY_SECRET, process.env.DAEMON_ONLY ?? "absent"); setInterval(() => {}, 1000)'] }));
  const { pid } = t.pm.start('probe');
  delete process.env.DAEMON_ONLY;
  assert.ok(pid > 0);
  await wait(() => t.pm.logs('probe').includes('env: shh-123 absent'));
  assert.equal(t.pm.list()[0].status, 'running');
  await t.pm.stop('probe');
  assert.equal(t.pm.list()[0].status, 'stopped');
  assert.throws(() => process.kill(pid, 0));
  assert.deepEqual(t.store.state.selfmod.history, []); // untouched
});

test('a strategy missing its secrets refuses to start with a clear error', () => {
  const t = setup({});
  t.pm.register(sleeper('needs-key', { secrets: ['KRAKEN_KEY'] }));
  assert.throws(() => t.pm.start('needs-key'), /missing secrets in the vault: KRAKEN_KEY/);
});

test('a crashing strategy is restarted with backoff and reported as abnormal to the scheduler', async () => {
  const t = setup();
  t.pm.register({ name: 'flaky', cmd: [process.execPath, '-e', 'process.exit(2)'], restart: 'always' });
  t.pm.start('flaky');
  await wait(() => t.pm.get('flaky')!.status === 'backoff');
  const exits = () => t.store.log.readAll().filter((e) => e.type === 'strategy.exit');
  assert.equal(exits().length, 1);
  assert.equal(exits()[0].data.abnormal, true);
  // fast-forward the backoff: tick() restarts it
  t.pm.get('flaky')!.nextStartAt = Date.now() - 1;
  t.pm.tick();
  assert.equal(t.pm.get('flaky')!.status, 'running');
  await t.pm.stop('flaky');
});

test('restart:never leaves a finished job stopped; clean exit is not abnormal', async () => {
  const t = setup();
  t.pm.register({ name: 'once', cmd: [process.execPath, '-e', 'console.log("done")'], restart: 'never' });
  t.pm.start('once');
  await wait(() => t.pm.get('once')!.status === 'stopped');
  const ev = t.store.log.readAll().filter((e) => e.type === 'strategy.exit').at(-1)!;
  assert.equal(ev.data.abnormal, false);
});

test('a crash-looping strategy gives up after too many exits in an hour', async () => {
  const t = setup();
  t.pm.register({ name: 'loop', cmd: [process.execPath, '-e', 'process.exit(1)'], restart: 'always' });
  t.pm.start('loop');
  for (let i = 0; i < 12; i++) {
    await wait(() => ['backoff', 'failed'].includes(t.pm.get('loop')!.status));
    if (t.pm.get('loop')!.status === 'failed') break;
    t.pm.get('loop')!.nextStartAt = Date.now() - 1;
    t.pm.tick();
  }
  assert.equal(t.pm.get('loop')!.status, 'failed');
  assert.equal(t.pm.get('loop')!.desired, 'stopped');
});

test('strategies survive the manager: a new ProcMan re-adopts a running process, and notices when it has died', async () => {
  const t = setup();
  t.pm.register(sleeper('durable'));
  const { pid } = t.pm.start('durable');
  const pm2 = new ProcMan({ paths: t.paths, store: t.store, env: t.env });
  pm2.adoptAll();
  assert.equal(pm2.list()[0].status, 'running');
  assert.equal(pm2.list()[0].pid, pid);
  process.kill(-pid, 'SIGKILL');
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  pm2.tick();
  assert.notEqual(pm2.get('durable')!.status, 'running');
  await pm2.stopAll('test');
  await t.pm.stopAll('test');
});

test('names and argv are validated', () => {
  const t = setup();
  assert.throws(() => t.pm.register({ name: 'Bad Name', cmd: ['x'], restart: 'never' }), /lowercase/);
  assert.throws(() => t.pm.register({ name: 'ok', cmd: [], restart: 'never' }), /argv/);
});
