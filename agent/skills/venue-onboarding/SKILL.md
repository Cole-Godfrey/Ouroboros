---
name: venue-onboarding
description: How to add a new place where you hold or trade value (exchange, broker, wallet, prediction market) so the reconciler counts it. Use before asking your operator to open an account or provide keys, and when writing a venue adapter.
---

# Onboarding a venue

A **venue** is any place you hold value. The harness only requires one thing of it: a truthful `snapshot()`. How you trade there is your own code.

## 1. Decide it is worth it (before asking a human for anything)

Research, and write the result to `memory/venues.md`:

- Do the terms allow automated trading from the operator's jurisdiction (config `operator.jurisdiction`)? Note the URL and date. If unclear, skip it.
- Minimum order/deposit, fees, withdrawal fees, spreads. Compute the **cost hurdle** for your capital. If a round trip costs more than a few percent of NAV, this venue is not for you yet.
- Does it need a human (KYC, bank link, phone, CAPTCHA)? Wallet-only venues cost the operator nothing. KYC venues cost them 10 to 30 minutes.
- What is the edge you expect there, and why would it survive fees? No hypothesis, no onboarding.

## 2. Ask once, completely

Use `inbox send` (kind `request`) with a single message containing every step and every secret name (see skill `human-requests` for templates). Keep working on other things meanwhile. Exchange keys must be **trade-only, never withdrawal-enabled**.

## 3. Write the adapter

Put it in `~/.ouroboros/venues/<id>/index.ts` (add a `package.json` next to it and `npm i` what you need there).

```ts
// a centralised exchange via ccxt (npm i ccxt)
import ccxt from 'ccxt';
export default {
  id: 'kraken',
  description: 'Kraken spot account',
  secrets: ['KRAKEN_API_KEY', 'KRAKEN_API_SECRET'],          // injected as env vars, only into this process
  async snapshot(ctx: { env: Record<string, string | undefined> }) {
    const ex = new ccxt.kraken({ apiKey: ctx.env.KRAKEN_API_KEY, secret: ctx.env.KRAKEN_API_SECRET });
    const bal = await ex.fetchBalance();
    const holdings = Object.entries(bal.total as Record<string, number>).filter(([, q]) => q > 0).map(([asset, qty]) => ({ asset, qty }));
    return { holdings };                                    // the oracle prices assets; give valueUsd yourself for anything exotic
  },
};
```

Rules of the contract:

- `holdings[].asset` is an upper-case ticker. Stablecoins are priced at $1, others by the price oracle. For positions the oracle cannot price (prediction-market shares, LP tokens), return `valueUsd` computed conservatively (mid or bid, not last).
- **Fail loudly.** If any part of the snapshot cannot be read, throw. A partial answer looks like a phantom loss. A failure just keeps the last valuation and flags the venue as stale.
- Optional `flows(ctx, sinceTs)` returns deposits/withdrawals (`{kind, asset, qty, ref, from?}`) so deposits are never mistaken for profit. Implement it if the venue exposes transfer history.
- On-chain: the built-in `builtin/evm-wallet` already reads native gas token + USDC on Base, Arbitrum, Optimism, Polygon and Ethereum. Add other tokens in `~/.ouroboros/data/venues/evm-wallet/config.json` (`{"tokens":[{"chain","address","symbol","decimals"}]}`). For other chains write a new adapter.

## 3b. Test without exposing keys

`secret_exec` with `script: "node -e \"...\""` and the secret names lets you exercise API calls with the real keys while the values stay redacted in your context.

## 4. Register, verify, guard

`venue register {id, module, strategy?, guard_max_drawdown_pct?}` runs a first snapshot and returns it. Compare it with what the operator can see in the venue's own UI (ask them only if it is ambiguous). Give each strategy its own sub-account/wallet registered as its own venue with `strategy` and a drawdown guard (for example 0.4) so a runaway strategy is stopped automatically.

## 5. First trade

Make the smallest trade that proves the whole path (place, fill, fees, balance change, snapshot agrees). Record it with `ledger_record trade` and record the cost hurdle you measured in your notes. Only then build the strategy.
