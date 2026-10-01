# Genesis: your first episode

You have just been switched on. Nothing is set up except: an EVM wallet with an address, a paper-trading sandbox, this harness, an operator, and a small amount of capital (possibly not yet deposited) plus a free language model to think with. Work through this list. Add a dated "done" log at the bottom of this file when you finish each part.

## 1. Orient (cheap)

- `ouro_status`. Read the Charter and Constitution once, carefully (they are already in your prompt).
- Environment (bash): `uname -a`, `node -v`, `python3 --version`, `df -h ~`, `free -m`, `curl -sI https://example.com | head -1`, `pi --version`. Note anything that limits you.
- `model` status: which model you think with and whether it is free. find the best free one (skill `model-selection`) and pin it.
- `secret_list` (what the operator has provided), `cat ~/.ouroboros/wallets.json` (your address), `cat ~/.ouroboros/config.json` (jurisdiction, timezone, budget, models).
- Read the harness docs: `$OURO_CODE/docs/SYSTEM.md`. Skim the repo layout (skill `self-modification`).
- `cd $OURO_CODE && npm run check` to confirm the gate is green. It costs no tokens.

## 2. Understand your constraints (write `memory/world-model.md`, under one page)

- Capital: from `ouro_status`. If it is zero you are waiting for funding. Say so.
- Inference: the model you use and whether it is free. If it is paid, today's and per-episode caps, what one episode costs you, and how many you can afford per day.
- Jurisdiction and what it rules out. If it is empty in config, ask the operator once, in your first message.

## 3. Your first message to the operator (one inbox item)

Kind `request` (or `info` if nothing is needed yet). Under 200 words plus steps:

- Who you are and what you have checked (two lines).
- Your wallet address and the exact steps to fund it, including classifying unknown sender transfers with `ouro fund inflows` and `ouro fund resolve` (skill `human-requests`).
- What you will do while waiting.
- The questions only they can answer (jurisdiction if unset. Whether they want Telegram for authenticated replies).

## 4. Build while you wait

Read `memory/VENUE_LANDSCAPE.md` and `memory/STRATEGY_SEEDS.md`. They were written from limited information at install time: treat every line as a hypothesis to verify, not a fact.

Priorities, in order:

1. Research which venues and strategies are viable at *your* size (skill `research-protocol`). Write the results to `memory/venues.md` and `memory/research/`.
2. A paper-trading harness and one candidate strategy running in paper mode (skill `strategy-development`).
3. The adapter for the first real venue you intend to use (skill `venue-onboarding`), ready for when keys or funds arrive.
4. Cheap monitoring so future wake-ups can be short.

Time-box this episode. Do not try to do everything now. Your first month's most valuable output is information and infrastructure, not profit.

## 5. Close

`journal` one lesson (what surprised you). `episode_end` with a handoff and a next wake (2 to 6 hours while waiting for funding. Use `model_tier: "cheap"` for balance checks).

## Done log

(add dated lines here)
