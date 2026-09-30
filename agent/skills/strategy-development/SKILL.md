---
name: strategy-development
description: The lifecycle and code conventions for trading strategies that run between episodes (research note, paper trading, tiny live, scaling, retirement). Use when designing, writing, testing or retiring a strategy.
---

# Strategy development

Code trades. You think. A strategy is a supervised process (`strategy register/start`) that keeps working while you sleep.

## Lifecycle

1. **Hypothesis note** (`memory/strategies/<name>.md`): the mechanism (who is on the other side and why do they lose?), the data it needs, expected edge per trade *after* costs, capacity, failure modes, kill rules. Dated, with sources.
2. **Paper trade** with `src/toolkit/paper.ts` (`PaperExchange`: fees 10 bps and slippage 5 bps by default. It never lets you overspend). Register the built-in paper venue with `kind: "paper"` if you want to see it on the dashboard. Paper venues never count toward NAV. Run long enough to see the edge repeat: at least 30 independent trades, or a full cycle of whatever the market does.
3. **Tiny live** allocation in its own sub-account/wallet (its own venue, with a drawdown guard). Compare realised fills, fees and slippage with paper. If live is worse by more than a third, stop and find out why.
4. **Scale in steps** (at most 2x per step) only while realised results keep matching. Re-check capacity: your own size moves the price sooner than you think, even at small scale in thin markets.
5. **Monitor and retire.** Alarms for stale data, no trades for too long, drawdown, error rates. Retire a strategy when its edge decays or its rolling results fall below its kill rule. Write the post-mortem in the journal.

## Code conventions

- Directory `~/.ouroboros/workspace/strategies/<name>/`, entry point runnable with `node`/`python3`, config in env vars. Secrets arrive as env vars via `strategy register {secrets:[...]}`. Never write them to disk or logs.
- **Idempotent and restartable**: on start, read the venue's real state (open orders, positions) rather than trusting local files. Assume it was killed mid-order.
- **Risk limits live on the venue** where possible (exchange-side stops, isolated margin, position caps) so they hold when your process or the VM is down. The Mac may sleep. The VM may restart.
- Rate limits, timeouts and retries with jitter on every network call. Treat any unexpected response as "do nothing and log".
- Log one line per decision with the inputs. Log every fill to the ledger:

```ts
import { ouro } from '<code>/src/toolkit/client.ts';   // talks to the daemon over the unix socket (OURO_HOME is set for you)
await ouro.trade({ venue: 'kraken', market: 'ETH/USD', side: 'buy', qty: 0.002, price: 3120.5, feeUsd: 0.006, strategy: 'mean-rev' });
await ouro.journal('lesson', 'spread widens at 03:00 UTC; skip that hour');
```

- A kill switch: check for a file `~/.ouroboros/run/STOP-<name>` each loop and flatten cleanly.
- Never let a strategy call an LLM in its hot loop. If it needs judgement, have it write a request file and wake you (`ouro.inbox` or a scheduled wake), or use a small classifier you trained.

## Sizing

See skill `risk-and-sizing`. Size from the *evidence*, not from how good the idea feels. Fixed costs mean that below a certain trade size the strategy cannot work at all. Compute that size first.
