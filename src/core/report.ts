// daily reports come from recorded facts and need neither model calls nor network access.
import fs from 'node:fs';
import path from 'node:path';
import { DAY, systemClock, type Clock } from '../lib/clock.ts';
import { readJson, writeFileAtomic, writeJson, withLockSync } from '../lib/fsx.ts';
import type { Paths } from '../lib/paths.ts';
import { globalRedactor } from '../lib/redact.ts';
import { roundUsd } from '../lib/money.ts';
import type { LogEvent } from './eventlog.ts';
import { State, type StateStore } from './state.ts';

export const utcDayStart = (ts: number): number => Math.floor(ts / DAY) * DAY;
const iso = (ts: number) => new Date(ts).toISOString();
const dollars = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

export interface StatusReport {
  date: string;
  from: number;
  asOf: number;
  generatedAt: number;
  complete: boolean;
  revision?: number;
  sourceSeq?: number;
  text: string;
  short: string;
}

// a transfer discovered after midnight still belongs to the day it landed.
function reportTime(ev: LogEvent): number {
  if (['capital.in', 'capital.out', 'income', 'inflow.unclassified', 'inflow.resolve'].includes(ev.type) && Number.isFinite(ev.data?.at)) return ev.data.at;
  return ev.ts;
}

function transfersCovered(events: LogEvent[], end: number): boolean {
  const state = new State();
  for (const ev of events) if (ev.ts < end) state.apply(ev);
  return state.liveVenues().filter((v) => v.enabled && v.hasFlows && v.registeredAt < end).every((v) =>
    events.some((ev) => ev.type === 'venue.flows.scan' && ev.data.venue === v.id && ev.ts >= end && ev.data.since < end && ev.data.through >= end));
}

