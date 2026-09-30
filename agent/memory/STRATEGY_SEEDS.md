# Strategy seeds: hypotheses, not recommendations

Honest priors for an agent with roughly one dollar and a few dollars a day of thinking budget. Each is a starting point for research (skill `research-protocol`) that must climb the evidence ladder (skill `strategy-development`) before real money.

| Idea | Mechanism | Prior at your size | Main failure modes |
| --- | --- | --- | --- |
| Calibrated forecasting on thin prediction markets | You read more sources than the crowd on obscure markets; known biases (longshots are overpriced) | Modest positive if disciplined and only where your Brier score beats the market's | Resolution ambiguity, thin liquidity, fees and spread eating the edge, small sample |
| Passive benchmark | Hold a cheap majors basket; the null hypothesis every active strategy must beat after costs | Roughly market return, high variance | Fees on rebalancing; drawdowns |
| Liquidity provision / market making on small venues | Earn spread and venue rewards | Negative at $1 (adverse selection, fixed costs); revisit with more capital | Getting picked off, inventory risk |
| Cross-venue arbitrage | Price differences between venues | Negative: fees, transfer time and latency kill it at small size | Leg risk, withdrawal delays |
| Funding-rate or basis carry | Harvest perp funding vs spot | Needs capital and margin; not viable at $1 | Liquidation, funding flips |
| Stablecoin lending | Interest | Correct but irrelevant until NAV is large | Smart-contract risk |
| Selling services via x402 (data, analysis, tiny APIs) | Earn from labour instead of trading | Uncertain; needs a product people find | No demand; legal/identity needs |
| Airdrop farming | Repeated small on-chain actions | Usually negative after gas; sybil rules and ToS risk | Disqualification, gas cost |
| New-token sniping / memecoins | Speculation | Negative expected value and scam-ridden. Do not. | Honeypots, rugs, MEV |
| Leveraged directional bets | Speculation | Ruin risk; Charter allows only bounded-loss forms | Liquidation |

## Reading the table

- Anything requiring speed against professionals is not for you. Your only durable advantages are patience, breadth of reading, tiny position size, and the ability to work on things too small for institutions.
- Fixed costs decide feasibility before edge does. Compute the cost hurdle (skill `risk-and-sizing`) for each idea at your current NAV.
- Expect most ideas to be dead ends. The goal of the first weeks is to find out which, cheaply, and to build the tooling to keep testing.
