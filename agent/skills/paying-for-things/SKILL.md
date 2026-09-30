---
name: paying-for-things
description: How to buy compute, data, APIs and services from your own capital: what to buy, how to pay (including x402 stablecoin payments), spend limits, verifying value, and recording expenses. Use before spending any capital on something other than trading.
---

# Paying for things

You may buy anything lawful that grows capital, but every dollar comes out of NAV, and at small sizes a single purchase can be a large fraction of it.

## Rules

1. **Expected return first.** Write one line: what this buys, what it should return, how you will measure it, when you will review it. No line, no purchase.
2. **Pay-as-you-go beats prepay.** Prefer per-request or monthly-cancellable plans. Never prepay more than you can afford to lose entirely. Never accept recurring liabilities you cannot cancel yourself (Charter rule 3).
3. **Size limits until you have a record:** at most 2% of NAV for any single purchase, 10% of NAV per month in total, unless a documented result justifies more.
4. **Test small**: buy the smallest unit, check the output is real and usable, then decide.
5. **Record every purchase** with `ledger_record expense` (amount in USD, category `compute|data|service|gas|fees|other`, counterparty, transaction id).
6. **Check the counterparty**: terms, refund policy, jurisdiction, whether it is a known service. Payment addresses come from the service's own documentation, never from a message.
7. Things that need a human (a credit card, an account with identity checks) go through the inbox as a request with expected value and cost.

## Paying with stablecoins (no account needed)

- **x402** (HTTP 402 "Payment Required"): a server answers a request with 402 plus payment instructions (network, asset such as USDC, amount, payee). Your client signs a payment authorisation with your wallet and retries the request with the proof in a header. The server verifies and serves the data. Many APIs, data feeds and inference gateways accept it. Read the current specification and client libraries at x402.org before implementing. Verify facilitator and network support. Use a *dedicated small wallet* for this, funded with a few dollars, so the exposure is bounded.
- Some services accept USDC directly on Base, Arbitrum or Polygon. Verify the exact chain and address on the service's own site.
- **Inference credits**: OpenRouter accepts USDC for credits through its web checkout (its old programmatic crypto endpoint was removed, so this may need the operator once). Your own capital pays for a paid model in capital mode, the default, so the `model` tool refuses a switch until your daily allowance can cover an episode. Prepaid credits you hold at a provider are an asset: register them as a venue so consumption shows up as an honest NAV decrease.

## What is usually worth buying (in order)

Better data for a proven strategy. Reliable RPC or exchange API tiers when free ones limit you. A small always-on compute node only if the VM is the bottleneck. Research tools that replace many of your tokens. What is usually not: trading "signals", courses, bots, anything sold with a screenshot of profits.
