// self-modification pipeline: "freedom with recovery".
//
// the agent edits a normal git working copy of this repository (paths.code).
// the system never runs that working copy. it runs immutable, exported releases:
//
//   propose  ->  commit  ->  export release  ->  GATE (typecheck, tests, smoke boot, charter)
//            ->  promote (atomic symlink swap of `current`)  ->  restart when idle
//            ->  PROBATION (crash-loop detector in the boot supervisor + episode health)
//            ->  confirm (becomes `lkg`, the last known good)   or   auto-rollback to `lkg`.
//
// a change that fails the gate is never promoted and the agent gets the failure
// output to fix it. A change that passes the gate but misbehaves in production is
// rolled back automatically and remembered, so it is not retried blindly.
// nothing here is a wall: it is a seat belt.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, rmrf, writeJson, fileExists } from '../lib/fsx.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import type { OuroConfig } from '../lib/config.ts';
import { newId } from '../lib/ids.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import { globalRedactor } from '../lib/redact.ts';
import type { Paths } from '../lib/paths.ts';
import { charterSha, readSeal } from './charter.ts';
import type { StateStore } from './state.ts';

/** changes to these paths get the long probation window and are flagged high-risk. */
// the parts of the harness that keep the other guarantees checkable. changes here are high risk.
export const PROTECTED_PATHS = ['agent/CHARTER.md', 'boot/', 'src/selftest/', 'src/core/selfmod.ts', 'src/core/charter.ts', 'src/core/eventlog.ts', 'src/core/vault.ts', 'src/core/reconciler.ts', 'src/core/state.ts', 'vm/'];

export interface GateStep {
  name: string;
  ok: boolean;
  ms: number;
  tail: string;
}

export interface ProposeResult {
  ok: boolean;
  id: string;
  sha?: string;
  risk?: 'normal' | 'high';
  files?: string[];
  steps: GateStep[];
  reason?: string;
  restartScheduled?: boolean;
}

export interface Promotion {
  id: string;
  sha: string;
  prev?: string;
  promotedAt: number;
  state: 'pending' | 'probation' | 'confirmed' | 'rolledback';
  probationUntil?: number;
  startedAt?: number;
  risk: 'normal' | 'high';
  message?: string;
  reason?: string;
  ingested?: boolean;
}

export interface SelfModDeps {
  paths: Paths;
  store: StateStore;
  config: () => OuroConfig;
  /** ask the daemon to restart itself into `current` when it next goes idle. */
  requestRestart: (reason: string) => void;
  /** test seam: replace the gate. */
  gate?: (dir: string, ctx: { sha: string; files: string[] }) => Promise<GateStep[]>;
  log?: Logger;
  clock?: Clock;
}

const SHORT = 12;

// a path ending in a slash protects a whole directory, anything else is an exact file
export function isHighRisk(files: string[]): boolean {
  return files.some((f) => PROTECTED_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

interface ExecResult {
  code: number | null;
  out: string;
  timedOut: boolean;
  ms: number;
}

// run a command with a hard timeout and kill its whole process group, so a hung gate step cannot linger
function exec(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ExecResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = (c: Buffer) => {
      out += c.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut, ms: Date.now() - t0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: String(e), timedOut: false, ms: Date.now() - t0 });
    });
  });
}

const tail = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

// the self-modification pipeline: commit the agent's change, gate it, promote it as an immutable release,
// watch it during probation and roll back automatically if it misbehaves.
export class SelfMod {
  private d: SelfModDeps;
  private log: Logger;
  private clock: Clock;
  private busy = false;

  constructor(deps: SelfModDeps) {
    this.d = deps;
    this.log = deps.log ?? nullLogger;
    this.clock = deps.clock ?? systemClock;
  }

  // ------------------------------------------------------------ git helpers

