#!/usr/bin/env node
// ouro-boot: the last-resort supervisor. Plain JavaScript, zero dependencies.
//
// It is the only part of Ouroboros that is installed OUTSIDE the release tree
// (/opt/ouroboros/boot/), and it stays deliberately small because it is what
// rescues the system when everything else is broken:
//
//   * runs the daemon from the `current` release, and restarts it if it dies,
//   * restarts it immediately (no penalty) when it exits with code 75 (= "restart
//     me into `current`", used after a self-modification is promoted),
//   * kills it if its heartbeat file goes stale (hung process),
//   * during a promotion's probation, if the new release crash-loops or never
//     becomes healthy, points `current` back at the last known good release,
//     records the rollback in run/promotion.json, and boots that instead.
//
// The audit log is not touched here (that would duplicate hash-chain logic in the
// one file that must never break): the restarted daemon ingests promotion.json
// and writes the rollback event itself.
//
// Exit codes of this process: 0 = stopped cleanly on request; anything else =
// something is badly wrong and systemd should look at it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_RESTART = 75;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function swapLink(link, target) {
  const tmp = `${link}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

export class Supervisor {
  constructor(opts = {}) {
    this.home = opts.home ?? process.env.OURO_HOME ?? path.join(os.homedir(), '.ouroboros');
    this.spawnFn = opts.spawn ?? spawn;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(`${new Date().toISOString()} [ouro-boot] ${m}`));
    this.graceMs = opts.graceMs ?? 120_000;
    this.staleMs = opts.staleMs ?? 90_000;
    this.tickMs = opts.tickMs ?? 2_000;
    this.crashWindowMs = opts.crashWindowMs ?? 10 * 60_000;
    this.rollbackCrashes = opts.rollbackCrashes ?? 3;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5 * 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.buildCommand =
      opts.buildCommand ??
      ((dir) => ({
        cmd: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', path.join(dir, 'src', 'core', 'daemon.ts')],
      }));
    this.env = opts.env ?? process.env;
    this.crashes = [];
    this.stopping = false;
    this.child = undefined;
    this.paths = {
      run: path.join(this.home, 'run'),
      current: path.join(this.home, 'current'),
      lkg: path.join(this.home, 'lkg'),
      heartbeat: path.join(this.home, 'run', 'heartbeat.json'),
      promotion: path.join(this.home, 'run', 'promotion.json'),
      bootState: path.join(this.home, 'run', 'boot.json'),
      logs: path.join(this.home, 'logs'),
    };
    fs.mkdirSync(this.paths.run, { recursive: true });
    fs.mkdirSync(this.paths.logs, { recursive: true });
  }

  resolveRelease(link) {
    try {
      const dir = fs.realpathSync(link);
      const meta = readJson(path.join(dir, '.ouro-release.json'), undefined);
      return { dir, sha: meta?.sha ?? path.basename(dir) };
    } catch {
      return undefined;
    }
  }

  stop() {
    this.stopping = true;
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
  }

  /** Start one daemon and resolve when it is gone. */
  runOnce(rel) {
    return new Promise((resolve) => {
      const { cmd, args } = this.buildCommand(rel.dir);
      const started = this.now();
      const out = fs.openSync(path.join(this.paths.logs, 'daemon.out.log'), 'a');
      const child = this.spawnFn(cmd, args, {
        cwd: rel.dir,
        env: { ...this.env, OURO_HOME: this.home, OURO_RELEASE: rel.dir },
        stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      this.child = child;
      writeJsonAtomic(this.paths.bootState, { pid: process.pid, child: child.pid, sha: rel.sha, startedAt: started });
      this.log(`started daemon pid ${child.pid} from release ${rel.sha.slice(0, 10)}`);
      let reason;
      const timer = setInterval(() => {
        const hb = readJson(this.paths.heartbeat, undefined);
        const fresh = hb && hb.pid === child.pid && this.now() - hb.ts < this.staleMs;
        if (!fresh && this.now() - started > this.graceMs && !reason) {
          reason = hb && hb.pid === child.pid ? 'heartbeat went stale' : 'never became healthy';
          this.log(`daemon is unhealthy (${reason}); killing it`);
          child.kill('SIGKILL');
        }
      }, this.tickMs);
      child.on('error', (e) => {
        reason ??= `spawn error: ${e.message}`;
      });
      child.on('exit', (code, signal) => {
        clearInterval(timer);
        this.child = undefined;
        resolve({ code, signal, reason, startedAt: started, uptimeMs: this.now() - started });
      });
    });
  }

  /** During probation, a crash loop or failure to become healthy sends us back to the last known good release. */
  maybeRollback(rel, result) {
    const p = readJson(this.paths.promotion, undefined);
    if (!p || !['pending', 'probation'].includes(p.state) || p.sha !== rel.sha) return false;
    const recent = this.crashes.filter((t) => this.now() - t < this.crashWindowMs);
    const neverHealthy = result.reason === 'never became healthy';
    if (recent.length < this.rollbackCrashes && !neverHealthy) return false;
    const lkg = this.resolveRelease(this.paths.lkg);
    if (!lkg || lkg.dir === rel.dir) {
      this.log('crash loop on a release with no last-known-good to fall back to');
      return false;
    }
    swapLink(this.paths.current, lkg.dir);
    const reason = neverHealthy ? `release never became healthy (${result.reason})` : `crash loop: ${recent.length} crashes within ${Math.round(this.crashWindowMs / 60000)} minutes of promotion`;
    writeJsonAtomic(this.paths.promotion, { ...p, state: 'rolledback', reason, prev: lkg.sha, ingested: false, rolledBackAt: this.now() });
    this.log(`ROLLBACK: ${rel.sha.slice(0, 10)} -> ${lkg.sha.slice(0, 10)} (${reason})`);
    this.crashes = [];
    return true;
  }

  async run() {
    let consecutive = 0;
    while (!this.stopping) {
      const rel = this.resolveRelease(this.paths.current);
      if (!rel) {
        this.log('no `current` release; waiting for the installer');
        await this.sleep(5_000);
        continue;
      }
      const result = await this.runOnce(rel);
      if (this.stopping) return 0;
      if (result.code === 0) {
        this.log('daemon exited cleanly; stopping');
        return 0;
      }
      if (result.code === EXIT_RESTART) {
        this.log('daemon asked for a restart into `current`');
        consecutive = 0;
        continue;
      }
      this.crashes.push(this.now());
      this.log(`daemon died (code ${result.code}, signal ${result.signal}${result.reason ? `, ${result.reason}` : ''}) after ${Math.round(result.uptimeMs / 1000)}s`);
      if (result.uptimeMs > 5 * 60_000) consecutive = 0;
      if (this.maybeRollback(rel, result)) {
        consecutive = 0;
        continue;
      }
      consecutive++;
      await this.sleep(Math.min(this.backoffMaxMs, 1_000 * 2 ** Math.min(consecutive, 9)));
    }
    return 0;
  }
}

// ------------------------------------------------------------------- CLI

async function main() {
  const sup = new Supervisor();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => sup.stop());
  const code = await sup.run();
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
