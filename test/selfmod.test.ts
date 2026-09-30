// tests for the self-modification pipeline in a throwaway git repository, with a fake gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SelfMod, isHighRisk, type GateStep } from '../src/core/selfmod.ts';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { DEFAULT_CONFIG } from '../src/lib/config.ts';
import { tmpEnv, fakeClock } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const okGate = async (): Promise<GateStep[]> => [{ name: 'fake', ok: true, ms: 1, tail: '' }];
const badGate = async (): Promise<GateStep[]> => [{ name: 'tests', ok: false, ms: 1, tail: 'expected 1 got 2' }];

async function setup(gate = okGate) {
  const e = tmpEnv();
  const { paths } = e;
  fs.mkdirSync(paths.code, { recursive: true });
  fs.mkdirSync(paths.releases, { recursive: true });
  git(paths.code, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(paths.code, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(paths.code, 'node_modules/dep/index.js'), 'module.exports = 1');
  fs.writeFileSync(path.join(paths.code, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(paths.code, 'app.txt'), 'v1\n');
  fs.mkdirSync(path.join(paths.code, 'boot'));
  fs.writeFileSync(path.join(paths.code, 'boot/boot.mjs'), '// boot v1\n');
  git(paths.code, 'add', '-A');
  git(paths.code, 'commit', '-q', '-m', 'init');
  const clock = fakeClock();
  const store = new StateStore(new EventLog(paths.events, { clock: clock.fn }));
  const restarts: string[] = [];
  const mk = (root = paths.root) => new SelfMod({ paths: { ...paths, root }, store, config: () => DEFAULT_CONFIG, requestRestart: (r) => void restarts.push(r), gate, clock: clock.fn });
  const sm = mk();
  const { sha, dir } = await sm.baseline();
  return { ...e, store, clock, restarts, sm, mk, baseSha: sha, baseDir: dir, write: (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(paths.code, f)), { recursive: true }); fs.writeFileSync(path.join(paths.code, f), c); } };
}

test('baseline exports release #0 with its own node_modules and marks it current and last-known-good', async () => {
  const t = await setup();
  assert.equal(t.sm.currentSha(), t.baseSha);
  assert.equal(t.sm.lkgSha(), t.baseSha);
  assert.ok(fs.existsSync(path.join(t.baseDir, 'app.txt')));
  assert.ok(fs.existsSync(path.join(t.baseDir, 'node_modules/dep/index.js')));
  assert.ok(!fs.lstatSync(path.join(t.baseDir, 'node_modules')).isSymbolicLink(), 'releases are isolated from the working copy');
  assert.equal(t.sm.readPromotion()!.state, 'confirmed');
  assert.equal(t.store.state.selfmod.current, t.baseSha);
});

test('a change that passes the gate is committed, exported, promoted and a restart is requested', async () => {
  const t = await setup();
  t.write('app.txt', 'v2\n');
  const r = await t.sm.propose('improve app');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.risk, 'normal');
  assert.deepEqual(r.files, ['app.txt']);
  assert.notEqual(t.sm.currentSha(), t.baseSha);
  assert.equal(t.sm.currentSha(), r.sha);
  assert.equal(t.sm.lkgSha(), t.baseSha, 'lkg only moves after probation');
  assert.equal(fs.readFileSync(path.join(t.paths.current, 'app.txt'), 'utf8'), 'v2\n');
  assert.equal(fs.readFileSync(path.join(t.baseDir, 'app.txt'), 'utf8'), 'v1\n', 'the old release is untouched');
  assert.equal(t.sm.readPromotion()!.state, 'pending');
  assert.equal(t.restarts.length, 1);
  assert.deepEqual(t.store.state.selfmod.history.map((h) => h.kind).slice(-4), ['propose', 'gate', 'promote']);
});

test('a change that fails the gate is not promoted; the agent gets the failure output', async () => {
  const t = await setup(badGate);
  t.write('app.txt', 'broken\n');
  const r = await t.sm.propose('oops');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /gate failed at "tests"/);
  assert.equal(r.steps[0].tail, 'expected 1 got 2');
  assert.equal(t.sm.currentSha(), t.baseSha);
  assert.equal(t.restarts.length, 0);
  assert.equal(t.store.state.selfmod.history.at(-1)!.kind, 'reject');
});

