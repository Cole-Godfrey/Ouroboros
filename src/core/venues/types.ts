// a "venue" is anywhere the agent holds value: an exchange account, a wallet,
// a broker, a prepaid credit balance. the only thing the harness *requires* of a
// venue is a truthful snapshot of what it holds. everything about how to trade
// there is the agent's business.
//
// venue modules run in a separate short-lived process (see venue-runner.ts) so a
// buggy or hung adapter cannot take the daemon down or corrupt its memory.

export interface VenueHolding {
  /** ticker, upper-case: "USDC", "ETH", "BTC", "AAPL", or a prediction-market share id. */
  asset: string;
  qty: number;
  /** if the adapter knows a better price than the oracle (e.g. a market's mid), it can say so. */
  priceUsd?: number;
  /** if the adapter can value the position itself (e.g. prediction-market shares), it says so. */
  valueUsd?: number;
}

export interface VenueSnapshot {
  holdings: VenueHolding[];
  /** optional cross-check: the venue's own reported total in USD. */
  totalUsd?: number;
  note?: string;
}

export interface VenueFlow {
  kind: 'deposit' | 'withdrawal';
  asset: string;
  qty: number;
  usd?: number;
  /** unique id of the transfer (tx hash, exchange transfer id). used to avoid double counting. */
  ref: string;
  from?: string;
  to?: string;
  ts?: number;
}

export interface VenueContext {
  /** only the secrets this venue declared, plus a minimal process environment. */
  env: Record<string, string | undefined>;
  now: number;
  /** a directory the venue may use for its own state and caches. */
  dataDir: string;
  args?: unknown;
}

export interface VenueModule {
  id: string;
  description?: string;
  /** vault secret names to inject as environment variables. */
  secrets?: string[];
  snapshot(ctx: VenueContext): Promise<VenueSnapshot>;
  /** optional: transfers in/out since a timestamp, so deposits are not mistaken for profit. */
  flows?(ctx: VenueContext, sinceTs: number): Promise<VenueFlow[]>;
}

export interface RunnerResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  durationMs: number;
}
