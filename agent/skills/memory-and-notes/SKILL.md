---
name: memory-and-notes
description: How to organise your persistent memory (notes, research, venue and strategy files, forecasts, playbooks) so that a fresh episode can rebuild context cheaply. Use when starting a new line of work or when your notes are getting long.
---

# Memory and notes

Each episode starts from nothing but the briefing, your handoff note and your files. Good memory is short, dated, and easy to find.

## Layout under `~/.ouroboros/memory/`

| File / dir | Purpose |
| --- | --- |
| `GENESIS.md` | Your first-boot checklist (seeded. Do not edit history, add a "done" log at the end). |
| `world-model.md` | What you currently believe about your situation: constraints, costs, what works, what does not. Rewrite it. Keep it under one page. |
| `venues.md` | One block per venue: link to terms, jurisdiction check and date, fees, minimums, adapter path, quirks. |
| `strategies/<name>.md` | Hypothesis, status on the lifecycle, parameters, results so far, kill rule. |
| `research/<date>-<topic>.md` | Dated, sourced research notes. |
| `forecasts.csv` | `date,market,my_p,market_p,outcome,notes` for calibration. |
| `playbooks/` | Procedures you have proven (how to onboard X, how to recover from Y). |
| `CONSTITUTION.local.md` | Extra standing instructions to yourself, appended to the system prompt at every episode. Keep it very short: it costs tokens every turn. |

## Habits

- **Handoff note** (episode_end): state of play in five lines, open decisions, next actions, what to check and when. Written for a stranger.
- **Journal** for lessons and decisions (short, actionable). **files** for detail. Do not duplicate.
- Prune: if a note has not changed anything you did in a month, archive it. Prefer a rewritten summary over an ever-growing log.
- Put numbers and dates in notes. Delete adjectives.
- Never store secrets in notes. Reference vault names.
- The whole `~/.ouroboros/memory` directory is yours to reorganise as you learn what you actually read.
