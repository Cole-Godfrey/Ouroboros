// the reconciler is the independent source of truth about money.
//
// every interval it asks each registered venue (in an isolated child process)
// what it actually holds, values the answer, and appends the result to the audit
// log. the agent cannot edit these numbers and does not need to remember them;
// if its belief disagrees with the reconciler, the reconciler wins.
//
// it also watches for the failure modes that matter most to a self-funded agent:
// deposits mistaken for profit, sudden drops, venues that stopped answering,
// and per-venue drawdown guards.

import type { OuroConfig } from '../lib/config.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { fmtPct, fmtUsd, roundUsd } from '../lib/money.ts';
import type { PriceOracle } from './prices.ts';
import type { StateStore, VenueState } from './state.ts';
import type { RunnerResult, VenueFlow, VenueFlowScan, VenueSnapshot } from './venues/types.ts';

export type VenueCall = (venue: VenueState, method: 'snapshot' | 'flows', args?: unknown) => Promise<RunnerResult>;

export interface RoundResult {
  ts: number;
  navUsd: number;
  venues: Array<{ id: string; ok: boolean; totalUsd?: number; error?: string }>;
  incidents: string[];
}

export interface ReconcilerDeps {
  store: StateStore;
  oracle: PriceOracle;
  callVenue: VenueCall;
  config: () => OuroConfig;
  log?: Logger;
  clock?: Clock;
  /** called when a venue guard trips so the daemon can stop that venue's strategy. */
  onGuardTripped?: (venue: VenueState, drawdown: number) => void | Promise<void>;
}

export class Reconciler {
  private d: ReconcilerDeps;
  private log: Logger;
  private clock: Clock;
  private failures = new Map<string, number>();
  private running = false;

  constructor(deps: ReconcilerDeps) {
    this.d = deps;
    this.log = deps.log ?? nullLogger;
    this.clock = deps.clock ?? systemClock;
  }

  /** raise an incident unless an open one with the same key already exists. returns its id if raised. */
  private raise(severity: 'info' | 'warn' | 'critical', kind: string, key: string, message: string, data?: unknown): string | undefined {
    const st = this.d.store.state;
    for (const i of st.incidents.values()) {
      if (!i.resolvedAt && i.kind === kind && (i.data as { key?: string } | undefined)?.key === key) return undefined;
    }
    const id = newId('inc');
    this.d.store.append('incident', { id, severity, kind, message, data: { ...(data as object), key } });
    return id;
  }

  /** snapshot all enabled venues (or only the given ids) and append a NAV point. */
  // only one round runs at a time, a second call returns the current numbers
  async round(only?: string[]): Promise<RoundResult> {
    if (this.running) return { ts: this.clock(), navUsd: this.d.store.state.liveNavUsd(), venues: [], incidents: [] };
    this.running = true;
    try {
      return await this.roundInner(only);
    } finally {
      this.running = false;
    }
  }

