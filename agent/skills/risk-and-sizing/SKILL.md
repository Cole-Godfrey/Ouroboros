---
name: risk-and-sizing
description: Position sizing (fractional Kelly), the cost hurdle, drawdown precommitment, scale-up and cut rules, and risk-of-ruin arithmetic for a small self-funded account. Use before sizing any bet or setting a strategy's kill rule.
---

# Risk and sizing

## The objective is growth rate

Maximise the expected *log* of wealth. Wealth multiplies, so a loss of x needs a gain of x/(1-x) to recover: -20% needs +25%, -50% needs +100%, -80% needs +400%.

## Kelly sizing (use a fraction)

- Binary bet at price `c` (a prediction-market share costing `c` dollars that pays $1) when you believe the probability is `p`: net odds `b = (1-c)/c`, full Kelly stake fraction `f* = (p - c) / (1 - c)`. If `p <= c` there is no bet.
- General bet with win probability `p`, win multiple `b`, loss multiple 1: `f* = (b·p - (1-p)) / b`.
- Your `p` is too optimistic and noisy. **Bet a quarter to a half of `f*`**, and never more than a stated cap per position (for example 10% of NAV) while your record is short. Overbetting past `2·f*` has negative growth even with a real edge.
- Several simultaneous bets that are correlated (same market driver, same venue, same counterparty) count as one bet.

## The cost hurdle (always compute)

`hurdle = fees + expected slippage + gas + your token cost for the decision`, as a percentage of the amount at risk. Trade only if expected gain per trade is comfortably above it (rule of thumb: 3x). At $1 of capital a single mainnet swap can be 30%+ of the position. On a cheap L2 it can be under 1%. Fixed costs set a minimum useful trade size. Below it a strategy cannot work no matter how good the signal.

## Drawdown precommitment

Decide limits *before* trading, when you are calm:

- Each strategy's sub-account has a maximum drawdown from its peak (start at 30-40% for a small allocation) enforced by a venue guard, which stops the strategy automatically.
- After a NAV drop of 20% or more between reconciliations you owe a written post-mortem before taking more risk.
- **Tightening** a limit is instant and free. **Loosening** one waits a full cool-down (at least 24 hours) and needs a written reason, so that a bad day cannot talk you into more risk.

## Scaling and cutting

- Scale a working strategy in steps of at most 2x, only while realised results (fills, fees, slippage) match paper results and after a minimum sample (30 trades or one full market cycle).
- Cut on rules, not feelings: results fall below the kill rule, the mechanism stops being true, data quality degrades, or costs rise above the hurdle.
- Keep a reserve: never hold less than what covers gas and fees for the strategies you run. A strategy that cannot pay its own gas is dead.

## Ruin arithmetic

Risk of ruin grows quickly with bet size. If you repeatedly stake fraction `f` with win probability `p` at even odds, hitting a -50% drawdown becomes likely once `f` exceeds roughly `(2p-1)`. Small stakes with a real edge compound. Large stakes with the same edge end at zero. When in doubt, halve the size.
