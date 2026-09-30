// USD prices for NAV. The oracle is deliberately boring: stablecoins at $1,
// operator/agent overrides, and Coinbase's public spot endpoint. Anything it
// cannot price is reported as "unpriced" and excluded from NAV rather than guessed.
// (A venue adapter can always supply its own valueUsd; the agent can add sources.)

import { fetchJson } from '../lib/http.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { roundUsd } from '../lib/money.ts';
import type { Holding } from './state.ts';
import type { VenueHolding } from './venues/types.ts';

export interface PriceSource {
  name: string;
  get(asset: string): Promise<number | undefined>;
}

export const STABLES = ['USD', 'USDC', 'USDT', 'DAI', 'USDS', 'PYUSD', 'FDUSD', 'TUSD', 'USDG'];

const ALIASES: Record<string, string> = { WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', WSOL: 'SOL', WPOL: 'POL', WMATIC: 'POL', MATIC: 'POL' };

export function normalizeAsset(asset: string): string {
  const a = asset.trim().toUpperCase();
  return ALIASES[a] ?? a;
}

export function coinbaseSource(fetchImpl: typeof fetchJson = fetchJson): PriceSource {
  return {
    name: 'coinbase',
    async get(asset) {
      if (!/^[A-Z0-9]{2,12}$/.test(asset)) return undefined;
      try {
        const r = await fetchImpl<{ data?: { amount?: string } }>(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`, { timeoutMs: 8000, retries: 1 });
        const n = Number(r.data?.amount);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export class PriceOracle {
  private sources: PriceSource[];
  private overrides: Record<string, number>;
  private stables: Set<string>;
  private ttl: number;
  private clock: Clock;
  private cache = new Map<string, { ts: number; price: number | undefined }>();

  constructor(opts: { sources?: PriceSource[]; overrides?: Record<string, number>; stables?: string[]; ttlMs?: number; clock?: Clock } = {}) {
    this.sources = opts.sources ?? [coinbaseSource()];
    this.overrides = Object.fromEntries(Object.entries(opts.overrides ?? {}).map(([k, v]) => [normalizeAsset(k), v]));
    this.stables = new Set((opts.stables ?? STABLES).map((s) => s.toUpperCase()));
    this.ttl = opts.ttlMs ?? 60_000;
    this.clock = opts.clock ?? systemClock;
  }

  addSource(s: PriceSource): void {
    this.sources.unshift(s);
    this.cache.clear();
  }

  setOverride(asset: string, price: number): void {
    this.overrides[normalizeAsset(asset)] = price;
    this.cache.delete(normalizeAsset(asset));
  }

  async usd(rawAsset: string): Promise<number | undefined> {
    const asset = normalizeAsset(rawAsset);
    if (asset in this.overrides) return this.overrides[asset];
    if (this.stables.has(asset)) return 1;
    const hit = this.cache.get(asset);
    if (hit && this.clock() - hit.ts < this.ttl) return hit.price;
    let price: number | undefined;
    for (const s of this.sources) {
      price = await s.get(asset).catch(() => undefined);
      if (price !== undefined) break;
    }
    this.cache.set(asset, { ts: this.clock(), price });
    return price;
  }

  /** Value a snapshot's holdings. Adapter-provided valueUsd/priceUsd win over the oracle. */
  async value(holdings: VenueHolding[]): Promise<{ holdings: Holding[]; totalUsd: number; unpriced: string[] }> {
    const out: Holding[] = [];
    const unpriced: string[] = [];
    let total = 0;
    for (const h of holdings) {
      if (!(Math.abs(h.qty) > 0) && h.valueUsd === undefined) continue;
      let valueUsd = h.valueUsd;
      let priceUsd = h.priceUsd;
      if (valueUsd === undefined) {
        priceUsd ??= await this.usd(h.asset);
        if (priceUsd === undefined) {
          unpriced.push(h.asset);
          out.push({ asset: h.asset, qty: h.qty, valueUsd: 0 });
          continue;
        }
        valueUsd = h.qty * priceUsd;
      }
      valueUsd = roundUsd(valueUsd);
      total += valueUsd;
      out.push({ asset: h.asset, qty: h.qty, priceUsd, valueUsd });
    }
    return { holdings: out, totalUsd: roundUsd(total), unpriced };
  }
}
