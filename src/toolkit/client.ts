// client for the daemon's unix-socket API. used by the `ouro` CLI and by strategy
// processes the agent writes (OURO_HOME is set in their environment).

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export class DaemonDown extends Error {
  constructor(sock: string) {
    super(`the Ouroboros daemon is not running (no socket at ${sock}); start it with \`ouro start\``);
    this.name = 'DaemonDown';
  }
}

export function socketPath(): string {
  return process.env.OURO_SOCK ?? path.join(process.env.OURO_HOME ?? path.join(os.homedir(), '.ouroboros'), 'run', 'ouro.sock');
}

// call the daemon over its unix socket. strategies and scripts the agent writes can import this too.
export function apiCall<T = any>(method: 'GET' | 'POST', url: string, body?: unknown, timeoutMs = 10 * 60_000): Promise<T> {
  const sock = socketPath();
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: url, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { error: text.slice(0, 300) };
        }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(json?.error ?? `HTTP ${res.statusCode}`));
        else resolve(json as T);
      });
    });
    req.on('timeout', () => req.destroy(new Error('request to the daemon timed out')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new DaemonDown(sock) : e));
    if (payload) req.write(payload);
    req.end();
  });
}

/** convenience wrappers for strategy code. */
export const ouro = {
  status: () => apiCall('GET', '/v1/status'),
  trade: (t: { venue: string; market: string; side: 'buy' | 'sell'; qty: number; price: number; feeUsd?: number; pnlUsd?: number; strategy?: string; memo?: string }) => apiCall('POST', '/v1/trade', t),
  expense: (e: { usd: number; category: string; counterparty?: string; memo?: string; ref?: string; funding?: 'capital' | 'sponsor' }) => apiCall('POST', '/v1/expense', e),
  income: (i: { usd: number; category: string; memo?: string; ref?: string }) => apiCall('POST', '/v1/income', i),
  journal: (kind: 'decision' | 'lesson' | 'mistake' | 'observation' | 'plan', text: string) => apiCall('POST', '/v1/journal', { kind, text }),
  inbox: (title: string, body = '', urgency: 'low' | 'normal' | 'high' = 'normal') => apiCall('POST', '/v1/inbox/send', { kind: 'info', title, body, urgency }),
  snapshot: (ids?: string[]) => apiCall('POST', '/v1/venue/snapshot', { ids }),
};