  private git(args: string[], opts: { timeoutMs?: number } = {}): string {
    return execFileSync('git', ['-c', 'user.name=Ouroboros', '-c', 'user.email=ouroboros@localhost', '-c', 'commit.gpgsign=false', ...args], {
      cwd: this.d.paths.code,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  private get promotionFile(): string {
    return path.join(this.d.paths.run, 'promotion.json');
  }

  readPromotion(): Promotion | undefined {
    return readJson<Promotion | undefined>(this.promotionFile, undefined);
  }

  private writePromotion(p: Promotion): void {
    writeJson(this.promotionFile, p);
  }

  private releaseDir(sha: string): string {
    return path.join(this.d.paths.releases, sha.slice(0, SHORT));
  }

  private readRelease(dir: string): { sha: string } | undefined {
    return readJson<{ sha: string } | undefined>(path.join(dir, '.ouro-release.json'), undefined);
  }

  private linkTarget(link: string): string | undefined {
    try {
      return fs.realpathSync(link);
    } catch {
      return undefined;
    }
  }

  currentSha(): string | undefined {
    const t = this.linkTarget(this.d.paths.current);
    return t ? this.readRelease(t)?.sha : undefined;
  }

  lkgSha(): string | undefined {
    const t = this.linkTarget(this.d.paths.lkg);
    return t ? this.readRelease(t)?.sha : undefined;
  }

  /** the release this very process was started from. */
  runningSha(): string | undefined {
    return this.readRelease(this.d.paths.root)?.sha;
  }

  // replace a symlink atomically (write a temporary one, then rename over the old).
  // the supervisor may read the link at any moment and must never see it missing.
  private swapLink(link: string, target: string): void {
    const tmp = `${link}.${process.pid}.tmp`;
    rmrf(tmp);
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link);
  }

  // -------------------------------------------------------------- releases

  /** export a commit as an immutable release directory (with its own node_modules). */
  // turn a commit into an immutable release directory. node_modules is copied from the running release
  // unless the lockfile changed, in which case it is installed fresh.
  async exportRelease(sha: string, npmCi: boolean): Promise<string> {
    const dir = this.releaseDir(sha);
    if (fileExists(path.join(dir, '.ouro-release.json'))) return dir;
    ensureDir(this.d.paths.releases);
    const tmp = path.join(this.d.paths.releases, `.tmp-${sha.slice(0, SHORT)}-${process.pid}`);
    rmrf(tmp);
    ensureDir(tmp);
    try {
      execFileSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', sha, tmp], { cwd: this.d.paths.code, stdio: 'pipe', timeout: 120_000 });
      const baseModules = [this.d.paths.current, this.d.paths.code].map((b) => path.join(b, 'node_modules')).find((p) => fileExists(p));
      if (npmCi || !baseModules) {
        const r = await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tmp, timeoutMs: 15 * 60_000 });
        if (r.code !== 0) throw new Error(`npm ci failed: ${tail(r.out, 1500)}`);
      } else {
        // node's copy supports both macOS and Linux and preserves relative package-bin links.
        fs.cpSync(fs.realpathSync(baseModules), path.join(tmp, 'node_modules'), {
          recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
        });
      }
      writeJson(path.join(tmp, '.ouro-release.json'), { sha, exportedAt: this.clock() });
      fs.renameSync(tmp, dir);
      return dir;
    } catch (e) {
      rmrf(tmp);
      throw e;
    }
  }

  /** first install: turn the current HEAD of the working copy into release #0 and mark it good. */
  // first install: the current working copy becomes release zero and is marked good
  async baseline(): Promise<{ sha: string; dir: string }> {
    if (!fileExists(path.join(this.d.paths.code, '.git'))) throw new Error(`${this.d.paths.code} is not a git repository`);
    const dirty = this.git(['status', '--porcelain']);
    if (dirty) {
      this.git(['add', '-A']);
      this.git(['commit', '-m', 'baseline: local changes at install time']);
    }
    const sha = this.git(['rev-parse', 'HEAD']);
    const dir = await this.exportRelease(sha, false);
    this.swapLink(this.d.paths.current, dir);
    this.swapLink(this.d.paths.lkg, dir);
    this.writePromotion({ id: 'baseline', sha, promotedAt: this.clock(), state: 'confirmed', risk: 'normal', ingested: true });
    this.d.store.append('selfmod.baseline', { sha });
    this.git(['branch', '-f', 'live', sha]);
    this.git(['branch', '-f', 'lkg', sha]);
    return { sha, dir };
  }

