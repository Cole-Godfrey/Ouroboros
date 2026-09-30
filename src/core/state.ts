// State is a pure fold over the event log. Nothing here is stored separately:
// if the log is intact, the state (NAV, P&L, budgets, inbox, incidents...) is
// exactly reproducible. That is what makes the ledger trustworthy.

import { DAY, MINUTE, localDate } from '../lib/clock.ts';
import { roundUsd } from '../lib/money.ts';
import { EventLog, type LogEvent } from './eventlog.ts';

// ---------------------------------------------------------------- types

export interface Holding {
  asset: string;
  qty: number;
  priceUsd?: number;
  valueUsd: number;
}

export interface VenueState {
  id: string;
  kind?: string;
  module?: string;
  description?: string;
  strategy?: string;
  secrets: string[];
  guard?: { maxDrawdownPct?: number };
  enabled: boolean;
  registeredAt: number;
  latest?: { ts: number; totalUsd: number; holdings: Holding[]; unpriced: string[] };
  peakUsd: number;
  lastError?: { ts: number; message: string };
  removed?: boolean;
}

export interface NavPoint {
  ts: number;
  usd: number;
  stale?: string[];
}

export interface Flow {
  ts: number;
  usd: number;
  kind: 'in' | 'out';
  venue?: string;
  note?: string;
  by?: string;
  ref?: string;
}

export interface Inflow {
  id: string;
  ts: number;
  venue: string;
  usd: number;
  asset?: string;
  from?: string;
  ref?: string;
  resolved?: { as: 'capital' | 'income' | 'ignore'; ts: number; by: string };
}

export interface LlmEntry {
  ts: number;
  usd: number;
  funding: 'sponsor' | 'capital';
  model: string;
  episode?: string;
}

export interface InboxReply {
  ts: number;
  by: 'operator' | 'agent' | 'system';
  text: string;
  channel?: string;
}

export interface InboxItem {
  id: string;
  ts: number;
  kind: 'request' | 'info' | 'alert' | 'question' | 'message';
  from: 'agent' | 'system' | 'operator';
  title: string;
  body: string;
  steps?: string[];
  secrets?: string[];
  urgency: 'low' | 'normal' | 'high';
  blocking?: string;
  status: 'open' | 'answered' | 'done' | 'dismissed';
  updatedAt: number;
  replies: InboxReply[];
  ackedAt?: number;
  pushedAt?: number;
  /** Over the daily non-urgent cap: recorded, but not pushed to the operator's phone. */
  throttled?: boolean;
}

export interface Incident {
  id: string;
  ts: number;
  severity: 'info' | 'warn' | 'critical';
  kind: string;
  message: string;
  data?: unknown;
  resolvedAt?: number;
  resolution?: string;
}

export interface EpisodeRec {
  id: string;
  startedAt: number;
  endedAt?: number;
  reason: string;
  model?: string;
  outcome?: string;
  costUsd: number;
  turns?: number;
  toolCalls?: number;
  handoff?: string;
  error?: string;
}

export interface WakeRequest {
  id: string;
  at: number;
  reason: string;
  by: string;
  tier?: 'cheap' | 'default';
  done?: boolean;
}

export interface SelfmodRec {
  id: string;
  ts: number;
  kind: 'propose' | 'gate' | 'promote' | 'confirm' | 'rollback' | 'reject';
  sha?: string;
  prev?: string;
  ok?: boolean;
  message?: string;
  risk?: 'normal' | 'high';
  files?: string[];
  reason?: string;
}

export interface JournalRec {
  ts: number;
  kind: string;
  text: string;
  tags?: string[];
}

export interface TradeRec {
  ts: number;
  venue: string;
  market: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  feeUsd: number;
  pnlUsd?: number;
  strategy?: string;
  memo?: string;
}

export interface IndexPoint {
  ts: number;
  nav: number;
  index: number;
}

export interface Metrics {
  ts: number;
  navUsd: number;
  contributedUsd: number;
  withdrawnUsd: number;
  netContributedUsd: number;
  pnlUsd: number;
  pnlPct: number | null;
  subsidyUsd: number;
  pnlAfterSubsidyUsd: number;
  index: number;
  /** log growth per day over trailing windows (undefined when the history is too short) */
  growth: { d1?: number; d7?: number; d30?: number; all?: number };
  doublingDays?: number;
  maxDrawdown: number;
  drawdown: number;
  staleVenues: string[];
  unpricedAssets: string[];
  unclassifiedUsd: number;
  burnPerDayUsd: number;
  runwayDays?: number;
  openIncidents: number;
  openInbox: number;
  venues: number;
  episodes: number;
}

