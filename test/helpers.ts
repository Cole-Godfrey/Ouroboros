// shared test helpers: temp directories, a fake clock and isolated environments

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { resolvePaths, type Paths } from '../src/lib/paths.ts';

const made = new Set<string>();
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** a fresh temp directory, removed when the test process exits. */
export function tmpDir(prefix = 'ouro-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  return d;
}

export interface Clock {
  now(): number;
  fn: () => number;
  advance(ms: number): void;
  set(ts: number): void;
}

export function fakeClock(start = Date.UTC(2026, 0, 1, 12, 0, 0)): Clock {
  let t = start;
  const c: Clock = {
    now: () => t,
    fn: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ts) => {
      t = ts;
    },
  };
  return c;
}

// a complete isolated environment with every path under one temp dir
export function tmpEnv(): { dir: string; paths: Paths; env: NodeJS.ProcessEnv } {
  const dir = tmpDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OURO_HOME: path.join(dir, 'home'),
    OURO_CODE: path.join(dir, 'code'),
    OURO_ETC: path.join(dir, 'etc'),
  };
  const paths = resolvePaths(env);
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.run, { recursive: true });
  return { dir, paths, env };
}

export function makeStore(clock = fakeClock()): { store: StateStore; clock: Clock; dir: string; file: string } {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  const log = new EventLog(file, { clock: clock.fn });
  return { store: new StateStore(log), clock, dir, file };
}

// config overrides for tests that exercise paid-model metering (the shipped default is a free model)
export const PAID_LLM = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', cheapModel: 'claude-haiku-4-5' },
  budget: { mode: 'sponsor' as const },
};
