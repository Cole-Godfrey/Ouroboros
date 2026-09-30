// decides when the agent should think.
//
// thinking costs money, so the agent is not polled on a fixed loop. it sleeps
// until one of: the operator wrote, something broke, a timer it set for itself
// fires, a strategy died, or a heartbeat interval passes. triggers are coalesced
// into one episode, the briefing lists all of them.

import type { OuroConfig } from '../lib/config.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import { newId } from '../lib/ids.ts';
import type { Trigger, TriggerKind } from './briefing.ts';
import type { LogEvent } from './eventlog.ts';
import type { EndInfo, EpisodeRequest, EpisodeResult } from './runner.ts';
import type { StateStore } from './state.ts';

export interface SchedulerDeps {
  store: StateStore;
  config: () => OuroConfig;
  /** from the runner: can an episode start right now, and if not, why. */
  precheck: () => { ok: boolean; reason?: string };
  clock?: Clock;
  log?: Logger;
}

export class Scheduler {
  private d: SchedulerDeps;
  private clock: Clock;
  private log: Logger;
  private pending: Trigger[] = [];
  private lastEndedAt = 0;
  private failures = 0;
  private nextHeartbeatAt: number;
  private nextTier: 'cheap' | 'default' | undefined;
  private detach?: () => void;
  blockedReason?: string;

  constructor(deps: SchedulerDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? nullLogger;
    const st = deps.store.state;
    const last = st.episodes.at(-1);
    this.lastEndedAt = last?.endedAt ?? 0;
    const cfg = deps.config();
    // after a restart: wake soon, but not before the normal interval since the last episode
    this.nextHeartbeatAt = Math.max(this.clock() + 30_000, (last?.endedAt ?? 0) + cfg.schedule.heartbeatSec * 1000);
  }

  attach(): void {
    this.detach = this.d.store.onEvent((ev) => this.onEvent(ev));
  }

  close(): void {
    this.detach?.();
  }

  private push(kind: TriggerKind, detail?: string): void {
    const now = this.clock();
    if (this.pending.some((t) => t.kind === kind && t.detail === detail)) return;
    this.pending.push({ kind, detail, ts: now });
    if (this.pending.length > 50) this.pending.splice(0, this.pending.length - 50);
  }

  /** public so the daemon/CLI can poke the agent. */
  poke(kind: TriggerKind, detail?: string): void {
    this.push(kind, detail);
  }

