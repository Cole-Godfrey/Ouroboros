// LLM cost accounting and the budget gate.
//
// Thinking is the agent's biggest running cost, and at $1 of capital it dwarfs
// everything else. Two funding modes:
//
//   sponsor  the operator pays for inference. It is tracked as "subsidy" and never
//            touches NAV, but a hard daily/total cap (set by the operator, ideally
//            also at the provider) stops runaway spend.
//   capital  the agent pays out of its own capital (prepaid credits are a venue, so
//            consumption shows up as a NAV decrease). Spend is capped at a % of NAV/day.
//
// The switch from sponsor to capital is the operator's decision.

import type { EffectiveBudget, Limits, OuroConfig } from '../lib/config.ts';
import { effectiveBudget } from '../lib/config.ts';
import { localDate, systemClock, type Clock } from '../lib/clock.ts';
import { roundUsd } from '../lib/money.ts';
import type { StateStore } from './state.ts';

export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens. Source: the Pi model catalog (Sept 2026). Editable in $OURO_HOME/pricing.json. */
export const DEFAULT_PRICING: Record<string, Pricing> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** Unknown models are billed at the most expensive known rate so spend is never under-counted. */
export const FALLBACK_PRICING: Pricing = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function priceFor(model: string, table: Record<string, Pricing>): Pricing {
  const m = model.toLowerCase().replace(/^anthropic\//, '');
  if (table[m]) return table[m];
  // dated variants: claude-haiku-4-5-20251001 -> claude-haiku-4-5
  const stripped = m.replace(/-\d{8}$/, '');
  if (table[stripped]) return table[stripped];
  return FALLBACK_PRICING;
}

export function costOf(model: string, u: Usage, table: Record<string, Pricing> = DEFAULT_PRICING): number {
  const p = priceFor(model, table);
  return roundUsd((u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6);
}

export interface BudgetStatus {
  mode: 'sponsor' | 'capital';
  dailyLimitUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  totalLimitUsd: number | null;
  spentTotalUsd: number;
  remainingTotalUsd: number | null;
  perEpisodeUsd: number;
  exhausted: boolean;
  reason?: string;
}

export interface MeterDeps {
  store: StateStore;
  config: () => OuroConfig;
  limits: () => Limits;
  pricing?: () => Record<string, Pricing>;
  clock?: Clock;
}

export class Meter {
  private d: MeterDeps;
  private clock: Clock;

  constructor(deps: MeterDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
  }

  budget(): EffectiveBudget {
    return effectiveBudget(this.d.config(), this.d.limits());
  }

  fundingSource(): 'sponsor' | 'capital' {
    return this.d.config().budget.mode;
  }

  cost(model: string, usage: Usage): number {
    return costOf(model, usage, this.d.pricing?.() ?? DEFAULT_PRICING);
  }

  /** Append an llm.usage event. `costUsd` overrides the computed cost (e.g. when the provider reported one). */
  record(u: { provider: string; model: string; usage: Usage; costUsd?: number; episode?: string; source: 'proxy' | 'pi' }): { costUsd: number; funding: 'sponsor' | 'capital' } {
    const funding = this.fundingSource();
    const costUsd = roundUsd(u.costUsd ?? this.cost(u.model, u.usage));
    this.d.store.append('llm.usage', {
      provider: u.provider,
      model: u.model,
      input: u.usage.input,
      output: u.usage.output,
      cacheRead: u.usage.cacheRead,
      cacheWrite: u.usage.cacheWrite,
      costUsd,
      funding,
      episode: u.episode,
      source: u.source,
    });
    return { costUsd, funding };
  }

  status(): BudgetStatus {
    const st = this.d.store;
    st.sync();
    const cfg = this.d.config();
    const b = this.budget();
    const day = localDate(this.clock(), cfg.operator.timezone);
    const funding = b.mode;
    const spentToday = st.state.llmSpendUsd({ dayKey: day, tz: cfg.operator.timezone });
    const spentTotal = st.state.llmSpendUsd({ funding });
    let dailyLimit = b.dailyUsd;
    if (b.mode === 'capital') {
      const nav = st.state.metrics(this.clock()).navUsd;
      dailyLimit = roundUsd(Math.max(0, nav) * (cfg.budget.capitalMaxDailyPctNav ?? 0.05));
    }
    const remainingToday = roundUsd(Math.max(0, dailyLimit - spentToday));
    const remainingTotal = b.totalUsd === null ? null : roundUsd(Math.max(0, b.totalUsd - spentTotal));
    let reason: string | undefined;
    if (remainingToday <= 0) reason = `daily ${b.mode} budget of $${dailyLimit.toFixed(2)} is spent`;
    else if (remainingTotal !== null && remainingTotal <= 0) reason = `total ${b.mode} budget of $${b.totalUsd!.toFixed(2)} is spent`;
    return {
      mode: b.mode,
      dailyLimitUsd: dailyLimit,
      spentTodayUsd: spentToday,
      remainingTodayUsd: remainingToday,
      totalLimitUsd: b.totalUsd,
      spentTotalUsd: spentTotal,
      remainingTotalUsd: remainingTotal,
      perEpisodeUsd: b.perEpisodeUsd,
      exhausted: !!reason,
      reason,
    };
  }

  /** Dollars the next episode may spend: the tightest of per-episode, daily-remaining and total-remaining. */
  episodeBudgetUsd(): number {
    const s = this.status();
    const caps = [s.perEpisodeUsd, s.remainingTodayUsd];
    if (s.remainingTotalUsd !== null) caps.push(s.remainingTotalUsd);
    return roundUsd(Math.max(0, Math.min(...caps)));
  }

  canStartEpisode(): { ok: boolean; reason?: string } {
    const s = this.status();
    if (s.exhausted) return { ok: false, reason: s.reason };
    if (this.episodeBudgetUsd() < 0.005) return { ok: false, reason: 'remaining budget too small to run an episode' };
    return { ok: true };
  }
}
