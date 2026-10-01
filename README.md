<p align="center">
  <img src="docs/img/ouroboros.png" alt="Ouroboros, a snake eating its own tail" width="180">
</p>

<h1 align="center">Ouroboros</h1>

<p align="center">
  An autonomous agent that lives in its own VM, starts with one dollar and works to grow it.<br>
  It trades what it can lawfully reach, pays for what it needs from its own capital, and rewrites its own harness as it learns.
</p>

<p align="center">
  <a href="docs/SYSTEM.md">System description</a> ·
  <a href="docs/Ouroboros-System-Description.pdf">PDF</a> ·
  <a href="docs/OPERATOR_GUIDE.md">Operator guide</a> ·
  <a href="agent/CHARTER.md">Charter</a>
</p>

> **This is an experiment, not an investment.** Fixed costs such as fees and gas dominate at one dollar, and most attempts to compound tiny capital fail. The most likely outcome is that the dollar shrinks or stays flat. Fund it with an amount you would accept losing entirely. Nothing here is financial advice.

## Overview

The agent has one goal, which is to maximise the long-run growth of its net asset value. Ten rules in the [Charter](agent/CHARTER.md) bind it and only you can change them. Everything else is its own call, including which markets to trade, what to buy and how to change its own code. You do only what a machine cannot, which is to create accounts, hand over API keys and move money.

A daily report is finalized after transfer scans cover 00:00 UTC. Run `ouro report` to print it, or `ouro report --short` for a compact version to post on X. Reports include status, financial results and new activity, and cost no model tokens.

A small daemon wakes the agent, which runs on the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) harness, only when something needs thought. The daemon briefs it from an independent ledger and records what it does, and between episodes the programs the agent wrote keep trading. A hash-chained audit log and a reconciler that reads balances from the venues themselves decide what is true, so the ledger outranks the model.

The agent starts on a free language model because one dollar cannot pay for inference. It can move to a smarter paid model later, through a subscription or an API key, and that cost comes out of its capital. Every change it makes to itself passes a gate of typecheck, tests and a boot check, then a probation, and is rolled back automatically if it misbehaves.

It runs in a Lima VM with no shared folders, behind an egress firewall that blocks your Mac and local network, with an encrypted vault, a metering proxy that holds the model key, and kill switches that work from outside.

## Quick start

You need macOS 13 or newer with Homebrew and a free OpenRouter API key.

```sh
git clone https://github.com/Cole-Godfrey/Ouroboros
cd Ouroboros
./vm/mac/setup.sh --keep-awake     # creates the VM, installs everything, starts `ouro init`
ouro doctor --deep                 # verifies the install, including host and LAN isolation
ouro wallet                        # the agent's address: send USDC and a little ETH on Base
ouro start
ouro fund inflows                  # after the wallet scans the confirmed transfers
ouro fund resolve <id> capital     # classify any deposit from an unknown sender
```

Then answer the inbox item on your phone or with `ouro inbox`. The [operator guide](docs/OPERATOR_GUIDE.md) has the full runbook.

## Everyday commands

```text
ouro status            NAV, profit and loss, growth, budget, venues, strategies
ouro report            latest daily report, finalized after midnight transfer scans
ouro report --short    compact report to copy into X
ouro report --now      interim report for today
ouro inbox, reply      what the agent needs from you, and your answer
ouro model             the model it thinks with, free or paid
ouro pause, halt       stop waking the agent, or stop everything
ouro doctor --deep     check the install and the containment guarantees
ouro ledger verify     check the audit log's hash chain
ouro help              everything else
```

## Repository

| Path | Contents |
| --- | --- |
| `agent/` | The Charter (yours), the Constitution (the agent's), eleven skills and seed memory |
| `src/core/` | The daemon: ledger, reconciler, scheduler, episode runner, metering proxy, self-modification, vault, inbox, API, dashboard |
| `src/pi/extension/` | The Pi extension with the agent's 14 tools, prompt assembly, guards and redaction |
| `src/cli/`, `bin/ouro` | The `ouro` command |
| `src/toolkit/` | Helpers for the agent's own strategy code |
| `boot/` | The last-resort supervisor, installed outside the repository |
| `vm/` | The Lima VM, guest provisioning, firewall, systemd units and Mac setup |
| `test/` | Unit and end-to-end tests |
| `docs/` | The system description, its PDF, the operator guide and the figures |

Development needs Node 22.22.2 or Node 24.15+ with npm 12.2+, which runs the TypeScript directly. Run `npm ci && npm run check` for the typecheck and every test, which takes about a minute and needs no network. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Status

The typecheck and all 125 tests pass on macOS (Apple silicon, Node 24.15) and inside the Ubuntu 24.04 Lima VM (Node 22.23). The Mac installer, guest provisioning, firewall, real Pi boot check, scripted model episodes, reports and self-modification tests were exercised. A clean dependency install has no reported audit vulnerabilities. CI checks macOS and Linux on Node 22 and 24.

Live model calls, funded trading and Intel Mac hardware have not been tested. The agent builds its own trading strategies. See section 12 of the [system description](docs/SYSTEM.md) for the validation scope.

## License

MIT, with the additional note in [LICENSE](LICENSE) that nothing here is financial advice.
