import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sleepSync } from './clock.ts';

export function ensureDir(dir: string, mode = 0o755): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/** Write via temp file + fsync + rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    if (typeof data === 'string') fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return fallback;
    throw e;
  }
}

export function writeJson(file: string, value: unknown, mode = 0o644): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Cross-process mutex built on mkdir (atomic on every POSIX filesystem).
 * A lock older than staleMs is presumed abandoned and stolen.
 */
export function withLockSync<T>(lockDir: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const start = Date.now();
  ensureDir(path.dirname(lockDir));
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // vanished between mkdir and stat: retry immediately
      }
      if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${lockDir}`);
      sleepSync(3 + Math.floor(Math.random() * 12));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function appendLineSync(file: string, line: string): void {
  const fd = fs.openSync(file, 'a', 0o644);
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Last complete (newline-terminated) line of a file, or undefined. Reads from the end. */
export function readLastLine(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return undefined;
    let chunk = 8192;
    for (;;) {
      const len = Math.min(chunk, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      // drop the trailing newline, then find the previous one
      if (text.endsWith('\n')) text = text.slice(0, -1);
      const idx = text.lastIndexOf('\n');
      if (idx !== -1) return text.slice(idx + 1);
      if (len === size) return text.length ? text : undefined;
      chunk *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** If the file does not end with a newline (crash mid-append), truncate to the last newline. */
export function repairTail(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    // scan backwards for the last newline
    let pos = size;
    const step = 4096;
    let cut = 0;
    while (pos > 0) {
      const len = Math.min(step, pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos - len);
      const i = buf.lastIndexOf(0x0a);
      if (i !== -1) {
        cut = pos - len + i + 1;
        break;
      }
      pos -= len;
    }
    fs.ftruncateSync(fd, cut);
    fs.fsyncSync(fd);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
}

/** rm -rf that never throws. */
export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
