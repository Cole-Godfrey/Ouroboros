// local metering proxy for LLM traffic.
//
// everything in the VM that talks to a model provider (Pi, sub-agents the agent
// spawns, scripts it writes) is pointed here with a short-lived token instead of
// the real API key. the proxy:
//   * forwards the request upstream with the real key (which never enters the
//     agent's process tree),
//   * counts tokens from the response (streaming or not) and records the cost in
//     the audit log, so the books never depend on the agent's own reporting,
//   * refuses requests once the operator's budget, or the episode's cap, is spent.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { OuroConfig } from '../lib/config.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import { roundUsd } from '../lib/money.ts';
import { isFreeModel, PROVIDERS, type WireApi } from './llm.ts';
import type { Meter, Usage } from './meter.ts';

interface TokenInfo {
  label: string;
  episode?: string;
  capUsd?: number;
  spentUsd: number;
}

export interface LlmProxyDeps {
  meter: Meter;
  config: () => OuroConfig;
  getSecret: (name: string) => string | undefined;
  log?: Logger;
  /** test seam: where each provider's real API lives. */
  upstream?: (provider: string) => string;
}

// ------------------------------------------------------------------ usage sniffing

export interface Sniffed {
  model?: string;
  usage: Usage;
  costUsd?: number;
  seen: boolean;
}

/** extracts model + token usage from provider responses without altering them. */
// reads token counts and cost out of a provider response without changing it.
// works on streaming (server-sent events) and plain json responses for both wire formats.
export class UsageSniffer {
  private api: WireApi;
  private streaming: boolean;
  private text = '';
  private out: Sniffed = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, seen: false };
  private static MAX = 16 * 1024 * 1024;

  constructor(api: WireApi, streaming: boolean) {
    this.api = api;
    this.streaming = streaming;
  }

  push(chunk: Buffer): void {
    if (this.text.length > UsageSniffer.MAX) return;
    this.text += chunk.toString('utf8');
    if (this.streaming) this.drain(false);
  }

  private drain(final: boolean): void {
    let idx: number;
    while ((idx = this.text.search(/\r?\n\r?\n/)) !== -1) {
      const m = /\r?\n\r?\n/.exec(this.text)!;
      const block = this.text.slice(0, idx);
      this.text = this.text.slice(idx + m[0].length);
      this.block(block);
    }
    if (final && this.text.trim()) {
      this.block(this.text);
      this.text = '';
    }
  }

  private block(block: string): void {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        this.event(JSON.parse(data));
      } catch {
        /* partial or non-JSON frame */
      }
    }
  }

  private take(u: any): void {
    if (!u || typeof u !== 'object') return;
    const o = this.out.usage;
    if (this.api === 'anthropic') {
      const set = (k: keyof Usage, v: unknown) => {
        if (typeof v === 'number' && v >= o[k]) o[k] = v;
      };
      set('input', u.input_tokens);
      set('output', u.output_tokens);
      set('cacheRead', u.cache_read_input_tokens);
      set('cacheWrite', u.cache_creation_input_tokens);
      this.out.seen = true;
      return;
    }
    // openai-style (chat completions, or the responses API)
    const prompt = u.prompt_tokens ?? u.input_tokens;
    const completion = u.completion_tokens ?? u.output_tokens;
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
    if (typeof prompt === 'number') o.input = Math.max(o.input, prompt - cached);
    if (typeof cached === 'number') o.cacheRead = Math.max(o.cacheRead, cached);
    if (typeof completion === 'number') o.output = Math.max(o.output, completion);
    if (typeof u.cost === 'number') this.out.costUsd = u.cost;
    this.out.seen = true;
  }

  private event(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    if (this.api === 'anthropic') {
      if (ev.type === 'message_start') {
        this.out.model ??= ev.message?.model;
        this.take(ev.message?.usage);
      } else if (ev.type === 'message_delta') this.take(ev.usage);
      return;
    }
    if (ev.model) this.out.model ??= ev.model;
    if (ev.usage) this.take(ev.usage);
    if (ev.type === 'response.completed' || ev.type === 'response.done') {
      this.out.model ??= ev.response?.model;
      this.take(ev.response?.usage);
    }
  }

  finish(): Sniffed {
    if (this.streaming) this.drain(true);
    else {
      try {
        const j = JSON.parse(this.text);
        this.out.model ??= j.model ?? j.message?.model;
        this.take(j.usage ?? j.message?.usage);
      } catch {
        /* not JSON (error page, etc.) */
      }
    }
    return this.out;
  }
}

// ------------------------------------------------------------------ the proxy

// headers that belong to one connection and must not be forwarded
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding']);

// a local reverse proxy in front of the model providers. it swaps a short-lived token for the real key,
// refuses calls when the budget is spent, and records the cost of every call.
export class LlmProxy {
  private d: LlmProxyDeps;
  private log: Logger;
  private tokens = new Map<string, TokenInfo>();
  private server?: http.Server;
  url = '';

  constructor(deps: LlmProxyDeps) {
    this.d = deps;
    this.log = deps.log ?? nullLogger;
  }