  status(): {
    current?: string;
    lkg?: string;
    running?: string;
    promotion?: Promotion;
    workingCopy: { head?: string; dirty: boolean; changedFiles: string[]; ahead: number };
    busy: boolean;
  } {
    const current = this.currentSha();
    let head: string | undefined;
    let dirty = false;
    let changed: string[] = [];
    let ahead = 0;
    try {
      head = this.git(['rev-parse', 'HEAD']);
      dirty = this.git(['status', '--porcelain']).length > 0;
      if (current) {
        changed = this.git(['diff', '--name-only', current]).split('\n').filter(Boolean);
        for (const f of this.git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) changed.push(f);
        ahead = Number(this.git(['rev-list', '--count', `${current}..HEAD`]) || 0);
      }
    } catch {
      /* not a git repo yet */
    }
    return { current, lkg: this.lkgSha(), running: this.runningSha(), promotion: this.readPromotion(), workingCopy: { head, dirty, changedFiles: changed, ahead }, busy: this.busy };
  }

  // --------------------------------------------------------------- the gate

  // the gate runs in a scratch home against the exported release, never against live state.
  // order matters: cheap checks first, and the first failure stops the rest.
  private async defaultGate(dir: string, ctx: { sha: string; files: string[] }): Promise<GateStep[]> {
    const cfg = this.d.config();
    const timeoutMs = cfg.selfmod.gateTimeoutSec * 1000;
    const steps: GateStep[] = [];
    const sandboxHome = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : process.cwd(), 'ouro-gate-'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: sandboxHome, LANG: process.env.LANG, TZ: process.env.TZ, OURO_HOME: path.join(sandboxHome, 'home'), OURO_CODE: path.join(sandboxHome, 'code'), OURO_ETC: path.join(sandboxHome, 'etc'), OURO_GATE: '1' };
    for (const k of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) env[k] = process.env[k];
    const run = async (name: string, cmd: string, args: string[]): Promise<boolean> => {
      const r = await exec(cmd, args, { cwd: dir, env, timeoutMs });
      const ok = r.code === 0 && !r.timedOut;
      steps.push({ name, ok, ms: r.ms, tail: r.timedOut ? `timed out after ${timeoutMs}ms\n${tail(r.out, 2000)}` : tail(r.out) });
      return ok;
    };
    try {
      const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
      if (fileExists(tsc)) {
        if (!(await run('typecheck', process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json']))) return steps;
      } else steps.push({ name: 'typecheck', ok: false, ms: 0, tail: 'typescript is not installed in the release (npm ci --include=dev)' });
      if (steps.at(-1)!.ok === false) return steps;
      if (!(await run('tests', process.execPath, ['--test', '--test-concurrency=4', 'test/**/*.test.ts']))) return steps;
      if (fileExists(path.join(dir, 'src', 'selftest', 'smoke.ts'))) {
        if (!(await run('smoke-boot', process.execPath, ['src/selftest/smoke.ts']))) return steps;
      } else steps.push({ name: 'smoke-boot', ok: false, ms: 0, tail: 'src/selftest/smoke.ts is missing' });
      if (steps.at(-1)!.ok === false) return steps;
      // the candidate charter must match the operator's seal, so no change can quietly rewrite the rules
      const cand = charterSha(dir);
      const sealed = readSeal(this.d.paths);
      const ok = !!cand && (!sealed || sealed === cand);
      steps.push({ name: 'charter', ok, ms: 0, tail: ok ? 'charter unchanged' : `charter differs from the operator's seal (${cand?.slice(0, 12)} vs ${sealed?.slice(0, 12)}); only the operator can change it` });
    } finally {
      rmrf(sandboxHome);
    }
    void ctx;
    return steps;
  }

  // ---------------------------------------------------------------- propose

  // only one proposal at a time. every outcome is written to the audit log.
  async propose(message: string, by = 'agent'): Promise<ProposeResult> {
    const id = newId('sm');
    if (this.busy) return { ok: false, id, steps: [], reason: 'another proposal is being processed' };
    this.busy = true;
    try {
      return await this.proposeInner(id, message, by);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error('selfmod propose failed', e);
      this.d.store.append('selfmod.reject', { id, message, reason });
      return { ok: false, id, steps: [], reason };
    } finally {
      this.busy = false;
    }
  }

  // 1. commit the working tree (refusing anything that looks like a secret)
  // 2. export a release and run the gate
  // 3. promote by repointing current, then ask the daemon to restart when idle
  private async proposeInner(id: string, message: string, by: string): Promise<ProposeResult> {
    const { store } = this.d;
    const current = this.currentSha();
    if (!current) return { ok: false, id, steps: [], reason: 'no baseline release yet (run `ouro selfmod baseline`)' };

    // 1. commit whatever is in the working tree (refusing anything that looks like a secret)
    if (this.git(['status', '--porcelain'])) {
      this.git(['add', '-A']);
      const diff = this.git(['diff', '--cached']);
      if (globalRedactor.redact(diff) !== diff) {
        this.git(['reset']);
        return { ok: false, id, steps: [], reason: 'the diff contains something that looks like a secret or key; remove it (secrets belong in the vault) and try again' };
      }
      this.git(['commit', '-m', `${message.slice(0, 200)}\n\nProposed by ${by} (${id}).`]);
    }
    const sha = this.git(['rev-parse', 'HEAD']);
    if (sha === current) return { ok: false, id, sha, steps: [], reason: 'nothing to promote: the working copy matches the running release' };
    if (store.state.selfmod.bad.includes(sha)) return { ok: false, id, sha, steps: [], reason: 'this exact commit was rolled back before; change something first' };

    const files = this.git(['diff', '--name-only', `${current}..${sha}`]).split('\n').filter(Boolean);
    const risk: 'normal' | 'high' = isHighRisk(files) ? 'high' : 'normal';
    store.append('selfmod.propose', { id, sha, prev: current, message, risk, files: files.slice(0, 200) });

    // 2. export + gate
    const lockChanged = files.includes('package-lock.json') || files.includes('package.json');
    let dir: string;
    try {
      dir = await this.exportRelease(sha, lockChanged);
    } catch (e) {
      const reason = `could not build the release: ${e instanceof Error ? e.message : String(e)}`;
      store.append('selfmod.reject', { id, sha, reason });
      return { ok: false, id, sha, risk, files, steps: [], reason };
    }
    const steps = await (this.d.gate ?? ((d, c) => this.defaultGate(d, c)))(dir, { sha, files });
    const ok = steps.length > 0 && steps.every((s) => s.ok);
    store.append('selfmod.gate', { id, sha, ok, risk, message: steps.map((s) => `${s.name}:${s.ok ? 'ok' : 'FAIL'}`).join(' ') });
    if (!ok) {
      const failed = steps.find((s) => !s.ok);
      const reason = `gate failed at "${failed?.name}"`;
      store.append('selfmod.reject', { id, sha, reason });
      return { ok: false, id, sha, risk, files, steps, reason };
    }

    // 3. promote
    this.swapLink(this.d.paths.current, dir);
    const cfg = this.d.config();
    const now = this.clock();
    const probationSec = risk === 'high' ? cfg.selfmod.highRiskProbationSec : cfg.selfmod.probationSec;
    this.writePromotion({ id, sha, prev: this.lkgSha() ?? current, promotedAt: now, state: 'pending', probationUntil: undefined, risk, message, ingested: true });
    store.append('selfmod.promote', { id, sha, prev: current, risk, message, probationUntil: now + probationSec * 1000 });
    try {
      this.git(['branch', '-f', 'live', sha]);
    } catch {
      /* cosmetic */
    }
    this.prune();
    this.d.requestRestart(`promoted ${sha.slice(0, 10)}`);
    return { ok: true, id, sha, risk, files, steps, restartScheduled: true };
  }

  // ------------------------------------------------------ probation/rollback

  /** called once at daemon start-up. ingests supervisor-made rollbacks and starts probation for a fresh promotion. */
  // runs once at daemon start-up: record a rollback the supervisor made while we were down,
  // or begin the probation window for a release that has just booted
  onStart(): void {
    const now = this.clock();
    const p = this.readPromotion();
    if (!p) return;
    const running = this.runningSha();
    if (p.state === 'rolledback' && !p.ingested) {
      this.d.store.append('selfmod.rollback', { id: p.id, from: p.sha, to: p.prev, reason: p.reason ?? 'crash loop during probation' });
      this.writePromotion({ ...p, ingested: true });
      return;
    }
    if (p.state === 'pending' && running && running === p.sha) {
      const cfg = this.d.config();
      const secs = p.risk === 'high' ? cfg.selfmod.highRiskProbationSec : cfg.selfmod.probationSec;
      this.writePromotion({ ...p, state: 'probation', startedAt: now, probationUntil: now + secs * 1000 });
      this.log.info(`release ${p.sha.slice(0, 10)} is on probation for ${secs}s`);
    }
  }

  /** periodic check: confirm a release that has behaved, or roll back one whose episodes keep failing. */
  // probation passes when the time is up, and fails early when episodes keep failing with no success
  tickProbation(): 'confirmed' | 'rolledback' | undefined {
    const p = this.readPromotion();
    if (!p || p.state !== 'probation' || !p.probationUntil || !p.startedAt) return undefined;
    const now = this.clock();
    const eps = this.d.store.state.episodes.filter((e) => e.startedAt >= p.startedAt!);
    const failed = eps.filter((e) => ['error', 'stalled', 'timeout'].includes(e.outcome ?? '')).length;
    const done = eps.filter((e) => e.outcome === 'completed').length;
    if (failed >= 2 && done === 0) {
      this.rollback(`${failed} episodes failed after the promotion and none succeeded`, 'system');
      return 'rolledback';
    }
    if (now >= p.probationUntil) {
      const dir = this.releaseDir(p.sha);
      this.swapLink(this.d.paths.lkg, dir);
      this.writePromotion({ ...p, state: 'confirmed' });
      this.d.store.append('selfmod.confirm', { id: p.id, sha: p.sha });
      try {
        this.git(['branch', '-f', 'lkg', p.sha]);
      } catch {
        /* cosmetic */
      }
      return 'confirmed';
    }
    return undefined;
  }

  /** point `current` back at the last known good release and restart into it. */
  // point current back at the last known good release and restart into it
  rollback(reason: string, by = 'operator'): { ok: boolean; from?: string; to?: string; reason?: string } {
    const lkg = this.lkgSha();
    const cur = this.currentSha();
    if (!lkg) return { ok: false, reason: 'no last-known-good release recorded' };
    if (cur === lkg) return { ok: false, reason: 'already on the last known good release' };
    this.swapLink(this.d.paths.current, this.releaseDir(lkg));
    const p = this.readPromotion();
    const id = p?.id ?? newId('sm');
    this.writePromotion({ ...(p ?? { id, sha: cur ?? '', promotedAt: this.clock(), risk: 'normal' as const }), sha: cur ?? p?.sha ?? '', prev: lkg, state: 'rolledback', reason: `${reason} (by ${by})`, ingested: true });
    this.d.store.append('selfmod.rollback', { id, from: cur, to: lkg, reason: `${reason} (by ${by})` });
    this.d.requestRestart(`rollback to ${lkg.slice(0, 10)}`);
    return { ok: true, from: cur, to: lkg };
  }

  /** keep `current`, `lkg` and the newest few releases, delete the rest. */
  // keep the running release, the last known good one and the newest few. delete the rest.
  prune(): void {
    try {
      const keep = this.d.config().selfmod.keepReleases;
      // macOS aliases /var to /private/var. compare canonical paths before deleting any release.
      const protectedDirs = new Set([this.linkTarget(this.d.paths.current), this.linkTarget(this.d.paths.lkg), fs.realpathSync(this.d.paths.root)].filter(Boolean) as string[]);
      const dirs = fs
        .readdirSync(this.d.paths.releases)
        .filter((n) => !n.startsWith('.'))
        .map((n) => path.join(this.d.paths.releases, n))
        .filter((p) => fileExists(path.join(p, '.ouro-release.json')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const d of dirs.slice(keep)) if (!protectedDirs.has(fs.realpathSync(d))) rmrf(d);
    } catch {
      /* best effort */
    }
  }

  history(n = 20) {
    return this.d.store.state.selfmod.history.slice(-n);
  }
}
