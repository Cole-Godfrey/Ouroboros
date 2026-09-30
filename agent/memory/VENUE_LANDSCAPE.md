# Venue landscape at install time (September 2026)

Written by the system's author from limited, partly unverified information. **Verify every line against the venue's own documentation before relying on it**, then record what you verified in `memory/venues.md`.

| Kind | Examples | Human needed? | Programmatic access | Viable at ~$1? | Notes |
| --- | --- | --- | --- | --- | --- |
| Spot DEX on a cheap L2 | Uniswap, Aerodrome (Base), Camelot (Arbitrum), Velodrome (Optimism) | No: your wallet is enough | JSON-RPC + router contracts (`viem`) | Yes: gas is typically cents or less; pool fees 0.01-1% | Trade majors only at first. Honeypots, thin pools and MEV are the risks. |
| Ethereum mainnet | Uniswap | No | same | No: gas dominates at this size | Avoid. |
| Solana DEX | Jupiter, Orca | No | RPC + APIs | Marginal: each new token account needs rent (~0.002 SOL, refundable) | Needs a Solana wallet (not created for you). |
| Perp DEX | Hyperliquid, dYdX v4 | No (wallet + deposit) | Signed REST/WebSocket; API/agent wallets can trade without withdrawal rights | Probably not: Hyperliquid's minimum order is about $10 notional and minimum deposit about $5 (verify) | Leverage: Charter rule 3 allows only isolated margin with bounded loss. Some jurisdictions are restricted. |
| Prediction markets | Polymarket (Polygon, USDC, CLOB API), Kalshi (US-regulated, KYC, RSA-signed API, demo environment), Manifold (play money) | Polymarket: wallet plus a jurisdiction check (restrictions apply to some countries, verify current rules). Kalshi: KYC, US residents only | REST/WebSocket | Yes: a few dollars buys a handful of contracts | Edge can come from reading more than the crowd on thin markets. Use Manifold to practise calibration for free. Watch fees, spread and resolution wording. |
| Stock/ETF broker API | Alpaca (US; paper trading is free), Interactive Brokers | Yes: identity checks | REST | Marginal: fractional shares allow small notionals (verify minimum) | Alpaca's paper account needs no funding: good for testing execution code. |
| Centralised crypto exchange | Coinbase Advanced, Kraken | Yes: KYC, API key (trade-only, no withdrawals), deposits | REST/WebSocket (`ccxt`) | Marginal: minimum order sizes and fees vary per pair (verify) | Deposits and withdrawals are human steps. Keep balances small. |
| Lending/yield | Aave, Morpho, Compound on Base | No | contracts | Pointless below hundreds of dollars: 5% APY on $1 is five cents a year | Revisit when NAV is much larger. |
| Non-trading income | Selling data or analysis via x402, bounties, freelance work | Usually yes (accounts, identity) | varies | Possible | The agent's edge may be labour arbitrage rather than trading. Needs operator accounts and legal care. |

## Costs to expect (rough)

- LLM: with Claude Sonnet 5.5 at $2 / $10 per million input / output tokens (cache reads $0.20), an episode of 20 turns at 40k tokens of context is roughly $0.10-0.50 with caching. Hourly wake-ups cost several dollars a day. This dwarfs $1 of capital, which is why inference is sponsor-funded at first.
- Gas on Base, Arbitrum, Optimism, Polygon: usually well under a cent to a few cents per swap.
- CEX taker fees: often 0.1-0.6%. DEX pool fees 0.01-1% plus gas plus price impact.

## Regulatory notes to check for the operator's jurisdiction

Leveraged crypto derivatives, prediction markets, and offshore exchanges are restricted for residents of some countries and US states. Automated trading must be allowed by each venue's terms. Never evade geo-blocks or identity checks. Trades are taxable events in most jurisdictions: keep the ledger's trade log complete.
