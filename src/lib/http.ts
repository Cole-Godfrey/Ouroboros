// Tiny fetch wrapper with timeouts, retries and readable errors.

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  json?: unknown;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const retries = opts.retries ?? 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      let body = opts.body;
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers['content-type'] ??= 'application/json';
      }
      const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? 20_000)];
      if (opts.signal) signals.push(opts.signal);
      const res = await fetch(url, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body: body as RequestInit['body'],
        signal: AbortSignal.any(signals),
      });
      const text = await res.text();
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(res.status, url, text);
      } else {
        return { status: res.status, text, headers: res.headers };
      }
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) throw e;
    }
    await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 500) * 2 ** attempt));
  }
  throw lastErr;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { status, text } = await fetchText(url, opts);
  if (status < 200 || status >= 300) throw new HttpError(status, url, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}
