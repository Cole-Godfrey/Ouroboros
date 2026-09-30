// strategy runtime: supervised, long-lived programs that keep trading while the
// model sleeps. the agent writes them, this keeps them alive.
//
// strategies are spawned detached (own process group) so they survive daemon
// restarts, including the restarts that self-modification causes. on start-up the
// daemon re-adopts any that are still running.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from '../lib/fsx.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import type { Paths } from '../lib/paths.ts';
import type { StrategySummary } from './briefing.ts';
import type { StateStore } from './state.ts';

export interface StrategySpec {
  name: string;
  /** argv, e.g. ["node", "momentum.ts"] or ["python3", "bot.py"]. */
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** vault secret names injected as environment variables. */
  secrets?: string[];
  restart: 'always' | 'on-failure' | 'never';
  description?: string;
  /** the venue (sub-account) this strategy trades in, so guards and P&L can be attributed. */
  venue?: string;
}

interface Record_ {
  spec: StrategySpec;
  desired: 'running' | 'stopped';
  pid?: number;
  startedAt?: number;
  restarts: number;
  recentExits: number[];
  nextStartAt?: number;
  lastExit?: { code: number | null; signal: string | null; ts: number; abnormal: boolean };
  status: 'running' | 'stopped' | 'backoff' | 'failed';
}

interface Registry {
  strategies: Record<string, Record_>;
}

// strategy names become file names and process labels, so keep them simple
const NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

function alive(pid: number, cmdHint?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (cmdHint) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmdline.includes(cmdHint)) return false; // pid was recycled by something else
    } catch {
      /* no /proc (or not readable): trust kill(0) */
    }
  }
  return true;
}

// keeps the agent's long-running programs alive. they run detached, so they survive daemon restarts
// and are adopted again when the daemon comes back.
export class ProcMan {
  private d: { paths: Paths; store: StateStore; env: (names: string[]) => { env: Record<string, string>; missing: string[] }; log?: Logger; clock?: Clock };
  private log: Logger;
  private clock: Clock;
  private reg: Registry;
  private file: string;
  private children = new Map<string, import('node:child_process').ChildProcess>();

  constructor(deps: ProcMan['d']) {
    this.d = deps;
    this.log = deps.log ?? nullLogger;
    this.clock = deps.clock ?? systemClock;
    ensureDir(deps.paths.strategies);
    this.file = path.join(deps.paths.strategies, 'registry.json');
    this.reg = readJson<Registry>(this.file, { strategies: {} });
  }

  private save(): void {
    writeJson(this.file, this.reg);
  }

  private logFile(name: string): string {
    return path.join(this.d.paths.logs, `strategy-${name}.log`);
  }

  register(spec: StrategySpec): void {
    if (!NAME_RE.test(spec.name)) throw new Error('strategy names are lowercase letters, digits, - and _ (2-41 chars)');
    if (!Array.isArray(spec.cmd) || !spec.cmd.length) throw new Error('cmd must be a non-empty argv array');
    const prev = this.reg.strategies[spec.name];
    this.reg.strategies[spec.name] = { spec, desired: prev?.desired ?? 'stopped', pid: prev?.pid, startedAt: prev?.startedAt, restarts: prev?.restarts ?? 0, recentExits: prev?.recentExits ?? [], status: prev?.status ?? 'stopped' };
    this.save();
    this.d.store.append('strategy.register', { name: spec.name, cmd: spec.cmd, venue: spec.venue, restart: spec.restart });
  }

  remove(name: string): void {
    void this.stop(name, 'remove');
    delete this.reg.strategies[name];
    this.save();
  }

  get(name: string): Record_ | undefined {
    return this.reg.strategies[name];
  }

  list(): StrategySummary[] {
    return Object.values(this.reg.strategies).map((r) => ({
      name: r.spec.name,
      status: r.status,
      pid: r.status === 'running' ? r.pid : undefined,
      restarts: r.restarts,
      startedAt: r.startedAt,
      lastExit: r.lastExit ? `${r.lastExit.code ?? r.lastExit.signal}${r.lastExit.abnormal ? ' (abnormal)' : ''}` : undefined,
    }));
  }

  details(): Array<StrategySummary & { spec: StrategySpec; desired: string }> {
    return Object.values(this.reg.strategies).map((r) => ({ ...this.list().find((s) => s.name === r.spec.name)!, spec: r.spec, desired: r.desired }));
  }

