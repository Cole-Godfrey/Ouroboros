import { readJson, writeJson } from './fsx.ts';
import type { Paths } from './paths.ts';

export interface OuroConfig {
  operator: {
    name: string;
    /** e.g. "US-CA", "DE", "SG". The agent uses this to avoid restricted venues. */
    jurisdiction: string;
    /** IANA timezone; defines the "day" for budgets. */
    timezone: string;
    /** On-chain addresses that belong to the operator: inflows from these are capital injections. */
    addresses: string[];
  };
  llm: {
    /** Pi provider id, e.g. "anthropic", "openai", "openrouter". */
    provider: string;
    model: string;
    thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Used for routine, low-stakes episodes when the agent asks for a cheap wake-up. */
    cheapModel: string;
    /** Route Pi's model traffic through the local metering proxy. */
    proxy: boolean;
    proxyPort: number;
    /** Override where a provider's real API lives (corporate gateway, regional endpoint, tests). */
    upstreams?: Record<string, string>;
  };
  budget: {
    /** Who pays for inference: the operator ("sponsor") or the agent's own capital. */
    mode: 'sponsor' | 'capital';
    sponsorDailyUsd: number;
    sponsorTotalUsd: number | null;
    perEpisodeUsd: number;
    /** NAV at which the daemon proposes switching to mode "capital". */
    graduationNavUsd: number;
    /** In capital mode: inference may cost at most this fraction of NAV per day. */
    capitalMaxDailyPctNav: number;
  };
  schedule: {
    minGapSec: number;
    heartbeatSec: number;
    heartbeatMinSec: number;
    heartbeatMaxSec: number;
    episodeTimeoutSec: number;
    stallSec: number;
  };
  reconcile: {
    intervalSec: number;
    /** NAV change with no recorded flow that triggers an "unexplained jump" incident. */
    jumpPct: number;
    jumpMinUsd: number;
    /** Round-to-round drop that wakes the agent for a post-mortem. */
    dropPct: number;
  };
  notify: {
    ntfy: { server: string; topic: string; replyTopic: string };
    telegram: { chatId: string };
  };
  inbox: { maxNonUrgentPerDay: number };
  dashboard: { host: string; port: number };
  selfmod: {
    probationSec: number;
    highRiskProbationSec: number;
    keepReleases: number;
    gateTimeoutSec: number;
  };
}

export const DEFAULT_CONFIG: OuroConfig = {
  operator: { name: '', jurisdiction: '', timezone: 'UTC', addresses: [] },
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    thinking: 'medium',
    cheapModel: 'claude-haiku-4-5',
    proxy: true,
    proxyPort: 8787,
  },
  budget: {
    mode: 'sponsor',
    sponsorDailyUsd: 5,
    sponsorTotalUsd: null,
    perEpisodeUsd: 1.5,
    graduationNavUsd: 500,
    capitalMaxDailyPctNav: 0.05,
  },
  schedule: {
    minGapSec: 60,
    heartbeatSec: 3600,
    heartbeatMinSec: 300,
    heartbeatMaxSec: 6 * 3600,
    episodeTimeoutSec: 45 * 60,
    stallSec: 10 * 60,
  },
  reconcile: { intervalSec: 900, jumpPct: 0.25, jumpMinUsd: 0.25, dropPct: 0.2 },
  notify: {
    ntfy: { server: 'https://ntfy.sh', topic: '', replyTopic: '' },
    telegram: { chatId: '' },
  },
  inbox: { maxNonUrgentPerDay: 6 },
  dashboard: { host: '127.0.0.1', port: 7777 },
  selfmod: { probationSec: 900, highRiskProbationSec: 3600, keepReleases: 8, gateTimeoutSec: 900 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function loadConfig(paths: Paths): OuroConfig {
  const file = readJson<Record<string, unknown>>(paths.config, {});
  return deepMerge(structuredClone(DEFAULT_CONFIG), file);
}

export function saveConfig(paths: Paths, cfg: OuroConfig): void {
  writeJson(paths.config, cfg);
}

/** Operator-owned hard limits (root-owned file under /etc/ouroboros). Stricter than config always wins. */
export interface Limits {
  sponsorDailyUsd?: number;
  sponsorTotalUsd?: number;
  perEpisodeUsd?: number;
  blockedVenues?: string[];
  blockedJurisdictions?: string[];
  maxNonUrgentInboxPerDay?: number;
  note?: string;
}

export function loadLimits(paths: Paths): Limits {
  try {
    return readJson<Limits>(paths.limitsFile, {});
  } catch {
    return {};
  }
}

export interface EffectiveBudget {
  mode: 'sponsor' | 'capital';
  dailyUsd: number;
  totalUsd: number | null;
  perEpisodeUsd: number;
}

function minDefined(...xs: Array<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

export function effectiveBudget(cfg: OuroConfig, limits: Limits): EffectiveBudget {
  return {
    mode: cfg.budget.mode,
    dailyUsd: minDefined(cfg.budget.sponsorDailyUsd, limits.sponsorDailyUsd) ?? 0,
    totalUsd: minDefined(cfg.budget.sponsorTotalUsd, limits.sponsorTotalUsd),
    perEpisodeUsd: minDefined(cfg.budget.perEpisodeUsd, limits.perEpisodeUsd) ?? 0,
  };
}
