// A tiny paper-trading engine: the agent's sandbox for developing and testing
// strategy code without risking capital. It models fees and slippage so results
// are not flattering. State lives in one JSON file, so strategy processes and the
// `paper` venue adapter (which reports it to the reconciler) share it.

import path from 'node:path';
import { readJson, withLockSync, writeJson } from '../lib/fsx.ts';
import type { VenueSnapshot } from '../core/venues/types.ts';

export interface PaperFill {
  ts: number;
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  price: number;
  feeUsd: number;
}

export interface PaperState {
  cashUsd: number;
  positions: Record<string, number>;
  feesPaidUsd: number;
  fills: PaperFill[];
  deposits: number;
}

export interface PaperOptions {
  /** Taker fee in basis points (default 10 = 0.10%). */
  feeBps?: number;
  /** Adverse price movement on every fill, in basis points (default 5). */
  slippageBps?: number;
  clock?: () => number;
}

export class PaperExchange {
  readonly file: string;
  private feeBps: number;
  private slipBps: number;
  private clock: () => number;

  constructor(file: string, opts: PaperOptions = {}) {
    this.file = file;
    this.feeBps = opts.feeBps ?? 10;
    this.slipBps = opts.slippageBps ?? 5;
    this.clock = opts.clock ?? Date.now;
  }

  static defaultFile(home: string): string {
    return path.join(home, 'data', 'venues', 'paper', 'paper.json');
  }

  load(): PaperState {
    return readJson<PaperState>(this.file, { cashUsd: 0, positions: {}, feesPaidUsd: 0, fills: [], deposits: 0 });
  }

  private mutate<T>(fn: (s: PaperState) => T): T {
    return withLockSync(`${this.file}.lock`, () => {
      const s = this.load();
      const r = fn(s);
      if (s.fills.length > 5000) s.fills.splice(0, s.fills.length - 5000);
      writeJson(this.file, s);
      return r;
    });
  }

  deposit(usd: number): void {
    if (!(usd > 0)) throw new Error('deposit must be positive');
    this.mutate((s) => {
      s.cashUsd += usd;
      s.deposits += usd;
    });
  }

  /** Spend `usd` (fee included) on `symbol` at `marketPrice`. */
  buy(symbol: string, usd: number, marketPrice: number): PaperFill {
    return this.mutate((s) => {
      if (!(usd > 0) || !(marketPrice > 0)) throw new Error('bad order');
      if (usd > s.cashUsd + 1e-9) throw new Error(`insufficient cash: have ${s.cashUsd}, need ${usd}`);
      const fee = (usd * this.feeBps) / 1e4;
      const price = marketPrice * (1 + this.slipBps / 1e4);
      const qty = (usd - fee) / price;
      s.cashUsd -= usd;
      s.feesPaidUsd += fee;
      s.positions[symbol] = (s.positions[symbol] ?? 0) + qty;
      const fill: PaperFill = { ts: this.clock(), side: 'buy', symbol, qty, price, feeUsd: fee };
      s.fills.push(fill);
      return fill;
    });
  }

  sell(symbol: string, qty: number, marketPrice: number): PaperFill {
    return this.mutate((s) => {
      const have = s.positions[symbol] ?? 0;
      if (!(qty > 0) || !(marketPrice > 0)) throw new Error('bad order');
      if (qty > have + 1e-12) throw new Error(`insufficient ${symbol}: have ${have}, need ${qty}`);
      const price = marketPrice * (1 - this.slipBps / 1e4);
      const gross = qty * price;
      const fee = (gross * this.feeBps) / 1e4;
      s.positions[symbol] = have - qty;
      if (s.positions[symbol] < 1e-12) delete s.positions[symbol];
      s.cashUsd += gross - fee;
      s.feesPaidUsd += fee;
      const fill: PaperFill = { ts: this.clock(), side: 'sell', symbol, qty, price, feeUsd: fee };
      s.fills.push(fill);
      return fill;
    });
  }

  snapshot(): VenueSnapshot {
    const s = this.load();
    const holdings = [{ asset: 'USD', qty: s.cashUsd }, ...Object.entries(s.positions).map(([asset, qty]) => ({ asset, qty }))];
    return { holdings, note: `paper account: ${s.fills.length} fills, ${s.feesPaidUsd.toFixed(4)} USD fees` };
  }
}
