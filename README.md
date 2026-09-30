# Ouroboros

An autonomous agent that lives in its own VM on your Mac, starts with $1, and works forever to grow it. It trades whatever it can lawfully reach, buys what it needs out of its own capital, and rewrites its own harness as it learns. You do only what a machine physically cannot: create accounts, hand over API keys, move money.

> **This is an experiment, not an investment.** Fixed costs (fees, gas, inference) dominate at $1, and most attempts to compound tiny capital fail. The most likely outcome is a small loss. Fund it with an amount you would accept losing entirely, and set a hard spending limit on the LLM key at your provider. Nothing here is financial advice. See [`docs/SYSTEM.md`](docs/SYSTEM.md), section 12.

## How it works

- **One goal, ten rules.** Maximise the long-run growth of net asset value. The [Charter](agent/CHARTER.md) is ten rules only you can change; everything else is the agent's call.
- **Episodes.** A small daemon wakes the agent (running on the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) harness) only when something needs thought, briefs it from an independent ledger, and records what it does. Between episodes, programs the agent wrote keep trading.
- **The ledger outranks the model.** A hash-chained audit log and a reconciler that reads balances from the venues themselves decide what is true.
- **Freedom with recovery.** The agent can edit any part of itself. Every change passes a gate (typecheck, tests, boot check), then a probation, and is rolled back automatically if it misbehaves.
- **Contained.** A Lima VM with no shared folders, an egress firewall that blocks your Mac and LAN, an encrypted vault, a metering proxy that holds the LLM key, and kill switches that work from outside.

## Quick start (macOS 13+, Homebrew)

```sh
git clone https://github.com/Cole-Godfrey/Ouroboros
cd Ouroboros && git checkout claude/stoic-hamilton-k9fz00
./vm/mac/setup.sh --keep-awake     # creates the VM, installs everything, starts `ouro init`
ouro doctor --deep                 # verify, including host and LAN isolation
ouro wallet                        # the agent's address: send USDC + a little ETH on Base
ouro fund add 1.25 --venue evm-wallet
ouro start
```

Then answer the inbox item on your phone (`ouro inbox`). The full runbook is [`docs/OPERATOR_GUIDE.md`](docs/OPERATOR_GUIDE.md).

## Everyday commands

```text
ouro status            NAV, P&L, growth, budget, venues, strategies
ouro inbox / reply     what the agent needs from you; answer it
ouro pause | halt      stop waking the agent | stop everything
ouro doctor --deep     check the install and the containment guarantees
ouro ledger verify     check the audit log's hash chain
ouro help              everything else
```

## Repository

| Path | Contents |
| --- | --- |
| `agent/` | Charter (yours), Constitution (the agent's), ten skills, seed memory |
| `src/core/` | Daemon: ledger, reconciler, scheduler, episode runner, metering proxy, self-modification, vault, inbox, API, dashboard |
| `src/pi/extension/` | The Pi extension: the agent's 13 tools, prompt assembly, guards, redaction |
| `src/cli/`, `bin/ouro` | The `ouro` command |
| `src/toolkit/` | Helpers for the agent's own strategy code |
| `boot/` | Last-resort supervisor (installed outside the repo) |
| `vm/` | Lima VM, guest provisioning, firewall, systemd units, Mac setup |
| `test/` | Unit and end-to-end tests |
| `docs/` | [System description](docs/SYSTEM.md) and [operator guide](docs/OPERATOR_GUIDE.md) |

Development needs Node 22.18 or newer (it runs the TypeScript directly): `npm ci && npm run check` runs the typecheck and all tests in about a minute, offline.

## What has and has not been verified

Verified in the build environment: the typecheck and full test suite; the real Pi running end to end against a scripted model through the metering proxy; a full daemon lifecycle (first episode, phone push, cost metering, reconciliation, dashboard); a self-modification through the real gate, promotion, restart and probation in an installed layout; and the provisioning script on a fresh user account.

Not verified: the Lima VM on a Mac (the build ran on Linux), the egress firewall's behaviour (syntax-checked only; the installer self-tests it and `ouro doctor` re-tests it), any live venue or LLM API, and any trading strategy. Details in [`docs/SYSTEM.md`](docs/SYSTEM.md), section 12.

## License

MIT, with the additional note in [`LICENSE`](LICENSE) that nothing here is financial advice.