  // ask every venue for a snapshot in its own process, price the holdings, and append the results.
  // a failed venue keeps its last value and is flagged stale, so an outage is never booked as a loss.
  private async roundInner(only?: string[]): Promise<RoundResult> {
    const { store, oracle } = this.d;
    const cfg = this.d.config();
    store.sync();
    const t0 = this.clock();
    const targets = store.state.liveVenues().filter((v) => v.enabled && v.module && (!only || only.includes(v.id)));
    // keep the pre-snapshot cursor: the new valuation timestamp would skip transfers.
    const flowSince = new Map(targets.map((v) => [v.id, v.lastFlowScan ? v.lastFlowScan.through - 60_000 : v.latest?.ts ?? v.registeredAt - 15 * 60_000]));
    const results: RoundResult['venues'] = [];
    const incidents: string[] = [];
    const stale: string[] = [];

    // snapshot venues with bounded concurrency
    const queue = [...targets];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let v = queue.shift(); v; v = queue.shift()) {
        const r = await this.d.callVenue(v, 'snapshot').catch((e): RunnerResult => ({ ok: false, error: String(e), durationMs: 0 }));
        if (!r.ok) {
          const n = (this.failures.get(v.id) ?? 0) + 1;
          this.failures.set(v.id, n);
          stale.push(v.id);
          store.append('venue.error', { venue: v.id, message: r.error ?? 'unknown error' });
          results.push({ id: v.id, ok: false, error: r.error });
          if (n === 3) {
            const id = this.raise('warn', 'venue_unreachable', v.id, `Venue "${v.id}" has failed ${n} reconciliations in a row: ${r.error}`, { venue: v.id });
            if (id) incidents.push(id);
          }
          continue;
        }
        this.failures.set(v.id, 0);
        const snap = r.result as VenueSnapshot;
        const valued = await oracle.value(snap.holdings ?? []);
        store.append('valuation', { venue: v.id, totalUsd: valued.totalUsd, holdings: valued.holdings, unpriced: valued.unpriced, source: 'snapshot', note: snap.note });
        results.push({ id: v.id, ok: true, totalUsd: valued.totalUsd });
        if (valued.unpriced.length) {
          const id = this.raise('info', 'unpriced_assets', `${v.id}:${valued.unpriced.join(',')}`, `Venue "${v.id}" holds assets with no USD price, excluded from NAV: ${valued.unpriced.join(', ')}. Add a price source or have the adapter supply valueUsd.`, { venue: v.id, assets: valued.unpriced });
          if (id) incidents.push(id);
        }
      }
    });
    await Promise.all(workers);

    // deposits / withdrawals reported by adapters that can see them
    for (const v of targets) {
      if (!results.find((r) => r.id === v.id)?.ok) continue;
      await this.ingestFlows(v, flowSince.get(v.id)!, incidents).catch((e) => this.log.warn(`flows for ${v.id} failed`, e));
    }

    // canonical NAV point for this round
    store.sync();
    const nav = store.state.liveNavUsd();
    if (store.state.liveVenues().length > 0) {
      const byVenue = Object.fromEntries(store.state.liveVenues().map((v) => [v.id, v.latest?.totalUsd ?? 0]));
      store.append('nav', { usd: nav, stale, byVenue });
      this.detectAnomalies(cfg, incidents);
    }
    this.checkGuards(incidents);
    return { ts: t0, navUsd: nav, venues: results, incidents };
  }

  private async ingestFlows(v: VenueState, since: number, incidents: string[]): Promise<void> {
    const { store, oracle } = this.d;
    const r = await this.d.callVenue(v, 'flows', { since });
    if (!r.ok) return; // adapters without flows() answer with an error, that is fine
    const scan = r.result as VenueFlow[] | VenueFlowScan;
    const flows = Array.isArray(scan) ? scan : scan.flows;
    const through = Array.isArray(scan) ? this.clock() : scan.through;
    if (!Array.isArray(flows) || !Number.isFinite(through) || (through < since && flows.length > 0)) throw new Error('invalid flow scan result');
    const known = new Set<string>();
    for (const f of store.state.flows) if (f.ref) known.add(f.ref);
    for (const i of store.state.inflows.values()) if (i.ref) known.add(i.ref);
    const operator = new Set(this.d.config().operator.addresses.map((a) => a.toLowerCase()));
    for (const f of flows) {
      if (!f.ref || known.has(f.ref)) continue;
      const usd = roundUsd(f.usd ?? (f.qty * ((await oracle.usd(f.asset)) ?? 0)));
      if (usd <= 0) continue;
      known.add(f.ref);
      if (f.kind === 'deposit') {
        if (f.from && operator.has(f.from.toLowerCase())) {
          store.append('capital.in', { usd, venue: v.id, ref: f.ref, at: f.ts, by: 'system', note: `auto: deposit from operator address ${f.from}` });
        } else {
          const id = newId('in');
          store.append('inflow.unclassified', { id, venue: v.id, usd, asset: f.asset, from: f.from, ref: f.ref, at: f.ts });
          const inc = this.raise('warn', 'unclassified_inflow', f.ref, `${fmtUsd(usd)} of ${f.asset} arrived at "${v.id}" from ${f.from ?? 'unknown'} (ref ${f.ref}). Deposit from you, or income? Until classified it is excluded from P&L: run \`ouro fund resolve ${id} capital|income|ignore\`.`, { venue: v.id, inflowId: id, usd });
          if (inc) incidents.push(inc);
        }
      } else if (f.to && operator.has(f.to.toLowerCase())) {
        store.append('capital.out', { usd, venue: v.id, ref: f.ref, at: f.ts, by: 'system', note: `auto: withdrawal to operator address ${f.to}` });
      }
    }
    store.append('venue.flows.scan', { venue: v.id, since, through });
  }

  // two checks on the newest round: a rise nobody can explain, and a large drop that needs a post-mortem
  private detectAnomalies(cfg: OuroConfig, incidents: string[]): void {
    const { store } = this.d;
    const round = store.state.lastRound();
    if (!round) return;
    const delta = round.v1 - round.v0 - round.flowUsd;
    if (round.v0 > 0 && delta > Math.max(cfg.reconcile.jumpMinUsd, cfg.reconcile.jumpPct * round.v0)) {
      // explained by recorded income or trade P&L since the previous round?
      let explained = 0;
      for (const t of store.state.trades) if (t.ts > round.t0 && t.pnlUsd) explained += t.pnlUsd;
      // lastRound already removes pending inflows from the NAV change.
      if (explained < 0.5 * delta) {
        const id = this.raise('warn', 'unexplained_jump', String(round.t1), `NAV rose ${fmtUsd(delta)} (${fmtPct(delta / round.v0)}) since the last reconciliation with no recorded deposit, income or trade P&L. Check \`ouro fund inflows\` and the venue transfer history; record manual capital only for a transfer the adapter cannot detect. Until then treat it as unproven.`, { delta, from: round.v0, to: round.v1 });
        if (id) incidents.push(id);
      }
    }
    if (round.returnPct <= -cfg.reconcile.dropPct) {
      const sev = round.returnPct <= -0.5 ? 'critical' : 'warn';
      const id = this.raise(sev, 'nav_drop', String(round.t1), `NAV fell ${fmtPct(-round.returnPct)} between reconciliations (${fmtUsd(round.v0)} -> ${fmtUsd(round.v1)}). Post-mortem required before more risk is taken.`, { from: round.v0, to: round.v1 });
      if (id) incidents.push(id);
    }
  }

  // a venue with a drawdown guard that falls too far below its peak stops its strategy
  private checkGuards(incidents: string[]): void {
    const { store } = this.d;
    for (const v of store.state.liveVenues()) {
      const pct = v.guard?.maxDrawdownPct;
      if (!pct || !v.latest || v.peakUsd <= 0) continue;
      const dd = 1 - v.latest.totalUsd / v.peakUsd;
      if (dd >= pct) {
        const id = this.raise('critical', 'guard_tripped', `${v.id}@${v.peakUsd}`, `Guard tripped on "${v.id}": down ${fmtPct(dd)} from its peak of ${fmtUsd(v.peakUsd)} (limit ${fmtPct(pct)}). ${v.strategy ? `Strategy "${v.strategy}" is being stopped.` : ''}`, { venue: v.id, drawdown: dd, strategy: v.strategy });
        if (id) {
          incidents.push(id);
          void Promise.resolve(this.d.onGuardTripped?.(v, dd)).catch((e) => this.log.warn('guard callback failed', e));
        }
      }
    }
  }
}