const MAX_LLM = 20_000;
const MAX_TRADES = 5_000;
const MAX_EPISODES = 500;
const MAX_JOURNAL = 500;
const MAX_SELFMOD = 300;

// ---------------------------------------------------------------- state

export class State {
  head = { seq: 0, hash: '' };
  version = 0;
  genesis?: { ts: number; version: string; charterSha: string };

  flows: Flow[] = [];
  contributedUsd = 0;
  withdrawnUsd = 0;
  venues = new Map<string, VenueState>();
  navSeries: NavPoint[] = [];
  inflows = new Map<string, Inflow>();
  expenses = { byCategory: {} as Record<string, { capitalUsd: number; sponsorUsd: number }>, capitalUsd: 0, sponsorUsd: 0 };
  income = { byCategory: {} as Record<string, number>, usd: 0 };
  trades: TradeRec[] = [];
  tradeCount = 0;
  llm = {
    entries: [] as LlmEntry[],
    sponsorUsd: 0,
    capitalUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: {} as Record<string, { usd: number; calls: number }>,
  };

  inbox = new Map<string, InboxItem>();
  incidents = new Map<string, Incident>();
  episodes: EpisodeRec[] = [];
  currentEpisode?: EpisodeRec;
  wakes: WakeRequest[] = [];
  control = { paused: false, halted: false, since: 0, by: '' };
  selfmod: {
    current?: string;
    lkg?: string;
    probation?: { sha: string; until: number; id: string };
    history: SelfmodRec[];
    bad: string[];
  } = { history: [], bad: [] };
  journal: JournalRec[] = [];
  /** Limits the operator set through the CLI; the agent cannot raise them by editing config.json. */
  operatorLimits: { sponsorDailyUsd?: number; sponsorTotalUsd?: number; perEpisodeUsd?: number } = {};

  private indexCache?: { version: number; points: IndexPoint[] };

