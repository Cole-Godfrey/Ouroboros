// local HTTP API of the daemon.
//
//   unix socket (paths.sock, mode 0600)  full access, used by the CLI and the agent's Pi extension
//   TCP 127.0.0.1:<port> + token         read-only, used by the dashboard
//
// everything that leaves this file is passed through the secret redactor.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { newId } from '../lib/ids.ts';
import { globalRedactor } from '../lib/redact.ts';
import { roundUsd } from '../lib/money.ts';
import { checkCharter } from './charter.ts';
import { resolveVenueModule, runVenueMethod } from './venues/run.ts';
import { SECRET_NAME_RE } from './vault.ts';
import type { Daemon } from './daemon.ts';

// an error with an http status that the handler turns into a json response
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// small validators keep every route's input handling in one place and its errors uniform
const bad = (msg: string): never => {
  throw new ApiError(400, msg);
};

const str = (v: unknown, name: string, opts: { max?: number; optional?: boolean } = {}): string => {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    return bad(`${name} is required`);
  }
  if (typeof v !== 'string') return bad(`${name} must be a string`);
  if (v.length > (opts.max ?? 20_000)) return bad(`${name} is too long`);
  return v;
};

const num = (v: unknown, name: string, opts: { optional?: boolean; min?: number } = {}): number => {
  if (v === undefined || v === null) {
    if (opts.optional) return NaN;
    return bad(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return bad(`${name} must be a number`);
  if (opts.min !== undefined && n < opts.min) return bad(`${name} must be >= ${opts.min}`);
  return n;
};

// venue ids become file paths and labels, so keep them simple
const VENUE_ID = /^[a-z][a-z0-9-]{1,40}$/;

// read a json body, refusing anything large so a buggy caller cannot exhaust memory
async function readBody(req: http.IncomingMessage, max = 2 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ApiError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'body is not valid JSON');
  }
}

function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}

