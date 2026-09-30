import fs from 'node:fs';
import path from 'node:path';
import { globalRedactor } from './redact.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  file?: string;
  level?: Level;
  stderr?: boolean;
  maxBytes?: number;
}

export function createLogger(scope: string, opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.OURO_LOG_LEVEL as Level) || 'info');
  const stderr = opts.stderr ?? true;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  let dirReady = false;

  function write(lvl: Level, msg: string, data?: unknown) {
    if (ORDER[lvl] < ORDER[level]) return;
    const ts = new Date().toISOString();
    let extra = '';
    if (data !== undefined) {
      try {
        extra = ' ' + (data instanceof Error ? `${data.name}: ${data.message}` : JSON.stringify(data));
      } catch {
        extra = ' [unserialisable]';
      }
    }
    const line = globalRedactor.redact(`${ts} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}`);
    if (stderr) process.stderr.write(line + '\n');
    if (opts.file) {
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(opts.file), { recursive: true });
          dirReady = true;
        }
        try {
          if (fs.statSync(opts.file).size > maxBytes) fs.renameSync(opts.file, opts.file + '.1');
        } catch {
          /* no file yet */
        }
        fs.appendFileSync(opts.file, line + '\n');
      } catch {
        /* logging must never throw */
      }
    }
  }

  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (s) => createLogger(`${scope}/${s}`, opts),
  };
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
