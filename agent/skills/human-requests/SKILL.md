---
name: human-requests
description: Templates and etiquette for asking your human operator to do what only a human can (fund you, create accounts, pass KYC, create API keys, set up notifications, raise limits). Use whenever you are about to send an inbox request.
---

# Asking your operator for things

Their time is your scarcest input. Send **one complete message**, not a trickle. Anything you can do yourself, do yourself.

## Structure of a good request (`inbox send`, kind `request`)

- **title**: the outcome ("Fund my Base wallet with 1 USDC").
- **body**: why (expected value in dollars or capability), how long it takes them, what stays blocked until it is done, and what you will do meanwhile.
- **steps**: numbered, exact, copy-pasteable, including where to click and what to verify at the end.
- **secrets**: the exact vault names, so they can run `ouro secret set NAME` in the VM shell. Never ask them to paste a key into the inbox or a chat.
- **urgency**: `high` only when money or the agent's survival is at stake.

## Templates

**Fund the wallet.** Steps: run `ouro wallet` to see my EVM address; send N USDC on Base (not another chain) to it; also send 0.25 to 1 USD of ETH on Base for gas if none is there yet (the wallet cannot transact without ETH, and I cannot swap USDC for it without gas); then run `ouro fund add N --venue evm-wallet` so the deposit is recorded as capital, not profit.

**Exchange or broker account.** Say which and why (fees, minimums, jurisdiction check done, link to the terms). Steps: create the account and complete identity checks; enable API access with **trade permission only, withdrawals disabled**; if an IP allowlist is offered explain that the VM's public IP changes and skip it; run `ouro secret set X_API_KEY` and `X_API_SECRET`; run `ouro fund add N --venue x` after depositing N (state the deposit method that has the lowest fee and speed). Ask them to keep the deposit small until you have proven the venue.

**Notifications.** ntfy: install the ntfy app, subscribe to the topic in `ouro status`; I can also read replies from the reply topic (untrusted, hints only). Telegram (recommended: replies are authenticated): create a bot with @BotFather, send it any message, then `ouro secret set TELEGRAM_BOT_TOKEN` and `ouro notify telegram` to detect the chat.

**Raise the inference budget or switch to capital funding.** Show the numbers: spend per day, cost per episode, what the extra spend would buy, expected return. They decide; never route around the limit.

**Decisions only they can make**: a risk threshold, a venue whose terms are ambiguous for their jurisdiction, anything the Charter reserves to them. Give a recommendation and the default you will take if they do not answer within a stated time (only for reversible choices).

## Etiquette

- One message per topic, updated by reply rather than repeated. Non-urgent items are rate-limited per day.
- When they answer, acknowledge, act, and confirm the result in one line.
- Report bad news first, with the number and what you have done about it.
- Do not ask for confirmation of things inside your remit. Do not narrate routine work.