// routes are a table of handlers. write routes are refused on the read-only tcp listener.
export function createApiHandler(d: Daemon) {
  const { store } = d;

  const status = () => {
    store.sync();
    const now = d.clock();
    return {
      now,
      metrics: store.state.metrics(now),
      budget: d.meter.status(),
      episodeBudgetUsd: d.meter.episodeBudgetUsd(),
      control: store.state.control,
      runner: { running: d.runner.running(), current: d.runner.current() },
      scheduler: d.scheduler.status(now),
      release: { running: d.selfmod.runningSha(), current: d.selfmod.currentSha(), lkg: d.selfmod.lkgSha(), promotion: d.selfmod.readPromotion() },
      charter: checkCharter(d.paths, d.paths.root),
      inbox: { open: store.state.openInbox().length, unseenForAgent: store.state.unseenForAgent().length },
      incidents: store.state.openIncidents().length,
      strategies: d.procman.list(),
      venues: store.state.liveVenues().map((v) => ({ id: v.id, strategy: v.strategy, totalUsd: v.latest?.totalUsd, at: v.latest?.ts, error: v.lastError?.message, guard: v.guard })),
      mode: d.cfg().budget.mode,
      uptimeSec: Math.round((now - d.startedAt) / 1000),
    };
  };

  const dashboard = () => {
    const s = status();
    const st = store.state;
    const idx = downsample(st.wealthIndex(), 400);
    const dayMs = 86_400_000;
    const byDay: Record<string, number> = {};
    for (const e of st.llm.entries) {
      const k = new Date(e.ts).toISOString().slice(0, 10);
      byDay[k] = roundUsd((byDay[k] ?? 0) + e.usd);
    }
    return {
      ...s,
      nav: idx.map((p) => ({ ts: p.ts, usd: p.nav, index: p.index })),
      venuesDetail: st.liveVenues().map((v) => ({ id: v.id, strategy: v.strategy, description: v.description, latest: v.latest, peakUsd: v.peakUsd, error: v.lastError, guard: v.guard })),
      episodes: [...st.episodes].slice(-25).reverse(),
      currentEpisode: st.currentEpisode,
      inboxItems: [...st.inbox.values()].sort((a, b) => b.ts - a.ts).slice(0, 40),
      incidentsOpen: st.openIncidents(),
      incidentsRecent: [...st.incidents.values()].sort((a, b) => b.ts - a.ts).slice(0, 15),
      journal: st.journal.slice(-30).reverse(),
      selfmod: { current: st.selfmod.current, lkg: st.selfmod.lkg, probation: st.selfmod.probation, bad: st.selfmod.bad, history: st.selfmod.history.slice(-15).reverse() },
      llm: { sponsorUsd: st.llm.sponsorUsd, capitalUsd: st.llm.capitalUsd, tokens: st.llm.tokens, byModel: st.llm.byModel, byDay: Object.entries(byDay).slice(-14) },
      expenses: st.expenses,
      income: st.income,
      trades: st.trades.slice(-20).reverse(),
      tradeCount: st.tradeCount,
      unclassified: st.unclassifiedInflows(),
      wakes: st.pendingWakes(),
      flows: st.flows.slice(-20).reverse(),
      window: dayMs,
    };
  };

  /** route table. `write` routes are refused on the TCP (dashboard) listener. */
  type Handler = (q: URLSearchParams, body: any) => unknown | Promise<unknown>;
  const routes: Record<string, { write: boolean; fn: Handler }> = {
    'GET /healthz': { write: false, fn: () => ({ ok: true, pid: process.pid, sha: d.selfmod.runningSha(), uptimeSec: Math.round((d.clock() - d.startedAt) / 1000) }) },
    'GET /v1/status': { write: false, fn: () => status() },
    'GET /v1/report': { write: false, fn: (q) => d.reports.latest(q.get('now') === '1') },
    'GET /v1/dashboard': { write: false, fn: () => dashboard() },
    'GET /v1/config': { write: false, fn: () => ({ config: d.cfg(), limits: d.limits() }) },
    'GET /v1/ledger/tail': {
      write: false,
      fn: (q) => {
        const n = Math.min(500, Number(q.get('n') ?? 30));
        const types = q.get('types')?.split(',').filter(Boolean);
        const all = store.log.readAll();
        const f = types ? all.filter((e) => types.some((t) => e.type === t || e.type.startsWith(t + '.'))) : all;
        return { events: f.slice(-n) };
      },
    },
    'GET /v1/ledger/verify': { write: false, fn: () => store.log.verify() },
    'GET /v1/venues': { write: false, fn: () => ({ venues: store.state.liveVenues() }) },
    'GET /v1/strategies': { write: false, fn: () => ({ strategies: d.procman.details() }) },
    'GET /v1/strategy/logs': { write: false, fn: (q) => ({ logs: d.procman.logs(str(q.get('name'), 'name'), Math.min(1000, Number(q.get('lines') ?? 100))) }) },
    'GET /v1/inbox': {
      write: false,
      fn: (q) => {
        store.sync();
        if (q.get('all')) return { items: d.inbox.all(Number(q.get('limit') ?? 100)) };
        return { unseen: d.inbox.unseenForAgent(), open: d.inbox.open() };
      },
    },
    'GET /v1/episodes': { write: false, fn: (q) => ({ episodes: store.state.episodes.slice(-Number(q.get('n') ?? 20)).reverse(), current: store.state.currentEpisode }) },
    'GET /v1/incidents': { write: false, fn: (q) => ({ incidents: q.get('all') ? [...store.state.incidents.values()].slice(-100) : store.state.openIncidents() }) },
    'GET /v1/journal': { write: false, fn: (q) => ({ entries: store.state.journal.slice(-Number(q.get('n') ?? 30)) }) },
    'GET /v1/model': { write: false, fn: () => d.modelInfo() },
    'GET /v1/budget': { write: false, fn: () => ({ ...d.meter.status(), episodeBudgetUsd: d.meter.episodeBudgetUsd() }) },
    'GET /v1/selfmod/status': { write: false, fn: () => d.selfmod.status() },
    'GET /v1/selfmod/history': { write: false, fn: () => ({ history: d.selfmod.history(30) }) },
    'GET /v1/secrets': { write: false, fn: () => ({ secrets: d.vault.list() }) },
    'GET /v1/wallets': { write: false, fn: () => d.wallets() },

    // ---------------------------------------------------------- writes
    'POST /v1/inbox/send': {
      write: true,
      fn: (_q, b) => {
        const kind = ['request', 'info', 'alert', 'question'].includes(b.kind) ? b.kind : bad('kind must be request|info|alert|question');
        const r = d.inbox.create({ kind, title: str(b.title, 'title', { max: 200 }), body: str(b.body, 'body', { optional: true, max: 8000 }), steps: Array.isArray(b.steps) ? b.steps.map(String) : undefined, secrets: Array.isArray(b.secrets) ? b.secrets.map(String) : undefined, urgency: ['low', 'normal', 'high'].includes(b.urgency) ? b.urgency : 'normal', blocking: b.blocking ? String(b.blocking) : undefined });
        return r;
      },
    },
    'POST /v1/inbox/reply': { write: true, fn: (_q, b) => (d.inbox.reply(str(b.id, 'id'), str(b.text, 'text'), b.by === 'agent' ? 'agent' : 'operator', str(b.channel, 'channel', { optional: true }) || 'cli'), { ok: true }) },
    'POST /v1/inbox/say': { write: true, fn: (_q, b) => ({ id: d.inbox.say(str(b.text, 'text'), str(b.channel, 'channel', { optional: true }) || 'cli') }) },
    'POST /v1/inbox/status': { write: true, fn: (_q, b) => (d.inbox.setStatus(str(b.id, 'id'), ['open', 'answered', 'done', 'dismissed'].includes(b.status) ? b.status : bad('bad status'), str(b.by, 'by', { optional: true }) || 'operator', b.note), { ok: true }) },
    'POST /v1/inbox/ack': { write: true, fn: (_q, b) => (d.inbox.ack(Array.isArray(b.ids) ? b.ids.map(String) : []), { ok: true }) },

    'POST /v1/episode/end': {
      write: true,
      fn: (_q, b) => {
        const episode = str(b.episode, 'episode');
        const tier = b.tier === 'cheap' ? 'cheap' : b.tier === 'default' ? 'default' : undefined;
        const nextWakeMinutes = b.nextWakeMinutes === undefined ? undefined : num(b.nextWakeMinutes, 'nextWakeMinutes', { min: 1 });
        const ok = d.runner.noteEnd(episode, { handoff: str(b.handoff, 'handoff', { max: 8000 }), nextWakeMinutes, tier, reason: b.reason ? String(b.reason).slice(0, 300) : undefined });
        if (!ok) bad('no such active episode');
        return { ok: true };
      },
    },
    'POST /v1/wake': {
      write: true,
      fn: (_q, b) => {
        const at = b.at !== undefined ? num(b.at, 'at') : d.clock() + num(b.inMinutes, 'inMinutes', { min: 1 }) * 60_000;
        const id = newId('wk');
        store.append('wake.request', { id, at, reason: str(b.reason, 'reason', { max: 300 }), by: 'agent', tier: b.tier === 'cheap' ? 'cheap' : 'default' });
        return { id, at };
      },
    },
    'POST /v1/journal': { write: true, fn: (_q, b) => (store.append('journal', { kind: ['decision', 'lesson', 'observation', 'mistake', 'plan'].includes(b.kind) ? b.kind : 'observation', text: str(b.text, 'text', { max: 4000 }), tags: Array.isArray(b.tags) ? b.tags.map(String).slice(0, 8) : undefined }), { ok: true }) },
    'POST /v1/incident/resolve': { write: true, fn: (_q, b) => (store.append('incident.resolve', { id: str(b.id, 'id'), note: str(b.note, 'note', { optional: true, max: 1000 }) }), { ok: true }) },

    'POST /v1/fund': {
      write: true,
      fn: (_q, b) => {
        const dir = b.direction === 'out' ? 'out' : 'in';
        const usd = roundUsd(num(b.usd, 'usd', { min: 0.000001 }));
        const at = b.at !== undefined ? num(b.at, 'at') : undefined;
        store.append(dir === 'in' ? 'capital.in' : 'capital.out', { usd, venue: b.venue ? String(b.venue) : undefined, note: b.note ? String(b.note).slice(0, 300) : undefined, ref: b.ref ? String(b.ref) : undefined, at, by: b.by === 'agent' ? 'agent' : 'operator' });
        return { ok: true, netContributedUsd: store.state.netContributedUsd() };
      },
    },
    'POST /v1/inflow/resolve': {
      write: true,
      fn: (_q, b) => {
        const id = str(b.id, 'id');
        const as = ['capital', 'income', 'ignore'].includes(b.as) ? b.as : bad('as must be capital|income|ignore');
        store.sync();
        const f = store.state.inflows.get(id);
        if (!f) bad('no such inflow');
        store.append('inflow.resolve', { id, as, by: b.by === 'agent' ? 'agent' : 'operator' });
        if (as === 'capital') store.append('capital.in', { usd: f!.usd, venue: f!.venue, ref: f!.ref, by: b.by === 'agent' ? 'agent' : 'operator', note: 'classified from unclassified inflow' });
        if (as === 'income') store.append('income', { usd: f!.usd, category: 'other', memo: `classified inflow ${f!.ref ?? id}`, ref: f!.ref });
        return { ok: true };
      },
    },
    'POST /v1/expense': { write: true, fn: (_q, b) => (store.append('expense', { usd: roundUsd(num(b.usd, 'usd', { min: 0 })), category: str(b.category, 'category', { max: 40 }), funding: b.funding === 'sponsor' ? 'sponsor' : 'capital', counterparty: b.counterparty, memo: b.memo, ref: b.ref }), { ok: true }) },
    'POST /v1/income': { write: true, fn: (_q, b) => (store.append('income', { usd: roundUsd(num(b.usd, 'usd', { min: 0 })), category: str(b.category, 'category', { max: 40 }), memo: b.memo, ref: b.ref }), { ok: true }) },
    'POST /v1/trade': {
      write: true,
      fn: (_q, b) => (
        store.append('trade', { venue: str(b.venue, 'venue'), market: str(b.market, 'market'), side: b.side === 'sell' ? 'sell' : 'buy', qty: num(b.qty, 'qty'), price: num(b.price, 'price'), feeUsd: Number.isFinite(Number(b.feeUsd)) ? Number(b.feeUsd) : 0, pnlUsd: b.pnlUsd === undefined ? undefined : num(b.pnlUsd, 'pnlUsd'), strategy: b.strategy, memo: b.memo }),
        { ok: true }
      ),
    },

    'POST /v1/venue/register': {
      write: true,
      fn: async (_q, b) => {
        const id = str(b.id, 'id');
        if (!VENUE_ID.test(id)) bad('venue ids are lowercase letters, digits and - (2-41 chars)');
        if (d.limits().blockedVenues?.map((x) => x.toLowerCase()).includes(id.toLowerCase())) bad(`"${id}" is blocked by the operator's limits`);
        const module = str(b.module, 'module');
        const file = resolveVenueModule(module, d.paths);
        if (!fs.existsSync(file)) bad(`venue module not found: ${file}`);
        const desc = await runVenueMethod<{ id: string; description?: string; secrets: string[]; hasFlows: boolean }>({ paths: d.paths, module, method: 'describe', venueId: id, timeoutMs: 20_000 });
        if (!desc.ok) bad(`venue module failed to load: ${desc.error}`);
        const secrets = [...new Set([...(desc.result?.secrets ?? []), ...(Array.isArray(b.secrets) ? b.secrets.map(String) : [])])];
        const { missing } = d.vault.env(secrets);
        if (missing.length) bad(`missing secrets in the vault: ${missing.join(', ')}. Ask the operator via inbox_send (kind "request", secrets: [${missing.map((m) => `"${m}"`).join(', ')}]).`);
        const guard = b.guardMaxDrawdownPct !== undefined ? { maxDrawdownPct: num(b.guardMaxDrawdownPct, 'guardMaxDrawdownPct', { min: 0.01 }) } : undefined;
        store.append('venue.register', { id, module, description: b.description ?? desc.result?.description, secrets, strategy: b.strategy, guard, kind: b.kind, enabled: true, hasFlows: desc.result?.hasFlows ?? false });
        const round = await d.reconciler.round([id]);
        const v = store.state.venues.get(id);
        return { ok: true, snapshot: v?.latest ?? null, error: v?.lastError?.message, navUsd: round.navUsd };
      },
    },
    'POST /v1/venue/remove': { write: true, fn: (_q, b) => (store.append('venue.remove', { id: str(b.id, 'id'), reason: b.reason }), { ok: true }) },
    'POST /v1/venue/snapshot': {
      write: true,
      fn: async (_q, b) => {
        const only = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
        const r = await d.reconciler.round(only);
        return { ...r, metrics: store.state.metrics(d.clock()) };
      },
    },
    'POST /v1/venue/value': {
      write: true,
      fn: async (_q, b) => {
        // manual valuation of a venue with no adapter (e.g. the operator reports a balance)
        const id = str(b.id, 'id');
        const v = await d.oracle.value(Array.isArray(b.holdings) ? b.holdings : b.usd !== undefined ? [{ asset: 'USD', qty: num(b.usd, 'usd', { min: 0 }) }] : bad('holdings or usd required'));
        store.append('valuation', { venue: id, totalUsd: v.totalUsd, holdings: v.holdings, unpriced: v.unpriced, source: 'manual', note: b.note });
        store.append('nav', { usd: store.state.liveNavUsd(), stale: [], byVenue: {} });
        return { ok: true, totalUsd: v.totalUsd };
      },
    },

    'POST /v1/strategy': {
      write: true,
      fn: async (_q, b) => {
        const name = str(b.name, 'name');
        switch (b.action) {
          case 'register':
            d.procman.register({ name, cmd: Array.isArray(b.cmd) ? b.cmd.map(String) : bad('cmd must be an argv array'), cwd: b.cwd, env: b.env, secrets: Array.isArray(b.secrets) ? b.secrets.map(String) : [], restart: ['always', 'on-failure', 'never'].includes(b.restart) ? b.restart : 'on-failure', description: b.description, venue: b.venue });
            return { ok: true };
          case 'start':
            return { ok: true, ...d.procman.start(name) };
          case 'stop':
            await d.procman.stop(name, str(b.by, 'by', { optional: true }) || 'agent');
            return { ok: true };
          case 'remove':
            d.procman.remove(name);
            return { ok: true };
          default:
            return bad('action must be register|start|stop|remove');
        }
      },
    },

    'POST /v1/selfmod/propose': { write: true, fn: (_q, b) => d.selfmod.propose(str(b.message, 'message', { max: 500 }), b.by === 'operator' ? 'operator' : 'agent') },
    'POST /v1/selfmod/rollback': { write: true, fn: (_q, b) => d.selfmod.rollback(str(b.reason, 'reason', { max: 300 }), b.by === 'agent' ? 'agent' : 'operator') },

    'POST /v1/secret/set': {
      write: true,
      fn: (_q, b) => {
        const name = str(b.name, 'name');
        if (!SECRET_NAME_RE.test(name)) bad('secret names look like ENV_VAR_NAMES');
        d.vault.set(name, str(b.value, 'value', { max: 100_000 }), b.note ? String(b.note) : undefined);
        return { ok: true };
      },
    },
    'POST /v1/secret/delete': { write: true, fn: (_q, b) => ({ ok: d.vault.delete(str(b.name, 'name')) }) },
    'POST /v1/secret/exec': {
      write: true,
      fn: (_q, b) => runWithSecrets(d, b),
    },

    'POST /v1/control': {
      write: true,
      fn: async (_q, b) => {
        const action = ['pause', 'resume', 'halt'].includes(b.action) ? b.action : bad('action must be pause|resume|halt');
        store.append('control', { action, by: str(b.by, 'by', { optional: true }) || 'operator', note: b.note });
        if (action === 'halt') {
          d.runner.abort('halted by operator');
          await d.procman.stopAll('halt');
        }
        return { ok: true, control: store.state.control };
      },
    },
    'POST /v1/poke': { write: true, fn: (_q, b) => (d.scheduler.poke('manual', b.reason ? String(b.reason) : 'poked by operator'), { ok: true }) },
    'POST /v1/llm/token': {
      write: true,
      fn: (_q, b) => {
        if (!d.proxy?.url) return { token: null, url: null };
        return { token: d.proxy.issueToken({ label: str(b.label, 'label', { optional: true }) || 'operator chat', capUsd: b.capUsd === undefined ? undefined : num(b.capUsd, 'capUsd', { min: 0 }) }), url: d.proxy.url };
      },
    },
    'POST /v1/redact': { write: true, fn: (_q, b) => ({ text: globalRedactor.redact(String(b.text ?? '')) }) },
    'POST /v1/restart': { write: true, fn: (_q, b) => (d.requestRestart(b.reason ? String(b.reason) : 'operator request'), { ok: true }) },
    'POST /v1/model': {
      write: true,
      fn: (_q, b) => d.setModel({ provider: str(b.provider, 'provider', { optional: true }) || undefined, model: str(b.model, 'model', { max: 200 }), cheapModel: str(b.cheapModel, 'cheapModel', { optional: true, max: 200 }) || undefined, thinking: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(b.thinking) ? b.thinking : undefined, by: str(b.by, 'by', { optional: true }) || 'agent' }),
    },
    'POST /v1/config': { write: true, fn: (_q, b) => ({ config: d.patchConfig(b.patch ?? bad('patch is required')) }) },
  };

  // authenticate (tcp needs the token, the unix socket is trusted because its mode is 0600),
  // find the route, run it and redact secrets from whatever leaves.
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: { trusted: boolean; token?: Buffer }): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const send = (status: number, obj: unknown) => {
      const text = globalRedactor.redact(JSON.stringify(obj));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    };
    try {
      if (!opts.trusted) {
        const presented = url.searchParams.get('token') ?? req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const a = Buffer.from(presented);
        if (!opts.token || a.length !== opts.token.length || !timingSafeEqual(a, opts.token)) return send(401, { error: 'unauthorized' });
      }
      const route = routes[key];
      if (!route) return send(404, { error: `no route ${key}` });
      if (route.write && !opts.trusted) return send(403, { error: 'read-only listener' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await route.fn(url.searchParams, body);
      send(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      d.log.error(`api ${key} failed`, e);
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/** run a command with vault secrets injected as env vars, return redacted output. */
// the agent's way of using a secret without seeing it: the values are injected as environment variables
// of a child process and scrubbed from the output.
function runWithSecrets(d: Daemon, b: any): Promise<unknown> {
  const argv: string[] = Array.isArray(b.argv) ? b.argv.map(String) : typeof b.script === 'string' ? ['bash', '-lc', b.script] : bad('argv (array) or script (string) is required');
  const names: string[] = Array.isArray(b.secrets) ? b.secrets.map(String) : [];
  const { env: secretEnv, missing } = d.vault.env(names);
  if (missing.length) bad(`missing secrets in the vault: ${missing.join(', ')}`);
  const timeoutMs = Math.min(600, Math.max(1, Number(b.timeoutSec ?? 60))) * 1000;
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  Object.assign(env, { OURO_HOME: d.paths.home }, secretEnv);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: b.cwd ? path.resolve(String(b.cwd)) : d.paths.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    const cap = (s: string, c: Buffer) => (s.length > 200_000 ? s : s + c.toString('utf8'));
    child.stdout.on('data', (c: Buffer) => (out = cap(out, c)));
    child.stderr.on('data', (c: Buffer) => (err = cap(err, c)));
    if (typeof b.stdin === 'string') child.stdin.end(b.stdin);
    else child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: String(e), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: globalRedactor.redact(out), stderr: globalRedactor.redact(err), timedOut });
    });
  });
}
