// tests for the last-resort supervisor: restarts, rollback during probation and heartbeat watchdog. the daemon is replaced by tiny scripts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS module without types
import { Supervisor, EXIT_RESTART } from '../boot/ouro-boot.mjs';
import { tmpDir } from './helpers.ts';

/** a fake release directory whose "daemon" is a tiny script we control via files. */
function setup() {
  const home = tmpDir();
  const mkRelease = (name: string, script: string) => {
    const dir = path.join(home, 'releases', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.ouro-release.json'), JSON.stringify({ sha: name.padEnd(40, '0') }));
    fs.writeFileSync(path.join(dir, 'daemon.mjs'), script);
    return dir;
  };
  const link = (name: string, dir: string) => { try { fs.rmSync(path.join(home, name), { force: true }); } catch { /* */ } fs.symlinkSync(dir, path.join(home, name)); };
  const counter = path.join(home, 'starts.log');
  // the fake daemon appends its release name to a file, then behaves per the release's script
  const script = (body: string) => `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, process.env.OURO_RELEASE.split('/').pop() + '\\n'); ${body}`;
  const mk = (extra: any = {}) => new Supervisor({
    home,
    log: () => {},
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    buildCommand: (dir: string) => ({ cmd: process.execPath, args: [path.join(dir, 'daemon.mjs')] }),
    graceMs: 800, staleMs: 400, tickMs: 50,
    ...extra,
  });
  return { home, mkRelease, link, script, mk, starts: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n') : []), promotion: () => JSON.parse(fs.readFileSync(path.join(home, 'run', 'promotion.json'), 'utf8')) };
}

test('exit code 75 restarts into `current` without counting as a crash; exit 0 stops the supervisor', async () => {
  const t = setup();
  const a = t.mkRelease('rel-a', t.script(`
    const n = fs.readFileSync(${JSON.stringify(path.join(t.home, 'starts.log'))}, 'utf8').trim().split('\\n').length;
    process.exit(n < 3 ? ${EXIT_RESTART} : 0);
  `));
  t.link('current', a);
  const sup = t.mk();
  const code = await sup.run();
  assert.equal(code, 0);
  assert.equal(t.starts().length, 3);
  assert.equal(sup.crashes.length, 0);
});

test('a restart after promotion runs the NEW release (the symlink is re-resolved every start)', async () => {
  const t = setup();
  const a = t.mkRelease('rel-a', t.script(`process.exit(${EXIT_RESTART});`));
  const b = t.mkRelease('rel-b', t.script(`process.exit(0);`));
  t.link('current', a);
  const sup = t.mk();
  const run = sup.run();
  await new Promise((r) => setTimeout(r, 300)); // rel-a restarts itself in a loop until the link flips
  t.link('current', b);
  await run;
  assert.deepEqual(t.starts().filter((s, i, arr) => i === 0 || s !== arr[i - 1]).slice(0, 2), ['rel-a', 'rel-b']);
});

test('crash loop during probation rolls current back to the last known good release and records it', async () => {
  const t = setup();
  const good = t.mkRelease('rel-good', t.script(`process.exit(0);`));
  const bad = t.mkRelease('rel-bad', t.script(`process.exit(1);`));
  t.link('lkg', good);
  t.link('current', bad);
  fs.mkdirSync(path.join(t.home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'run', 'promotion.json'), JSON.stringify({ id: 'sm1', sha: 'rel-bad'.padEnd(40, '0'), prev: 'rel-good'.padEnd(40, '0'), state: 'probation', risk: 'normal', promotedAt: 1 }));
  const sup = t.mk();
  const code = await sup.run();
  assert.equal(code, 0, 'after the rollback the good release ran and exited cleanly');
  assert.deepEqual(t.starts(), ['rel-bad', 'rel-bad', 'rel-bad', 'rel-good']);
  assert.equal(fs.realpathSync(path.join(t.home, 'current')), fs.realpathSync(good));
  const p = t.promotion();
  assert.equal(p.state, 'rolledback');
  assert.equal(p.ingested, false);
  assert.match(p.reason, /crash loop: 3 crashes/);
});

test('a release that never writes a heartbeat is killed and rolled back during probation', async () => {
  const t = setup();
  const good = t.mkRelease('rel-good', t.script(`process.exit(0);`));
  const hang = t.mkRelease('rel-hang', t.script(`setInterval(() => {}, 1000);`)); // alive but never healthy
  t.link('lkg', good);
  t.link('current', hang);
  fs.mkdirSync(path.join(t.home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'run', 'promotion.json'), JSON.stringify({ id: 'sm2', sha: 'rel-hang'.padEnd(40, '0'), prev: 'x', state: 'pending', risk: 'normal', promotedAt: 1 }));
  const sup = t.mk();
  await sup.run();
  assert.deepEqual(t.starts(), ['rel-hang', 'rel-good']);
  assert.match(t.promotion().reason, /never became healthy/);
});

test('a heartbeat that goes stale gets a healthy-looking but hung daemon killed', async () => {
  const t = setup();
  const hb = path.join(t.home, 'run', 'heartbeat.json');
  fs.mkdirSync(path.dirname(hb), { recursive: true });
  const hung = t.mkRelease('rel-a', t.script(`
    fs.writeFileSync(${JSON.stringify(hb)}, JSON.stringify({ pid: process.pid, ts: Date.now() })); // one heartbeat, then silence
    setInterval(() => {}, 1000);
  `));
  t.link('current', hung);
  const sup = t.mk();
  const started = Date.now();
  const p = sup.run();
  await new Promise((r) => setTimeout(r, 2500));
  sup.stop();
  await p;
  assert.ok(t.starts().length >= 2, `restarted after the hang (starts=${t.starts().length})`);
  assert.ok(Date.now() - started < 8000);
});

test('with no last-known-good to fall back to, a crash loop just backs off and keeps trying', async () => {
  const t = setup();
  const only = t.mkRelease('rel-only', t.script(`process.exit(1);`));
  t.link('current', only);
  t.link('lkg', only);
  fs.mkdirSync(path.join(t.home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'run', 'promotion.json'), JSON.stringify({ id: 'b', sha: 'rel-only'.padEnd(40, '0'), state: 'probation', risk: 'normal', promotedAt: 1 }));
  const sup = t.mk();
  const p = sup.run();
  await new Promise((r) => setTimeout(r, 600));
  sup.stop();
  await p;
  assert.ok(t.starts().length >= 4);
  assert.equal(t.promotion().state, 'probation', 'no rollback happened');
});
