// append-only, hash-chained JSONL event log. this is the audit trail and the
// single source of truth for money, decisions and system events.
//
// every line commits to the hash of the previous line, so silent edits or
// deletions are detectable (`verify()`), by the operator and by the agent itself.
// writers from different processes serialise on a mkdir lock.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendLineSync, ensureDir, readLastLine, repairTail, withLockSync } from '../lib/fsx.ts';
import { systemClock, type Clock } from '../lib/clock.ts';

export interface LogEvent<T = any> {
  seq: number;
  ts: number;
  type: string;
  data: T;
  prev: string;
  hash: string;
}

export const GENESIS_PREV = '0'.repeat(64);

// each event's hash covers the previous hash, so editing or deleting any line breaks every hash after it
export function hashEvent(prev: string, seq: number, ts: number, type: string, data: unknown): string {
  return createHash('sha256')
    .update(prev + '\n' + JSON.stringify({ seq, ts, type, data }))
    .digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  headSeq: number;
  headHash: string;
  error?: { seq: number; reason: string };
}

export class EventLog {
  readonly file: string;
  private lockDir: string;
  private clock: Clock;

  constructor(file: string, opts: { clock?: Clock; lockDir?: string } = {}) {
    this.file = file;
    this.clock = opts.clock ?? systemClock;
    this.lockDir = opts.lockDir ?? `${file}.lock`;
    ensureDir(path.dirname(file));
  }

  // append under a directory lock so several processes can write safely.
  // a crash can leave a half-written last line, which is trimmed before the next append.
  append<T>(type: string, data: T, opts: { ts?: number } = {}): LogEvent<T> {
    return withLockSync(this.lockDir, () => {
      repairTail(this.file);
      const lastLine = readLastLine(this.file);
      let seq = 1;
      let prev = GENESIS_PREV;
      if (lastLine) {
        const last = JSON.parse(lastLine) as LogEvent;
        seq = last.seq + 1;
        prev = last.hash;
      }
      const ts = opts.ts ?? this.clock();
      // round-trip the payload once so the hash covers exactly what a reader will see.
      // round-trip the payload once so the hash covers exactly what a reader will see
      const clean = JSON.parse(JSON.stringify(data === undefined ? null : data)) as T;
      const hash = hashEvent(prev, seq, ts, type, clean);
      const ev: LogEvent<T> = { seq, ts, type, data: clean, prev, hash };
      appendLineSync(this.file, JSON.stringify(ev));
      return ev;
    });
  }

  /** read every event. A partial trailing line (crash mid-write) is ignored. */
  readAll(): LogEvent[] {
    return this.readFrom(0).events;
  }

  /** read complete lines starting at a byte offset. returns the offset just after the last complete line. */
  readFrom(offset: number): { events: LogEvent[]; offset: number } {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { events: [], offset: 0 };
      throw e;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return { events: [], offset: Math.min(offset, size) };
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) return { events: [], offset };
      const text = buf.subarray(0, lastNl + 1).toString('utf8');
      const events: LogEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as LogEvent);
        } catch {
          // corrupt line: surfaced by verify(), skip here so readers keep working
        }
      }
      return { events, offset: offset + lastNl + 1 };
    } finally {
      fs.closeSync(fd);
    }
  }

  tail(n: number): LogEvent[] {
    const all = this.readAll();
    return all.slice(-n);
  }

  size(): number {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  verify(): VerifyResult {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { ok: true, count: 0, headSeq: 0, headHash: GENESIS_PREV };
      throw e;
    }
    let prev = GENESIS_PREV;
    let expectSeq = 1;
    let count = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let ev: LogEvent;
      try {
        ev = JSON.parse(line) as LogEvent;
      } catch {
        // a torn final line is a crash artefact, not tampering
        if (i === lines.length - 1) break;
        return { ok: false, count, headSeq: expectSeq - 1, headHash: prev, error: { seq: expectSeq, reason: 'unparseable line' } };
      }
      if (ev.seq !== expectSeq) {
        return { ok: false, count, headSeq: expectSeq - 1, headHash: prev, error: { seq: ev.seq, reason: `sequence gap (expected ${expectSeq})` } };
      }
      if (ev.prev !== prev) {
        return { ok: false, count, headSeq: expectSeq - 1, headHash: prev, error: { seq: ev.seq, reason: 'prev hash mismatch' } };
      }
      if (hashEvent(ev.prev, ev.seq, ev.ts, ev.type, ev.data) !== ev.hash) {
        return { ok: false, count, headSeq: expectSeq - 1, headHash: prev, error: { seq: ev.seq, reason: 'content hash mismatch' } };
      }
      prev = ev.hash;
      expectSeq++;
      count++;
    }
    return { ok: true, count, headSeq: expectSeq - 1, headHash: prev };
  }
}