  private rotate(file: string): void {
    try {
      if (fs.statSync(file).size > 20 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch {
      /* no log yet */
    }
  }

  // start a strategy with only the secrets it declared, logging to its own file
  start(name: string): { pid: number } {
    const r = this.reg.strategies[name];
    if (!r) throw new Error(`no such strategy: ${name}`);
    if (r.pid && alive(r.pid, r.spec.cmd[0])) return { pid: r.pid };
    const { env: secretEnv, missing } = this.d.env(r.spec.secrets ?? []);
    if (missing.length) throw new Error(`missing secrets in the vault: ${missing.join(', ')}`);
    ensureDir(this.d.paths.logs);
    const lf = this.logFile(name);
    this.rotate(lf);
    const fd = fs.openSync(lf, 'a');
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
    Object.assign(env, { OURO_HOME: this.d.paths.home, OURO_STRATEGY: name }, r.spec.env ?? {}, secretEnv);
    const child = spawn(r.spec.cmd[0], r.spec.cmd.slice(1), { cwd: r.spec.cwd ?? this.d.paths.workspace, env, detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.unref();
    if (!child.pid) throw new Error(`failed to spawn ${r.spec.cmd[0]}`);
    this.children.set(name, child);
    r.pid = child.pid;
    r.startedAt = this.clock();
    r.desired = 'running';
    r.status = 'running';
    r.nextStartAt = undefined;
    child.on('exit', (code, signal) => this.onExit(name, child.pid!, code, signal));
    child.on('error', (e) => this.log.warn(`strategy ${name} spawn error`, e.message));
    this.save();
    this.d.store.append('strategy.start', { name, pid: child.pid });
    this.log.info(`strategy ${name} started`, { pid: child.pid });
    return { pid: child.pid };
  }

  private onExit(name: string, pid: number, code: number | null, signal: NodeJS.Signals | null): void {
    const r = this.reg.strategies[name];
    if (!r || r.pid !== pid) return;
    this.children.delete(name);
    const wanted = r.desired === 'running';
    const abnormal = wanted && !(code === 0 && r.spec.restart !== 'always');
    this.recordExit(r, code, signal, abnormal);
  }

  private recordExit(r: Record_, code: number | null, signal: string | null, abnormal: boolean): void {
    const now = this.clock();
    r.lastExit = { code, signal, ts: now, abnormal };
    r.pid = undefined;
    r.recentExits = [...r.recentExits.filter((t) => now - t < 3_600_000), now];
    const wantRestart = r.desired === 'running' && (r.spec.restart === 'always' || (r.spec.restart === 'on-failure' && code !== 0));
    if (wantRestart && r.recentExits.length > 10) {
      r.status = 'failed';
      r.desired = 'stopped';
      abnormal = true;
      this.log.warn(`strategy ${r.spec.name} is crash-looping; giving up`);
    } else if (wantRestart) {
      r.status = 'backoff';
      r.restarts++;
      r.nextStartAt = now + Math.min(300_000, 5_000 * 2 ** Math.min(r.recentExits.length - 1, 6));
    } else {
      r.status = 'stopped';
      if (r.desired === 'running') r.desired = 'stopped';
    }
    this.save();
    this.d.store.append('strategy.exit', {
      name: r.spec.name,
      code,
      signal,
      abnormal,
      detail: `${code !== null ? `exit ${code}` : `signal ${signal}`}${r.status === 'failed' ? ', crash-looping, giving up' : r.status === 'backoff' ? ', restarting' : ''}`,
    });
  }

  async stop(name: string, by = 'operator'): Promise<void> {
    const r = this.reg.strategies[name];
    if (!r) return;
    r.desired = 'stopped';
    const pid = r.pid;
    if (pid && alive(pid)) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
      if (alive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    r.pid = undefined;
    r.status = 'stopped';
    r.nextStartAt = undefined;
    this.save();
    this.d.store.append('strategy.stop', { name, by });
  }

  async stopAll(by: string): Promise<void> {
    await Promise.all(Object.keys(this.reg.strategies).map((n) => this.stop(n, by)));
  }

  /** re-attach to strategies still running from before a daemon restart, start any that should be running but are not. */
  // after a daemon restart: keep strategies that are still running, restart the ones that should be
  adoptAll(): void {
    for (const r of Object.values(this.reg.strategies)) {
      if (r.desired !== 'running') continue;
      if (r.pid && alive(r.pid, r.spec.cmd[0])) {
        r.status = 'running';
        this.log.info(`adopted strategy ${r.spec.name}`, { pid: r.pid });
      } else {
        r.pid = undefined;
        try {
          this.start(r.spec.name);
        } catch (e) {
          this.log.warn(`could not restart ${r.spec.name}`, e instanceof Error ? e.message : String(e));
        }
      }
    }
    this.save();
  }

  /** monitor loop: notice adopted processes dying, run scheduled restarts, cap log growth. */
  // monitor loop: notice adopted processes that died, run scheduled restarts, cap log growth
  tick(): void {
    const now = this.clock();
    for (const r of Object.values(this.reg.strategies)) {
      if (r.status === 'running' && r.pid && !this.children.has(r.spec.name) && !alive(r.pid, r.spec.cmd[0])) {
        this.recordExit(r, null, 'unknown', r.desired === 'running');
      }
      if (r.status === 'backoff' && r.nextStartAt && now >= r.nextStartAt) {
        try {
          this.start(r.spec.name);
        } catch (e) {
          this.log.warn(`restart of ${r.spec.name} failed`, e instanceof Error ? e.message : String(e));
          r.nextStartAt = now + 60_000;
        }
      }
      if (r.startedAt && now - r.startedAt > 600_000) r.recentExits = [];
      try {
        const lf = this.logFile(r.spec.name);
        if (fs.statSync(lf).size > 50 * 1024 * 1024) {
          const tail = fs.readFileSync(lf).subarray(-1024 * 1024);
          fs.writeFileSync(lf + '.1', tail);
          fs.truncateSync(lf, 0);
        }
      } catch {
        /* no log */
      }
    }
  }

  logs(name: string, lines = 100): string {
    try {
      const text = fs.readFileSync(this.logFile(name), 'utf8');
      return text.split('\n').slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}