  private onEvent(ev: LogEvent): void {
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'inbox.item':
        if (d.from === 'operator') this.push('operator', d.title);
        break;
      case 'inbox.reply':
        if (d.by === 'operator') this.push('operator', `reply to #${d.id}: ${String(d.text).slice(0, 200)}`);
        break;
      case 'incident':
        if (d.severity === 'warn' || d.severity === 'critical') this.push('incident', `${d.kind}: ${String(d.message).slice(0, 300)}`);
        break;
      case 'control':
        if (d.action === 'resume') this.push('resume', d.note);
        break;
      case 'selfmod.rollback':
        this.push('selfmod', `rolled back ${String(d.from).slice(0, 10)} → ${String(d.to).slice(0, 10)}: ${d.reason}`);
        break;
      case 'strategy.exit':
        if (d.abnormal) this.push('strategy', `${d.name} exited (${d.detail})`);
        break;
      default:
        break;
    }
  }

  // after failures wait longer between episodes (doubling, capped at 30 minutes) so a broken setup does not burn budget
  private backoffMs(): number {
    if (!this.failures) return 0;
    const cfg = this.d.config();
    return Math.min(30 * 60_000, cfg.schedule.minGapSec * 1000 * 2 ** this.failures);
  }

  /** called every few seconds by the daemon. returns a request when an episode should start now. */
  // called every few seconds. gathers every reason to wake, applies the pause, gap and budget checks,
  // and returns one coalesced episode request when it is time.
  tick(now = this.clock()): EpisodeRequest | undefined {
    this.d.store.sync(); // pick up anything the CLI appended directly to the log
    const st = this.d.store.state;
    const cfg = this.d.config();
    if (st.control.paused || st.control.halted) {
      this.blockedReason = st.control.halted ? 'halted by operator' : 'paused by operator';
      return undefined;
    }
    if (st.currentEpisode) return undefined;

    const triggers = [...this.pending];
    const dueWakes = st.pendingWakes().filter((w) => w.at <= now);
    for (const w of dueWakes) triggers.push({ kind: 'timer', detail: w.reason, ts: w.at });
    if (now >= this.nextHeartbeatAt) triggers.push({ kind: 'heartbeat', ts: this.nextHeartbeatAt });
    // the very first episode always runs, even with nothing else pending
    const genesisDone = st.episodes.some((e) => e.reason === 'genesis' && e.outcome === 'completed');
    if (!genesisDone) triggers.unshift({ kind: 'genesis', ts: now });
    if (!triggers.length) return undefined;

    // operator messages and incidents skip the normal minimum gap
    const urgent = triggers.some((t) => t.kind === 'operator' || t.kind === 'incident');
    const gapMs = Math.max(urgent ? 10_000 : cfg.schedule.minGapSec * 1000, this.backoffMs());
    if (now - this.lastEndedAt < gapMs) return undefined;

    const pre = this.d.precheck();
    this.blockedReason = pre.ok ? undefined : pre.reason;
    if (!pre.ok) return undefined;

    // start: drain what we are about to hand over
    this.pending = [];
    for (const w of dueWakes) this.d.store.append('wake.done', { id: w.id });
    const tierWanted = dueWakes.find((w) => w.tier)?.tier ?? this.nextTier;
    // urgent and first-boot episodes always use the main model, routine wakes may use the cheap tier
    const tier: 'cheap' | 'default' = urgent || triggers.some((t) => t.kind === 'genesis') ? 'default' : (tierWanted ?? 'default');
    this.nextTier = undefined;
    // an episode counts as the heartbeat
    this.nextHeartbeatAt = Number.POSITIVE_INFINITY;
    return { triggers: this.order(triggers), tier };
  }

  // most important trigger first, so the briefing leads with what matters
  private order(ts: Trigger[]): Trigger[] {
    const rank: Record<string, number> = { genesis: 0, operator: 1, incident: 2, selfmod: 3, strategy: 4, resume: 5, timer: 6, budget: 7, manual: 8, heartbeat: 9 };
    return [...ts].sort((a, b) => (rank[a.kind] ?? 99) - (rank[b.kind] ?? 99) || a.ts - b.ts);
  }

  // after an episode: count failures for backoff and book the next wake-up the agent asked for
  onEpisodeEnd(result: EpisodeResult, end?: EndInfo): void {
    const now = this.clock();
    const cfg = this.d.config();
    this.lastEndedAt = now;
    if (result.outcome === 'skipped') {
      this.nextHeartbeatAt = now + cfg.schedule.heartbeatSec * 1000;
      return;
    }
    if (result.outcome === 'error' || result.outcome === 'timeout' || result.outcome === 'stalled') this.failures++;
    else this.failures = 0;
    const requested = end?.nextWakeMinutes;
    if (end?.tier) this.nextTier = end.tier;
    // the agent's chosen time is clamped to the allowed range and stored as a wake request so it survives restarts.
    // the heartbeat stays as a safety net at the maximum interval.
    if (requested) {
      // the agent's chosen wake-up is persisted (survives restarts), the heartbeat stays as a safety net at the maximum interval
      const sec = Math.min(cfg.schedule.heartbeatMaxSec, Math.max(cfg.schedule.heartbeatMinSec, requested * 60));
      this.nextHeartbeatAt = now + Math.max(cfg.schedule.heartbeatMaxSec * 1000, this.backoffMs());
      this.d.store.append('wake.request', { id: newId('wk'), at: now + Math.max(sec * 1000, this.backoffMs()), reason: end?.reason ?? 'requested at episode end', by: 'agent', tier: end?.tier });
    } else {
      this.nextHeartbeatAt = now + Math.max(cfg.schedule.heartbeatSec * 1000, this.backoffMs());
    }
    this.log.debug('scheduler updated', { failures: this.failures, nextHeartbeatIn: this.nextHeartbeatAt - now });
  }

  status(now = this.clock()): { pending: Trigger[]; nextHeartbeatAt: number | null; failures: number; blockedReason?: string } {
    return { pending: [...this.pending], nextHeartbeatAt: Number.isFinite(this.nextHeartbeatAt) ? this.nextHeartbeatAt : null, failures: this.failures, blockedReason: this.blockedReason };
  }
}
