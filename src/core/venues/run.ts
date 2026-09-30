import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureDir } from '../../lib/fsx.ts';
import type { Paths } from '../../lib/paths.ts';
import { RESULT_MARKER } from '../venue-runner.ts';
import type { RunnerResult } from './types.ts';

/** `builtin/<name>` -> the reference adapters shipped in this release; relative -> $OURO_HOME/venues; absolute as-is. */
export function resolveVenueModule(module: string, paths: Pick<Paths, 'root' | 'home'>): string {
  if (module.startsWith('builtin/')) return path.join(paths.root, 'src', 'core', 'venues', `${module.slice('builtin/'.length)}.ts`);
  if (path.isAbsolute(module)) return module;
  return path.join(paths.home, 'venues', module);
}

const PASS_THROUGH_ENV = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_OPTIONS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
];

export interface RunVenueOptions {
  paths: Pick<Paths, 'root' | 'home' | 'data'>;
  module: string;
  method: 'snapshot' | 'flows' | 'describe';
  args?: unknown;
  /** Secrets to inject (already resolved from the vault). */
  secrets?: Record<string, string>;
  venueId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: number;
}

export function runVenueMethod<T = unknown>(opts: RunVenueOptions): Promise<RunnerResult<T>> {
  const started = Date.now();
  const modulePath = resolveVenueModule(opts.module, opts.paths);
  const dataDir = path.join(opts.paths.data, 'venues', opts.venueId ?? path.basename(modulePath).replace(/\.[^.]+$/, ''));
  ensureDir(dataDir);
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  env.OURO_HOME = opts.paths.home;
  Object.assign(env, opts.secrets ?? {});
  env.OURO_VENUE_INPUT = JSON.stringify({ args: opts.args, now: opts.now ?? Date.now(), dataDir });
  const runner = path.join(opts.paths.root, 'src', 'core', 'venue-runner.ts');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOut = opts.maxOutputBytes ?? 2 * 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, modulePath, opts.method], {
      env,
      cwd: path.dirname(modulePath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: RunnerResult<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `timed out after ${timeoutMs}ms`, durationMs: Date.now() - started });
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (out.length < maxOut) out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 64 * 1024) err += c.toString('utf8');
    });
    child.on('error', (e) => finish({ ok: false, error: `spawn failed: ${e.message}`, durationMs: Date.now() - started }));
    child.on('close', (code) => {
      const idx = out.lastIndexOf(RESULT_MARKER);
      if (idx === -1) {
        finish({ ok: false, error: `no result (exit ${code}): ${(err || out).trim().slice(-400)}`, durationMs: Date.now() - started });
        return;
      }
      try {
        const payload = JSON.parse(out.slice(idx + RESULT_MARKER.length).split('\n')[0]) as { ok: boolean; result?: T; error?: string };
        finish({ ...payload, durationMs: Date.now() - started });
      } catch {
        finish({ ok: false, error: 'unparseable venue output', durationMs: Date.now() - started });
      }
    });
  });
}
