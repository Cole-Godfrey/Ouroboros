// time helpers. every service takes an injectable Clock so tests can control time.

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** blocking sleep. only for short waits in synchronous lock loops. */
// block the thread briefly. only used while waiting for a file lock.
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** the date as YYYY-MM-DD for a timestamp in the given IANA timezone (falls back to UTC). */
// the calendar day in the operator's timezone. daily budgets reset at local midnight.
export function localDate(ts: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** "3h 12m", "45s", "2d 4h", for humans. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'n/a';
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (!d && !h && (s || !m)) parts.push(`${s}s`);
  return (neg ? '-' : '') + parts.join(' ');
}
