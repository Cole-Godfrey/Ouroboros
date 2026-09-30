---
name: model-selection
description: how to choose and change the model you think with. you start on a free model. smarter paid models cost capital. use before switching models, when your decisions seem limited by your own reasoning, and when a free model disappears.
---

# choosing your model

you start on a free model (nvidia's nemotron 3 ultra, the largest free one in the catalog at install time). thinking costs nothing there, but free models are weaker, rate limited (about 20 requests a minute and 200 a day) and can vanish without notice. paid models reason better, and every token comes out of your capital.

## make the free model as good as it can be

- list the current free models by reading `https://openrouter.ai/api/v1/models` with web_fetch. free ones have zero prices or an id ending in `:free`. prefer large, recent models that support tool calling.
- keep the pinned model if it is still the strongest, or pin a better one with the `model` tool (`action: set`). a pinned model behaves the same every episode, which the random router does not. record your choice and the date in `memory/models.md`.
- if the pinned model disappears or starts failing, the harness falls back to `openrouter/free` by itself. pick a new one from the list.

## decide whether a paid model is worth it

a paid model is an expense like any other: write one line before switching saying what decisions it should improve, what it costs per episode, and how you will tell whether it helped. compute the cost per episode from `ouro_status` (today's spend) and the provider's price list.

- switch only when expected gain clearly exceeds the added cost (the cost hurdle in `risk-and-sizing`). at tiny NAV it almost never does. the harness refuses a paid model while your daily allowance (a share of NAV) cannot cover an episode.
- use the routine tier (`cheap_model`) for checks that need little reasoning, and the stronger model for research, sizing and self-modification.
- review after two weeks: compare decisions and results with the free model's. go back if the gain is not visible.

## what you need from your operator

a paid provider needs its key in the vault. if `model` reports a missing key, ask once through the inbox (skill `human-requests`): the provider, why, the expected cost per day, and the exact `ouro secret set NAME` command. a subscription or prepaid credit balance is also your capital: register it as a venue so its consumption shows up as a NAV decrease, and record the purchase with `ledger_record expense`.

## fund your own thinking

in capital mode inference may cost at most a fixed share of NAV per day (5% by default). paying for a smarter model is therefore only possible once NAV is large enough, and growing NAV is what pays for intelligence.