/** rebuild the state at the cutoff so a late restart cannot leak tomorrow's activity into yesterday. */
export function buildReport(events: LogEvent[], from: number, asOf: number, generatedAt: number, complete: boolean): StatusReport {
  const state = new State();
  const activity: LogEvent[] = [];
  let openingNav: number | undefined;
  let model = 'not recorded yet';
  const strategies = new Map<string, boolean>();
  let paperTrades = 0;
  let liveTrades = 0;
  for (const ev of events) {
    const at = reportTime(ev);
    if (at >= asOf) continue;
    state.apply(ev);
    if (ev.type === 'model.set') model = `${ev.data.provider}/${ev.data.model}`;
    if (ev.type === 'strategy.start') strategies.set(ev.data.name, true);
    if (ev.type === 'strategy.stop' || ev.type === 'strategy.exit') strategies.set(ev.data.name, false);
    if (ev.ts < from && ev.type === 'nav') openingNav = state.metrics(ev.ts).navUsd;
    if (at >= from) {
      activity.push(ev);
      if (ev.type === 'trade') {
        if (state.venues.get(ev.data.venue)?.kind === 'paper' || ev.data.venue === 'paper') paperTrades++;
        else liveTrades++;
      }
    }
  }
  const metrics = state.metrics(asOf);
  const count = (type: string) => activity.filter((ev) => ev.type === type).length;
  const sum = (type: string) => roundUsd(activity.filter((ev) => ev.type === type).reduce((n, ev) => n + (Number(type === 'llm.usage' ? ev.data.costUsd : ev.data.usd) || 0), 0));
  const episodes = activity.filter((ev) => ev.type === 'episode.end');
  const failed = episodes.filter((ev) => ['error', 'timeout', 'stalled'].includes(ev.data.outcome)).length;
  const lastNav = state.navSeries.at(-1);
  const mode = state.control.halted ? 'halted' : state.control.paused ? 'paused' : state.currentEpisode ? 'thinking' : 'idle';
  const date = iso(from).slice(0, 10);
  const changes: string[] = [];
  const modelChanges = activity.filter((ev) => ev.type === 'model.set');
  if (modelChanges.length) changes.push(`Model changes: ${modelChanges.length}. Latest: ${model}.`);
  if (count('venue.register')) changes.push(`Venues added or updated: ${count('venue.register')}.`);
  if (count('strategy.start') || count('strategy.exit')) changes.push(`Strategy starts: ${count('strategy.start')}. Exits: ${count('strategy.exit')}.`);
  if (count('selfmod.promote') || count('selfmod.rollback')) changes.push(`Harness releases promoted: ${count('selfmod.promote')}. Rollbacks: ${count('selfmod.rollback')}.`);
  if (count('incident')) changes.push(`New incidents: ${count('incident')}.`);
  const valuation = lastNav ? `${dollars(metrics.navUsd)} (last valued ${iso(lastNav.ts)})` : 'not yet valued';
  const text = [
    `Ouroboros | ${date} UTC${complete ? '' : ' | interim'}`,
    `Period: ${iso(from)} to ${iso(asOf)} (exclusive).`,
    `Status at cutoff: ${mode}. Model: ${model}.`,
    `NAV: ${valuation}.`,
    `Lifetime P&L: ${lastNav ? dollars(metrics.pnlUsd) : 'unavailable'}${metrics.performanceProvisional ? ' (provisional)' : ''}. After operator subsidy: ${lastNav ? dollars(metrics.pnlAfterSubsidyUsd) : 'unavailable'}.`,
    `Contributions: ${dollars(metrics.contributedUsd)} total, ${dollars(metrics.withdrawnUsd)} withdrawn, ${dollars(metrics.netContributedUsd)} net. Unresolved inflows: ${state.unclassifiedInflows().length} (${dollars(metrics.unclassifiedUsd)}).`,
    `Period NAV change: ${openingNav !== undefined && lastNav ? dollars(metrics.navUsd - openingNav) : 'no opening valuation'}. Deposits: ${dollars(sum('capital.in'))}. Withdrawals: ${dollars(sum('capital.out'))}.`,
    `Inference cost: ${dollars(sum('llm.usage'))}. Trades: ${paperTrades} paper, ${liveTrades} live. Episodes finished: ${episodes.length} (${failed} failed).`,
    `Venues: ${metrics.venues}. Strategies last recorded running: ${[...strategies.values()].filter(Boolean).length}. Open incidents: ${metrics.openIncidents}. Open inbox items: ${metrics.openInbox}.`,
    ...(metrics.staleVenues.length || metrics.unpricedAssets.length ? [`Valuation gaps: ${metrics.staleVenues.length} stale venues, ${metrics.unpricedAssets.length} unpriced assets.`] : []),
    '',
    'What changed:',
    ...(changes.length ? changes.map((s) => `- ${s}`) : ['- No new developments recorded.']),
  ].join('\n');
  // use only ASCII and cap length so the compact report fits a standard X post.
  const short = [
    `Ouroboros | ${date} UTC${complete ? '' : ' (interim)'}`,
    `${mode}. NAV ${lastNav ? dollars(metrics.navUsd) : 'unvalued'}. P&L ${lastNav ? dollars(metrics.pnlUsd) : 'n/a'}${metrics.performanceProvisional ? ' provisional' : ''}.`,
    `Contrib ${dollars(metrics.netContributedUsd)} net. Trades ${paperTrades} paper/${liveTrades} live. Unresolved ${dollars(metrics.unclassifiedUsd)}.`,
    `Valued ${lastNav ? iso(lastNav.ts).slice(0, 16) + 'Z' : 'never'}. Inference ${dollars(sum('llm.usage'))}.`,
    ...(metrics.staleVenues.length || metrics.unpricedAssets.length ? ['Valuation incomplete.'] : []),
  ].join('\n').slice(0, 280);
  return globalRedactor.redactValue({ date, from, asOf, generatedAt, complete, text, short });
}

export class DailyReports {
  private timer?: NodeJS.Timeout;
  private clock: Clock;
  private paths: Paths;
  private store: StateStore;
  constructor(paths: Paths, store: StateStore, clock: Clock = systemClock) {
    this.paths = paths;
    this.store = store;
    this.clock = clock;
  }

