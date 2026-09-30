// minimal client for Pi's RPC mode (JSONL over stdin/stdout).
// protocol reference: node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
//
// we speak the documented wire protocol directly (rather than importing Pi's
// RpcClient) so the daemon controls process lifetime, backpressure and kill
// escalation itself, and does not depend on Pi internals.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export interface PiEvent {
  type: string;
  [k: string]: any;
}

export interface PiSpawnOptions {
  /** executable to run (the `pi` binary, or `process.execPath` with the script as first arg). */
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stderrFile?: string;
}

interface Pending {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

// a thin client for pi's rpc mode: json lines over stdin and stdout.
// requests carry an id and are matched to responses, everything else is an event for listeners.
export class PiRpcError extends Error {}

export class PiRpc {
  readonly child: ChildProcess;
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(ev: PiEvent) => void>();
  private stderrFd?: number;
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  lastEventAt = Date.now();

  private constructor(child: ChildProcess, stderrFd?: number) {
    this.child = child;
    this.stderrFd = stderrFd;
    child.stdout!.on('data', (c: Buffer) => this.onData(c));
    child.stderr!.on('data', (c: Buffer) => {
      if (this.stderrFd !== undefined) {
        try {
          fs.writeSync(this.stderrFd, c);
        } catch {
          /* ignore */
        }
      }
    });
    child.stdin!.on('error', () => {
      /* a broken pipe after exit is expected */
    });
    this.exited = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        this.exitInfo = { code, signal };
        if (this.stderrFd !== undefined) {
          try {
            fs.closeSync(this.stderrFd);
          } catch {
            /* ignore */
          }
        }
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new PiRpcError(`pi exited (code ${code}, signal ${signal}) before answering ${p.command}`));
          this.pending.delete(id);
        }
        resolve({ code, signal });
      });
    });
    child.on('error', (e) => {
      this.emit({ type: 'spawn_error', error: e.message });
    });
  }

  static spawn(o: PiSpawnOptions): PiRpc {
    let fd: number | undefined;
    if (o.stderrFile) fd = fs.openSync(o.stderrFile, 'a');
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    return new PiRpc(child, fd);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  onEvent(cb: (ev: PiEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: PiEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* listener errors must not break the reader */
      }
    }
  }

  /** split on LF only (never on U+2028/2029, which are legal inside JSON strings). */
  // split the stream on newlines only (never on unicode line separators, which can appear inside json)
  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let idx: number;
    while ((idx = this.buf.indexOf(0x0a)) !== -1) {
      let line = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: PiEvent;
      try {
        msg = JSON.parse(line) as PiEvent;
      } catch {
        continue; // not protocol data
      }
      this.lastEventAt = Date.now();
      if (msg.type === 'response') {
        const id = msg.id as string | undefined;
        const p = id ? this.pending.get(id) : undefined;
        if (p) {
          this.pending.delete(id!);
          clearTimeout(p.timer);
          if (msg.success === false) p.reject(new PiRpcError(`${msg.command}: ${msg.error ?? 'failed'}`));
          else p.resolve(msg.data);
        }
        continue;
      }
      this.emit(msg);
    }
  }

  // send a command and wait for the response with the same id, with a timeout
  request<T = any>(command: { type: string; [k: string]: any }, timeoutMs = 30_000): Promise<T> {
    if (this.hasExited) return Promise.reject(new PiRpcError('pi has exited'));
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(`timeout waiting for ${command.type} response`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: command.type });
      try {
        this.child.stdin!.write(JSON.stringify({ id, ...command }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  prompt(message: string): Promise<{ disposition?: string }> {
    return this.request({ type: 'prompt', message }, 60_000);
  }

  async abort(): Promise<void> {
    await this.request({ type: 'abort' }, 20_000).catch(() => undefined);
  }

  /** orderly shutdown: close stdin, wait, then SIGTERM, then SIGKILL. */
  async stop(graceMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.hasExited) return this.exitInfo!;
    try {
      this.child.stdin!.end();
    } catch {
      /* ignore */
    }
    const race = (ms: number) => Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    let r = await race(graceMs);
    if (r) return r;
    this.child.kill('SIGTERM');
    r = await race(3000);
    if (r) return r;
    this.child.kill('SIGKILL');
    return this.exited;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}