  // a token lives for one episode and can carry its own spending cap
  issueToken(o: { label: string; episode?: string; capUsd?: number }): string {
    const token = `ouro-${randomBytes(18).toString('hex')}`;
    this.tokens.set(token, { label: o.label, episode: o.episode, capUsd: o.capUsd, spentUsd: 0 });
    return token;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  spentUsd(token: string): number {
    return this.tokens.get(token)?.spentUsd ?? 0;
  }

  private lookup(presented: string | undefined): { token: string; info: TokenInfo } | undefined {
    if (!presented) return undefined;
    for (const [t, info] of this.tokens) {
      const a = Buffer.from(t);
      const b = Buffer.from(presented);
      if (a.length === b.length && timingSafeEqual(a, b)) return { token: t, info };
    }
    return undefined;
  }

  async start(port: number, host = '127.0.0.1'): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log.error('proxy handler crashed', e);
        if (!res.headersSent) this.fail(res, 'anthropic', 500, 'api_error', 'proxy error');
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    this.url = `http://${host}:${addr.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  private fail(res: http.ServerResponse, api: WireApi, status: number, type: string, message: string): void {
    const body =
      api === 'anthropic'
        ? { type: 'error', error: { type, message } }
        : { error: { message, type, code: type } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // authenticate, enforce the budget, forward to the provider with the real key, stream the answer back and account for it
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
    const provider = m?.[1] ?? '';
    const spec = PROVIDERS[provider];
    if (!spec) return this.fail(res, 'anthropic', 404, 'not_found_error', `unknown provider "${provider}"`);
    const rest = (m?.[2] ?? '/') + url.search;

    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const presented = (req.headers['x-api-key'] as string | undefined) ?? auth;
    const found = this.lookup(presented);
    if (!found) return this.fail(res, spec.api, 401, 'authentication_error', 'invalid or expired Ouroboros proxy token');

    // budget gates, checked before any money can be spent
    const status = this.d.meter.status();
    if (status.exhausted) return this.fail(res, spec.api, 402, 'billing_error', `Ouroboros budget: ${status.reason}. The agent sleeps until the budget resets or the operator raises it.`);
    if (found.info.capUsd !== undefined && found.info.spentUsd >= found.info.capUsd) {
      return this.fail(res, spec.api, 402, 'billing_error', `Ouroboros budget: this episode's cap of $${found.info.capUsd.toFixed(2)} is spent. Wrap up with episode_end.`);
    }
    const realKey = this.d.getSecret(spec.keyEnv);
    if (!realKey) return this.fail(res, spec.api, 401, 'authentication_error', `no ${spec.keyEnv} in the vault`);

    // read the request body (needed to detect streaming and to forward)
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) return this.fail(res, spec.api, 413, 'request_too_large', 'request body too large');
      chunks.push(c as Buffer);
    }
    let body: Buffer | undefined = chunks.length ? Buffer.concat(chunks) : undefined;
    let streaming = false;
    let requestedModel: string | undefined;
    if (body && /json/.test(String(req.headers['content-type'] ?? ''))) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        streaming = j.stream === true;
        requestedModel = typeof j.model === 'string' ? j.model : undefined;
        // streams in the openai style only report usage if asked to
        if (spec.api === 'openai' && streaming && rest.includes('/chat/completions') && !j.stream_options?.include_usage) {
          j.stream_options = { ...(j.stream_options ?? {}), include_usage: true };
          body = Buffer.from(JSON.stringify(j));
        }
      } catch {
        /* forward untouched */
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || key === 'x-api-key' || key === 'authorization' || key === 'accept-encoding' || v === undefined) continue;
      headers[key] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    headers['accept-encoding'] = 'identity';
    if (spec.api === 'anthropic') headers['x-api-key'] = realKey;
    else headers.authorization = `Bearer ${realKey}`;

    const base = this.d.upstream?.(provider) ?? spec.upstream;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    let up: Response;
    try {
      up = await fetch(base + rest, { method: req.method, headers, body: body as RequestInit['body'], signal: ac.signal, redirect: 'manual' });
    } catch (e) {
      if (ac.signal.aborted) return;
      this.log.warn(`upstream ${provider} unreachable`, e instanceof Error ? e.message : String(e));
      return this.fail(res, spec.api, 502, 'api_error', `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }

    const outHeaders: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(up.status, outHeaders);
    const isEventStream = /text\/event-stream/.test(up.headers.get('content-type') ?? '');
    const sniff = new UsageSniffer(spec.api, isEventStream);
    try {
      if (up.body) {
        for await (const chunk of Readable.fromWeb(up.body as any)) {
          const buf = chunk as Buffer;
          sniff.push(buf);
          if (!res.write(buf)) await new Promise<void>((r) => res.once('drain', r));
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) this.log.warn('stream interrupted', e instanceof Error ? e.message : String(e));
    } finally {
      res.end();
      this.account(provider, spec.api, sniff.finish(), requestedModel, found);
    }
  }

  private account(provider: string, api: WireApi, s: Sniffed, requestedModel: string | undefined, found: { token: string; info: TokenInfo }): void {
    if (!s.seen) return;
    const model = s.model ?? requestedModel ?? 'unknown';
    // a request for a free model costs nothing even if the response names a different model
    const reported = requestedModel && isFreeModel(requestedModel) ? 0 : s.costUsd;
    const { costUsd } = this.d.meter.record({ provider, model, usage: s.usage, costUsd: reported, episode: found.info.episode, source: 'proxy' });
    found.info.spentUsd = roundUsd(found.info.spentUsd + costUsd);
    this.log.debug(`llm call ${provider}/${model}`, { ...s.usage, costUsd, label: found.info.label });
    void api;
  }
}
