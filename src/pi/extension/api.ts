// tiny client for the Ouroboros daemon's unix-socket API, used by the agent's tools.

import http from 'node:http';

export class DaemonUnavailable extends Error {}

// same as the toolkit client, but reads the socket path pi was started with
export function callApi<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10 * 60_000): Promise<T> {
  const socketPath = process.env.OURO_SOCK;
  if (!socketPath) return Promise.reject(new DaemonUnavailable('OURO_SOCK is not set: this Pi session is not attached to an Ouroboros daemon'));
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { error: text.slice(0, 500) };
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(json?.error ?? `HTTP ${res.statusCode}`));
          else resolve(json as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('daemon request timed out')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new DaemonUnavailable(`the Ouroboros daemon is not reachable on ${socketPath}`) : e));
    if (payload) req.write(payload);
    req.end();
  });
}
