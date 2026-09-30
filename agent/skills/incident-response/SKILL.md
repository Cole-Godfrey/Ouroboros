---
name: incident-response
description: Playbooks for incidents raised by the reconciler and daemon (nav_drop, unexplained_jump, guard_tripped, unclassified_inflow, venue_unreachable, unpriced_assets, llm billing/auth, charter mismatch, audit chain failure, failing episodes, strategy crash loops). Use when an incident wakes you or appears in the briefing.
---

# Incident response

Diagnose from the ledger first (`ouro_status`, `ouro_ledger`), fix or escalate, resolve with `ledger_record incident_resolve`, and journal a lesson. Never resolve an incident you have not understood.

| Incident | Meaning | Do |
| --- | --- | --- |
| `nav_drop` | NAV fell 20%+ between reconciliations | Find the cause (trade, price move, fee, theft?). Stop the responsible strategy first. Verify balances directly at each venue. Write a post-mortem before taking new risk. If funds left without your action, treat it as a compromise: stop everything, tell the operator with `urgency: high`. |
| `unexplained_jump` | NAV rose with no recorded deposit, income or trade P&L | Do not count it as profit. Check for a deposit (ask the operator if unclear), airdrop, mispriced asset, or a snapshot bug. Classify it once understood. |
| `unclassified_inflow` | Funds arrived that nobody has classified | If the operator deposited it, `inflow_resolve as: capital`. If it is income you earned, `income`. If it is an unsolicited token, `ignore` and do not touch it. |
| `guard_tripped` | A venue's drawdown guard stopped its strategy | Leave it stopped. Read the strategy log and fills. Decide retire, fix or restart smaller. The kill rule was written for exactly this moment; do not loosen it the same day. |
| `venue_unreachable` | An adapter failed three rounds in a row | Check credentials, API status and rate limits. NAV uses the last known value meanwhile, which may be stale: assume positions moved. Fix the adapter or ask the operator (expired key?). |
| `unpriced_assets` | Holdings the oracle cannot price are excluded from NAV | Give the adapter a `valueUsd` (conservative), add a price source, or sell the asset. |
| LLM auth/billing alerts | The provider rejected the key or credits are exhausted | Nothing you can fix; the operator has been alerted. Do not try to work around it. |
| Charter mismatch | The Charter hash differs from the operator's seal | You will not run until the operator reseals. Do not touch the Charter. |
| Audit chain failure | The event log failed hash verification | Something edited history. Preserve evidence (`ouro ledger verify`), alert the operator, and do not "repair" the log. |
| Failing episodes / rollback | Recent episodes errored, or a self-modification was rolled back | Read the error, check `selfmod history`, journal the cause, and change your approach before retrying. |
| Strategy crash loop | A strategy exited abnormally and was restarted or given up on | Read its log. Fix the root cause; do not raise restart limits to paper over it. |

Escalate to the operator (`inbox send`, `urgency: high`) when: money left without your action; a venue may be compromised; you cannot explain a change of more than 10% of NAV within an hour; or a limit blocks you from acting safely.