  /** archive the latest completed UTC day, including after a sleeping VM or daemon restart. */
  generateDue(): StatusReport | undefined {
    const now = this.clock();
    const end = utcDayStart(now);
    const dir = path.join(this.paths.home, 'reports');
    // cli and daemon can request the same day together. late ledger facts may revise it.
    return withLockSync(path.join(this.paths.run, 'report.lock'), () => {
      const events = this.store.log.readAll();
      const genesis = events.find((ev) => ev.type === 'genesis');
      if (!genesis || genesis.ts >= end) return undefined;
      const retroactive = events.filter((ev) => reportTime(ev) < ev.ts);
      const archive = (cutoff: number): StatusReport | undefined => {
        const file = path.join(dir, `${iso(cutoff - DAY).slice(0, 10)}.json`);
        let report = readJson<StatusReport | undefined>(file, undefined);
        const changed = !report || events.some((ev) => ev.seq > (report!.sourceSeq ?? 0) && reportTime(ev) < cutoff);
        if (changed && !transfersCovered(events, cutoff)) return report;
        // only replay an archive when a newly appended fact belongs before its cutoff.
        if (changed) {
          const rebuilt = buildReport(events, cutoff - DAY, cutoff, now, true);
          if (!report || report.text !== rebuilt.text || report.short !== rebuilt.short || !report.complete) {
            report = { ...rebuilt, revision: (report?.revision ?? 0) + 1, sourceSeq: events.at(-1)?.seq ?? 0 };
            writeJson(file, report, 0o600);
          }
        }
        if (!report) return undefined;
        // repair the text and latest pointer if an earlier write was interrupted.
        const textFile = path.join(dir, `${report.date}.txt`);
        if (!fs.existsSync(textFile) || fs.readFileSync(textFile, 'utf8') !== report.text + '\n') writeFileAtomic(textFile, report.text + '\n', 0o600);
        const latestFile = path.join(dir, 'latest.json');
        const latest = readJson<StatusReport | undefined>(latestFile, undefined);
        if (!latest || latest.asOf < report.asOf || (latest.asOf === report.asOf && latest.revision !== report.revision) || !fs.existsSync(path.join(dir, 'latest.txt'))) {
          writeFileAtomic(path.join(dir, 'latest.txt'), report.text + '\n', 0o600);
          writeJson(latestFile, report, 0o600);
        }
        return report;
      };
      // older archives can receive transfers even after a newer day has closed.
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir).filter((s) => /^\d{4}-\d{2}-\d{2}\.json$/.test(s)).sort()) {
          const cutoff = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`) + DAY;
          if (!Number.isFinite(cutoff) || cutoff >= end) continue;
          const old = readJson<StatusReport | undefined>(path.join(dir, name), undefined);
          if (!old?.sourceSeq || retroactive.some((ev) => ev.seq > old.sourceSeq! && reportTime(ev) < cutoff)) archive(cutoff);
        }
      }
      return archive(end);
    });
  }

  latest(now = false): StatusReport {
    if (!now) {
      const report = this.generateDue();
      if (report) return globalRedactor.redactValue(report);
    }
    const ts = this.clock();
    const end = utcDayStart(ts);
    const events = this.store.log.readAll();
    if (!now && events.some((ev) => ev.type === 'genesis' && ev.ts < end)) return buildReport(events, end - DAY, end, ts, false);
    // a first-day install still has something useful to print before its first midnight.
    return buildReport(events, end, ts, ts, false);
  }

  start(onError: (error: unknown) => void): void {
    this.close();
    const tick = () => {
      try { this.generateDue(); } catch (error) { onError(error); }
      // recheck the wall clock each minute for sleep, clock corrections and failed writes.
      const now = this.clock();
      this.timer = setTimeout(tick, Math.min(60_000, utcDayStart(now) + DAY - now));
      this.timer.unref();
    };
    tick();
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