  apply(ev: LogEvent): void {
    this.head = { seq: ev.seq, hash: ev.hash };
    this.version++;
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'genesis':
        this.genesis ??= { ts: ev.ts, version: d.version, charterSha: d.charterSha };
        break;

      case 'capital.in':
      case 'capital.out': {
        const kind = ev.type === 'capital.in' ? 'in' : 'out';
        const usd = Number(d.usd) || 0;
        this.flows.push({ ts: d.at ?? ev.ts, usd, kind, venue: d.venue, note: d.note, by: d.by, ref: d.ref });
        if (kind === 'in') this.contributedUsd = roundUsd(this.contributedUsd + usd);
        else this.withdrawnUsd = roundUsd(this.withdrawnUsd + usd);
        break;
      }

      case 'venue.register': {
        const prev = this.venues.get(d.id);
        this.venues.set(d.id, {
          id: d.id,
          kind: d.kind ?? prev?.kind,
          module: d.module ?? prev?.module,
          description: d.description ?? prev?.description,
          strategy: d.strategy ?? prev?.strategy,
          secrets: d.secrets ?? prev?.secrets ?? [],
          guard: d.guard ?? prev?.guard,
          enabled: d.enabled ?? prev?.enabled ?? true,
          registeredAt: prev?.registeredAt ?? ev.ts,
          latest: prev?.latest,
          peakUsd: prev?.peakUsd ?? 0,
          lastError: prev?.lastError,
        });
        break;
      }
      case 'venue.remove': {
        const v = this.venues.get(d.id);
        if (v) v.removed = true;
        break;
      }
      case 'venue.error': {
        const v = this.venues.get(d.venue);
        if (v) v.lastError = { ts: ev.ts, message: String(d.message ?? '') };
        break;
      }
      case 'valuation': {
        let v = this.venues.get(d.venue);
        if (!v) {
          v = { id: d.venue, kind: 'manual', secrets: [], enabled: true, registeredAt: ev.ts, peakUsd: 0 };
          this.venues.set(d.venue, v);
        }
        v.removed = false;
        v.latest = { ts: ev.ts, totalUsd: Number(d.totalUsd) || 0, holdings: d.holdings ?? [], unpriced: d.unpriced ?? [] };
        v.peakUsd = Math.max(v.peakUsd, v.latest.totalUsd);
        v.lastError = undefined;
        break;
      }
      case 'nav':
        this.navSeries.push({ ts: ev.ts, usd: Number(d.usd) || 0, stale: d.stale });
        break;

      case 'inflow.unclassified':
        this.inflows.set(d.id, { id: d.id, ts: ev.ts, venue: d.venue, usd: d.usd, asset: d.asset, from: d.from, ref: d.ref });
        break;
      case 'inflow.resolve': {
        const f = this.inflows.get(d.id);
        if (f) f.resolved = { as: d.as, ts: ev.ts, by: d.by ?? 'operator' };
        break;
      }

      case 'expense': {
        const usd = Number(d.usd) || 0;
        const cat = (this.expenses.byCategory[d.category ?? 'other'] ??= { capitalUsd: 0, sponsorUsd: 0 });
        if (d.funding === 'sponsor') {
          cat.sponsorUsd = roundUsd(cat.sponsorUsd + usd);
          this.expenses.sponsorUsd = roundUsd(this.expenses.sponsorUsd + usd);
        } else {
          cat.capitalUsd = roundUsd(cat.capitalUsd + usd);
          this.expenses.capitalUsd = roundUsd(this.expenses.capitalUsd + usd);
        }
        break;
      }
      case 'income': {
        const usd = Number(d.usd) || 0;
        const c = d.category ?? 'other';
        this.income.byCategory[c] = roundUsd((this.income.byCategory[c] ?? 0) + usd);
        this.income.usd = roundUsd(this.income.usd + usd);
        break;
      }
      case 'trade': {
        this.tradeCount++;
        this.trades.push({
          ts: ev.ts,
          venue: d.venue,
          market: d.market,
          side: d.side,
          qty: d.qty,
          price: d.price,
          feeUsd: d.feeUsd ?? 0,
          pnlUsd: d.pnlUsd,
          strategy: d.strategy,
          memo: d.memo,
        });
        if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
        break;
      }
      case 'llm.usage': {
        const usd = Number(d.costUsd) || 0;
        const funding: 'sponsor' | 'capital' = d.funding === 'capital' ? 'capital' : 'sponsor';
        this.llm.entries.push({ ts: ev.ts, usd, funding, model: d.model ?? 'unknown', episode: d.episode });
        if (this.llm.entries.length > MAX_LLM) this.llm.entries.splice(0, this.llm.entries.length - MAX_LLM);
        if (funding === 'sponsor') this.llm.sponsorUsd = roundUsd(this.llm.sponsorUsd + usd);
        else this.llm.capitalUsd = roundUsd(this.llm.capitalUsd + usd);
        this.llm.tokens.input += d.input ?? 0;
        this.llm.tokens.output += d.output ?? 0;
        this.llm.tokens.cacheRead += d.cacheRead ?? 0;
        this.llm.tokens.cacheWrite += d.cacheWrite ?? 0;
        const m = (this.llm.byModel[d.model ?? 'unknown'] ??= { usd: 0, calls: 0 });
        m.usd = roundUsd(m.usd + usd);
        m.calls++;
        break;
      }

      case 'inbox.item':
        this.inbox.set(d.id, {
          id: d.id,
          ts: ev.ts,
          kind: d.kind,
          from: d.from,
          title: d.title,
          body: d.body ?? '',
          steps: d.steps,
          secrets: d.secrets,
          urgency: d.urgency ?? 'normal',
          blocking: d.blocking,
          status: 'open',
          updatedAt: ev.ts,
          replies: [],
          throttled: d.throttled,
        });
        break;
      case 'inbox.reply': {
        const it = this.inbox.get(d.id);
        if (it) {
          it.replies.push({ ts: ev.ts, by: d.by, text: d.text, channel: d.channel });
          it.updatedAt = ev.ts;
          if (d.by === 'operator' && it.status === 'open' && it.from !== 'operator') it.status = 'answered';
        }
        break;
      }
      case 'inbox.status': {
        const it = this.inbox.get(d.id);
        if (it) {
          it.status = d.status;
          it.updatedAt = ev.ts;
        }
        break;
      }
      case 'inbox.ack': {
        for (const id of d.ids ?? []) {
          const it = this.inbox.get(id);
          if (it) it.ackedAt = ev.ts;
        }
        break;
      }
      case 'inbox.pushed': {
        const it = this.inbox.get(d.id);
        if (it) it.pushedAt = ev.ts;
        break;
      }

      case 'incident':
        this.incidents.set(d.id, { id: d.id, ts: ev.ts, severity: d.severity, kind: d.kind, message: d.message, data: d.data });
        break;
      case 'incident.resolve': {
        const inc = this.incidents.get(d.id);
        if (inc) {
          inc.resolvedAt = ev.ts;
          inc.resolution = d.note;
        }
        break;
      }

      case 'episode.start': {
        const rec: EpisodeRec = { id: d.id, startedAt: ev.ts, reason: d.reason, model: d.model, costUsd: 0 };
        this.currentEpisode = rec;
        break;
      }
      case 'episode.end': {
        const rec = this.currentEpisode && this.currentEpisode.id === d.id ? this.currentEpisode : ({ id: d.id, startedAt: ev.ts - (d.durationMs ?? 0), reason: 'unknown', costUsd: 0 } as EpisodeRec);
        rec.endedAt = ev.ts;
        rec.outcome = d.outcome;
        rec.costUsd = d.costUsd ?? 0;
        rec.turns = d.turns;
        rec.toolCalls = d.toolCalls;
        rec.handoff = d.handoff;
        rec.error = d.error;
        this.episodes.push(rec);
        if (this.episodes.length > MAX_EPISODES) this.episodes.splice(0, this.episodes.length - MAX_EPISODES);
        if (this.currentEpisode?.id === d.id) this.currentEpisode = undefined;
        break;
      }
      case 'wake.request':
        this.wakes.push({ id: d.id, at: d.at, reason: d.reason, by: d.by, tier: d.tier });
        if (this.wakes.length > 200) this.wakes = this.wakes.filter((w) => !w.done).slice(-100);
        break;
      case 'wake.done': {
        const w = this.wakes.find((x) => x.id === d.id);
        if (w) w.done = true;
        break;
      }

      case 'control':
        if (d.action === 'pause') this.control = { paused: true, halted: false, since: ev.ts, by: d.by ?? '' };
        else if (d.action === 'resume') this.control = { paused: false, halted: false, since: ev.ts, by: d.by ?? '' };
        else if (d.action === 'halt' || d.action === 'kill') this.control = { paused: true, halted: true, since: ev.ts, by: d.by ?? '' };
        break;

      case 'selfmod.propose':
      case 'selfmod.gate':
      case 'selfmod.promote':
      case 'selfmod.confirm':
      case 'selfmod.rollback':
      case 'selfmod.reject': {
        const kind = ev.type.slice('selfmod.'.length) as SelfmodRec['kind'];
        this.selfmod.history.push({
          id: d.id,
          ts: ev.ts,
          kind,
          sha: d.sha,
          prev: d.prev,
          ok: d.ok,
          message: d.message,
          risk: d.risk,
          files: d.files,
          reason: d.reason,
        });
        if (this.selfmod.history.length > MAX_SELFMOD) this.selfmod.history.splice(0, this.selfmod.history.length - MAX_SELFMOD);
        if (kind === 'promote') {
          this.selfmod.current = d.sha;
          this.selfmod.probation = { sha: d.sha, until: d.probationUntil ?? ev.ts, id: d.id };
        } else if (kind === 'confirm') {
          this.selfmod.lkg = d.sha;
          if (this.selfmod.probation?.sha === d.sha) this.selfmod.probation = undefined;
        } else if (kind === 'rollback') {
          this.selfmod.current = d.to;
          this.selfmod.probation = undefined;
          if (d.from && !this.selfmod.bad.includes(d.from)) this.selfmod.bad.push(d.from);
        }
        break;
      }
      case 'selfmod.baseline':
        this.selfmod.current = d.sha;
        this.selfmod.lkg = d.sha;
        break;

      case 'operator.limits':
        for (const k of ['sponsorDailyUsd', 'sponsorTotalUsd', 'perEpisodeUsd'] as const) if (typeof d[k] === 'number') this.operatorLimits[k] = d[k];
        break;

      case 'journal':
        this.journal.push({ ts: ev.ts, kind: d.kind ?? 'observation', text: d.text, tags: d.tags });
        if (this.journal.length > MAX_JOURNAL) this.journal.splice(0, this.journal.length - MAX_JOURNAL);
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------- derived views

  liveVenues(): VenueState[] {
    return [...this.venues.values()].filter((v) => !v.removed);
  }

  /** Sum of the latest valuation of every live venue. Paper (simulated) venues never count. */
  liveNavUsd(): number {
    let sum = 0;
    for (const v of this.liveVenues()) if (v.kind !== 'paper') sum += v.latest?.totalUsd ?? 0;
    return roundUsd(sum);
  }

  netContributedUsd(): number {
    return roundUsd(this.contributedUsd - this.withdrawnUsd);
  }

  subsidyUsd(): number {
    return roundUsd(this.expenses.sponsorUsd + this.llm.sponsorUsd);
  }

  /** Chain-linked, flow-adjusted (Modified Dietz) wealth index: deposits do not look like profit. */
  wealthIndex(): IndexPoint[] {
    if (this.indexCache && this.indexCache.version === this.version) return this.indexCache.points;
    const pts = this.navSeries;
    const out: IndexPoint[] = [];
    if (pts.length) {
      const flows = [...this.flows].sort((a, b) => a.ts - b.ts);
      let index = 1;
      out.push({ ts: pts[0].ts, nav: pts[0].usd, index });
      let fi = 0;
      while (fi < flows.length && flows[fi].ts <= pts[0].ts) fi++;
      for (let i = 1; i < pts.length; i++) {
        const t0 = pts[i - 1].ts;
        const t1 = pts[i].ts;
        const v0 = pts[i - 1].usd;
        const v1 = pts[i].usd;
        let F = 0;
        let wF = 0;
        while (fi < flows.length && flows[fi].ts <= t1) {
          const f = flows[fi];
          const amt = f.kind === 'in' ? f.usd : -f.usd;
          F += amt;
          wF += (t1 > t0 ? (t1 - Math.max(f.ts, t0)) / (t1 - t0) : 0) * amt;
          fi++;
        }
        const denom = v0 + wF;
        let r = 0;
        if (denom > 1e-9) r = (v1 - v0 - F) / denom;
        if (!Number.isFinite(r)) r = 0;
        if (r < -1) r = -1;
        index *= 1 + r;
        out.push({ ts: t1, nav: v1, index });
      }
    }
    this.indexCache = { version: this.version, points: out };
    return out;
  }

  /** Flow-adjusted return between the two most recent NAV points, plus the raw change and flows in between. */
  lastRound(): { t0: number; t1: number; v0: number; v1: number; flowUsd: number; returnPct: number } | undefined {
    const pts = this.navSeries;
    if (pts.length < 2) return undefined;
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    let flowUsd = 0;
    for (const f of this.flows) if (f.ts > a.ts && f.ts <= b.ts) flowUsd += f.kind === 'in' ? f.usd : -f.usd;
    const denom = a.usd;
    const ret = denom > 1e-9 ? (b.usd - a.usd - flowUsd) / denom : 0;
    return { t0: a.ts, t1: b.ts, v0: a.usd, v1: b.usd, flowUsd, returnPct: ret };
  }

  growthPerDay(windowMs: number | 'all'): number | undefined {
    const idx = this.wealthIndex();
    if (idx.length < 2) return undefined;
    const end = idx[idx.length - 1];
    let start = idx[0];
    if (windowMs !== 'all') {
      const startTs = end.ts - windowMs;
      for (const p of idx) {
        if (p.ts <= startTs) start = p;
        else break;
      }
    }
    const dt = end.ts - start.ts;
    if (dt < 30 * MINUTE || start.index <= 0 || end.index <= 0) return undefined;
    return Math.log(end.index / start.index) / (dt / DAY);
  }

  drawdown(): { max: number; current: number } {
    let peak = 0;
    let max = 0;
    let cur = 0;
    for (const p of this.wealthIndex()) {
      peak = Math.max(peak, p.index);
      cur = peak > 0 ? 1 - p.index / peak : 0;
      max = Math.max(max, cur);
    }
    return { max, current: cur };
  }

  /** Inference + other operating cost per day over the trailing week (or since first cost). */
  burnPerDayUsd(now: number): number {
    const from = now - 7 * DAY;
    const recent = this.llm.entries.filter((e) => e.ts >= from);
    if (!recent.length) return 0;
    const first = Math.max(recent[0].ts, from);
    const days = Math.max(1, (now - first) / DAY);
    const total = recent.reduce((s, e) => s + e.usd, 0);
    return roundUsd(total / days);
  }

  llmSpendUsd(opts: { dayKey?: string; tz?: string; funding?: 'sponsor' | 'capital' }): number {
    let sum = 0;
    for (const e of this.llm.entries) {
      if (opts.funding && e.funding !== opts.funding) continue;
      if (opts.dayKey && localDate(e.ts, opts.tz) !== opts.dayKey) continue;
      sum += e.usd;
    }
    return roundUsd(sum);
  }

  openInbox(): InboxItem[] {
    return [...this.inbox.values()].filter((i) => i.status === 'open' || i.status === 'answered');
  }

  /** Items the agent has not yet seen: operator messages and operator replies since its last ack. */
  unseenForAgent(): InboxItem[] {
    const out: InboxItem[] = [];
    for (const it of this.inbox.values()) {
      if (it.status === 'dismissed') continue;
      if (it.from === 'operator' && !it.ackedAt) out.push(it);
      else if (it.replies.some((r) => r.by === 'operator' && r.ts > (it.ackedAt ?? 0))) out.push(it);
    }
    return out;
  }

  openIncidents(): Incident[] {
    return [...this.incidents.values()].filter((i) => !i.resolvedAt);
  }

  pendingWakes(): WakeRequest[] {
    return this.wakes.filter((w) => !w.done).sort((a, b) => a.at - b.at);
  }

  unclassifiedInflows(): Inflow[] {
    return [...this.inflows.values()].filter((i) => !i.resolved);
  }

  metrics(now: number): Metrics {
    const nav = this.navSeries.length ? this.navSeries[this.navSeries.length - 1].usd : this.liveNavUsd();
    const net = this.netContributedUsd();
    const pnl = roundUsd(nav - net);
    const idx = this.wealthIndex();
    const dd = this.drawdown();
    const g = {
      d1: this.growthPerDay(DAY),
      d7: this.growthPerDay(7 * DAY),
      d30: this.growthPerDay(30 * DAY),
      all: this.growthPerDay('all'),
    };
    const gBest = g.d7 ?? g.all;
    const stale: string[] = [];
    const unpriced = new Set<string>();
    for (const v of this.liveVenues()) {
      if (!v.latest || (v.lastError && v.enabled)) stale.push(v.id);
      for (const a of v.latest?.unpriced ?? []) unpriced.add(`${v.id}:${a}`);
    }
    const burn = this.burnPerDayUsd(now);
    const capBurn = this.llm.entries.filter((e) => e.funding === 'capital' && e.ts >= now - 7 * DAY).reduce((s, e) => s + e.usd, 0) / 7;
    return {
      ts: now,
      navUsd: nav,
      contributedUsd: this.contributedUsd,
      withdrawnUsd: this.withdrawnUsd,
      netContributedUsd: net,
      pnlUsd: pnl,
      pnlPct: net > 0 ? pnl / net : null,
      subsidyUsd: this.subsidyUsd(),
      pnlAfterSubsidyUsd: roundUsd(pnl - this.subsidyUsd()),
      index: idx.length ? idx[idx.length - 1].index : 1,
      growth: g,
      doublingDays: gBest && gBest > 0 ? Math.LN2 / gBest : undefined,
      maxDrawdown: dd.max,
      drawdown: dd.current,
      staleVenues: stale,
      unpricedAssets: [...unpriced],
      unclassifiedUsd: roundUsd(this.unclassifiedInflows().reduce((s, i) => s + i.usd, 0)),
      burnPerDayUsd: burn,
      runwayDays: capBurn > 0 ? nav / capBurn : undefined,
      openIncidents: this.openIncidents().length,
      openInbox: this.openInbox().length,
      venues: this.liveVenues().length,
      episodes: this.episodes.length,
    };
  }
}

// ---------------------------------------------------------------- store

/** A State kept in sync with an EventLog, tolerant of other processes appending to the same file. */
export class StateStore {
  readonly log: EventLog;
  state = new State();
  private offset = 0;
  private listeners = new Set<(ev: LogEvent) => void>();

  constructor(log: EventLog) {
    this.log = log;
    this.sync();
  }

  /** Apply any events appended since the last sync (by us or another process). Returns how many. */
  sync(): number {
    const before = this.offset;
    const { events, offset } = this.log.readFrom(this.offset);
    if (offset < before) {
      // file shrank (rotated / replaced): rebuild from scratch
      this.state = new State();
      this.offset = 0;
      return this.sync();
    }
    for (const ev of events) {
      this.state.apply(ev);
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch {
          /* listener errors never break the ledger */
        }
      }
    }
    this.offset = offset;
    return events.length;
  }

  append<T>(type: string, data: T, opts: { ts?: number } = {}): LogEvent<T> {
    const ev = this.log.append(type, data, opts);
    this.sync();
    return ev;
  }

  onEvent(cb: (ev: LogEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