test('nothing to promote, and a diff containing a secret is refused and unstaged', async () => {
  const t = await setup();
  assert.match((await t.sm.propose('noop')).reason!, /nothing to promote/);
  t.write('config.txt', 'key = sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  const r = await t.sm.propose('add config');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /secret/);
  assert.equal(git(t.paths.code, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
  assert.equal(git(t.paths.code, 'rev-list', '--count', 'HEAD'), '1', 'no commit was made');
});

test('touching protected paths is high-risk and gets the longer probation', async () => {
  assert.equal(isHighRisk(['app.txt']), false);
  assert.equal(isHighRisk(['boot/x.mjs']), true);
  assert.equal(isHighRisk(['agent/CHARTER.md']), true);
  assert.equal(isHighRisk(['src/core/selfmod.ts']), true);
  const t = await setup();
  t.write('boot/boot.mjs', '// boot v2\n');
  const r = await t.sm.propose('touch boot');
  assert.equal(r.risk, 'high');
  const promote = t.store.state.selfmod.history.find((h) => h.kind === 'promote')!;
  assert.equal(promote.risk, 'high');
});

test('probation: starts when the new release boots, confirms after the window, then becomes the new lkg', async () => {
  const t = await setup();
  t.write('app.txt', 'v2\n');
  const r = await t.sm.propose('v2');
  const newDir = fs.realpathSync(t.paths.current);
  const booted = t.mk(newDir); // the restarted daemon runs from the new release
  booted.onStart();
  const p = booted.readPromotion()!;
  assert.equal(p.state, 'probation');
  assert.equal(p.probationUntil, t.clock.now() + DEFAULT_CONFIG.selfmod.probationSec * 1000);
  assert.equal(booted.tickProbation(), undefined);
  t.clock.advance(DEFAULT_CONFIG.selfmod.probationSec * 1000 + 1);
  assert.equal(booted.tickProbation(), 'confirmed');
  assert.equal(booted.lkgSha(), r.sha);
  assert.equal(booted.readPromotion()!.state, 'confirmed');
  assert.equal(t.store.state.selfmod.lkg, r.sha);
});

test('probation: episodes that keep failing after a promotion trigger an automatic rollback', async () => {
  const t = await setup();
  t.write('app.txt', 'v2\n');
  const r = await t.sm.propose('v2');
  const booted = t.mk(fs.realpathSync(t.paths.current));
  booted.onStart();
  for (let i = 0; i < 2; i++) {
    t.clock.advance(1000);
    t.store.append('episode.start', { id: `e${i}`, reason: 'heartbeat' });
    t.store.append('episode.end', { id: `e${i}`, outcome: 'error', costUsd: 0 });
  }
  assert.equal(booted.tickProbation(), 'rolledback');
  assert.equal(booted.currentSha(), t.baseSha);
  assert.deepEqual(t.store.state.selfmod.bad, [r.sha]);
  assert.match(t.store.state.selfmod.history.at(-1)!.reason!, /episodes failed/);
  assert.ok(t.restarts.some((x) => /rollback/.test(x)));
});

test('a rolled-back commit cannot be re-proposed unchanged', async () => {
  const t = await setup();
  t.write('app.txt', 'v2\n');
  await t.sm.propose('v2');
  assert.equal(t.sm.rollback('bad behaviour', 'operator').ok, true);
  const again = await t.sm.propose('v2 again');
  assert.equal(again.ok, false);
  assert.match(again.reason!, /rolled back before/);
  t.write('app.txt', 'v3\n');
  assert.equal((await t.sm.propose('v3')).ok, true);
});

test('manual rollback refuses when already on the last known good release', async () => {
  const t = await setup();
  const r = t.sm.rollback('why not');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /already on the last known good/);
});

test('a rollback performed by the boot supervisor is ingested into the audit log exactly once', async () => {
  const t = await setup();
  const p = t.sm.readPromotion()!;
  fs.writeFileSync(path.join(t.paths.run, 'promotion.json'), JSON.stringify({ ...p, id: 'sm_x', sha: 'deadbeef', prev: t.baseSha, state: 'rolledback', reason: 'crash loop: 3 crashes in 40s', ingested: false }));
  t.sm.onStart();
  t.sm.onStart();
  const rbs = t.store.state.selfmod.history.filter((h) => h.kind === 'rollback');
  assert.equal(rbs.length, 1);
  assert.match(rbs[0].reason!, /crash loop/);
  assert.deepEqual(t.store.state.selfmod.bad, ['deadbeef']);
});

test('prune keeps the current and last-known-good releases', async () => {
  const t = await setup();
  const cfg = { ...DEFAULT_CONFIG, selfmod: { ...DEFAULT_CONFIG.selfmod, keepReleases: 1 } };
  const sm = new SelfMod({ paths: t.paths, store: t.store, config: () => cfg, requestRestart: () => {}, gate: okGate, clock: t.clock.fn });
  for (let i = 2; i <= 4; i++) {
    t.write('app.txt', `v${i}\n`);
    await sm.propose(`v${i}`);
    await new Promise((r) => setTimeout(r, 15));
  }
  const dirs = fs.readdirSync(t.paths.releases).filter((n) => !n.startsWith('.'));
  assert.ok(dirs.includes(path.basename(fs.realpathSync(t.paths.current))));
  assert.ok(dirs.includes(path.basename(fs.realpathSync(t.paths.lkg))));
  assert.ok(dirs.length <= 3, `kept ${dirs.length}`);
});
