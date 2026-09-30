# Operator guide

How to install, run, watch and stop Ouroboros. The design is in [`SYSTEM.md`](SYSTEM.md); this file is the runbook.

## 0. Before you start

You are giving an autonomous program a hot wallet, a VM with root, and an inference budget. Three numbers bound your exposure; pick them before you install:

| Decision | Default | What it limits |
| --- | --- | --- |
| Money you fund | $1 (plus $0.25 to $1 of ETH for gas) | The most it can lose in trading |
| Daily inference budget | $5 a day, $1.50 an episode | The most it can spend of *your* money on thinking (about $150 a month) |
| Spend limit at your LLM provider | none until you set it | The backstop the agent cannot edit from inside the VM |

Set the provider-side limit first. Everything inside the VM is a tripwire; the provider console is a wall.

Also decide your **jurisdiction** (for example `US-CA`, `DE`, `SG`). The agent uses it to avoid venues you may not lawfully use. Trading is a taxable event in most places; the agent keeps a complete trade log and you can export it (section 8).

## 1. Requirements

- A Mac on macOS 13 or newer with [Homebrew](https://brew.sh), about 8 GiB of RAM and 80 GiB of disk to spare, kept on power. Apple silicon and Intel both work; the VM uses Apple's Virtualization.framework through [Lima](https://lima-vm.io) 2.0 or newer.
- An LLM API key. Anthropic is the default; OpenAI, OpenRouter, DeepSeek, Groq, xAI, Together and Fireworks are metered too.
- The free [ntfy](https://ntfy.sh) app on your phone (or a Telegram bot).
- USDC on Base and a little ETH on Base, sent from an exchange or wallet you control.

## 2. Install

1. Clone the repository on your Mac and check out the branch:

   ```sh
   git clone https://github.com/Cole-Godfrey/Ouroboros
   cd Ouroboros
   git checkout claude/stoic-hamilton-k9fz00
   ```

2. Run the installer. It is safe to re-run.

   ```sh
   ./vm/mac/setup.sh --keep-awake
   ```

   It installs Lima with Homebrew, creates an Ubuntu 24.04 VM named `ouroboros` (4 CPUs, 8 GiB RAM, 80 GiB disk, no shared folders), copies only the *committed* repository into the VM, runs `vm/provision/provision.sh` inside it (Node 22, Pi and the dependencies, the egress firewall, the boot supervisor, the systemd services), turns on start-at-login, puts an `ouro` shortcut in `~/.local/bin`, and finally starts `ouro init`. Options: `--name`, `--cpus`, `--memory`, `--disk`, `--no-init`, `--keep-awake`.

   If `limactl create` rejects `vm/lima/ouroboros.yaml`, the file was written from the Lima 2.x documentation and has never booted on a Mac; the fix is usually a line or two. Everything else in the repository is independent of it.

3. Make sure `~/.local/bin` is on your `PATH` so `ouro` works from a Mac terminal. It runs `limactl shell ouroboros -- ouro ...`.

`--keep-awake` installs a LaunchAgent that runs `caffeinate`. A sleeping Mac freezes the VM, and the agent with it. A closed laptop lid still sleeps the Mac unless it is on power with an external display.

## 3. First-time setup: `ouro init`

`setup.sh` runs it for you; run it again any time (it never overwrites an existing wallet, key or seal).

| Prompt | What it does |
| --- | --- |
| Timezone | Defines the "day" for the daily budget |
| Jurisdiction, name | Shown to the agent; the jurisdiction steers venue choice |
| Provider, model | Default `anthropic`, `claude-sonnet-5-5` |
| Daily and per-episode budget | Your inference limits; also written to the root-owned `/etc/ouroboros/limits.json` and the audit log, where the lower value always wins |
| API key | Stored encrypted in the vault; checked against the provider; never shown again |
| ntfy topic | A private random topic is created. Subscribe to the URL it prints |
| Telegram (optional) | Authenticated two-way chat; replies are accepted only from your chat id |
| Wallet | Creates the agent's EVM wallet once and prints its address |
| Charter seal | Read `agent/CHARTER.md` first; sealing records its hash so any later edit is detected |
| Baseline release | The first immutable release the supervisor can roll back to |

Non-interactive form, for scripts: `ouro init --yes --timezone Europe/Berlin --jurisdiction DE --provider anthropic --model claude-sonnet-5-5 --daily-budget 2 --episode-budget 0.5 --key-from-env ANTHROPIC_API_KEY` (or `--key-stdin`).

To use another provider later, store its key (`ouro secret set OPENAI_API_KEY`) and re-run `ouro init --provider openai --model <model id>`. Providers Pi supports but the proxy does not (Google, Mistral, Cerebras, GitHub Copilot) work with the key passed straight through; spend is then recorded from Pi's own usage numbers and caps are enforced less tightly, so prefer a metered provider and always set the provider-side limit.

## 4. Verify: `ouro doctor --deep`

Every line should pass. What the important ones mean:

| Line | If it fails |
| --- | --- |
| `Node 22.18+`, `Pi`, `git` | Re-run `vm/provision/provision.sh` |
| `vault readable`, `<KEY> present` | `ouro secret set ANTHROPIC_API_KEY` |
| `charter sealed and intact` | Unsealed: `ouro init` or `ouro charter seal`. Mismatch: see section 9 |
| `audit log verifies` | The hash chain is broken; treat it as a security incident (section 9) |
| `daemon running`, `heartbeat fresh` | `ouro start`, then `ouro logs boot` and `ouro logs daemon` |
| `internet reachable` | The VM has no outbound network; check Lima and your Mac's network |
| `the VM cannot reach the host or LAN services` | The egress firewall is not active. Run `sudo /opt/ouroboros/firewall/firewall.sh apply` and read its output. Do not fund the agent until this passes |
| `boot check passed` (`--deep`) | The agent extension does not load in the real Pi; do not start the agent |

## 5. Fund the wallet

1. `ouro wallet` prints the agent's EVM address (the same address works on Base, Arbitrum, Optimism, Polygon and Ethereum) and a Basescan link.
2. Send USDC **on Base** (not another chain) to that address. From an exchange, choose the Base network when withdrawing. Check the sending app's minimum.
3. Send $0.25 to $1 of ETH **on Base** for gas. Without any ETH the wallet cannot transact. A swap costs a fraction of a cent to a few cents; the ETH counts toward NAV.
4. Record the total in USD so the deposit is capital, not profit: `ouro fund add 1.25 --venue evm-wallet`. The built-in wallet adapter does not detect deposits by itself yet. Without this step the deposit appears as an unexplained NAV jump and an incident.
5. Keep your own copy of the key: `ouro wallet export` (interactive terminal only) prints it once. Put it in a password manager. If the VM disk is lost, the funds go with it.

Withdrawals you make yourself go the other way: `ouro fund out <usd>`. Money that arrives from an address the system does not know waits in `ouro fund inflows` until you classify it with `ouro fund resolve <id> capital|income|ignore`.

Only send what you are prepared to lose.

## 6. Start

```sh
ouro start        # the service also starts at boot and when the Mac logs in
ouro status
```

The first episode runs at once (trigger `genesis`). It checks its environment, runs the test suite, writes a one-page world model and sends you **one** inbox item: its wallet address, the funding steps, and the questions only you can answer. Then it researches and builds paper-trading tooling while it waits. Watch it with `ouro logs -f`, `ouro inbox` and `ouro dashboard` (a read-only page on `127.0.0.1:7777`, behind a token).

Expect the first weeks to produce notes, code and a paper-trading record, not profit.

## 7. When the agent asks for something

Requests arrive in the inbox and on your phone, complete with why it matters, numbered steps, the exact secret names and what the agent does meanwhile. Reply with `ouro reply <id> <text>` (or from ntfy/Telegram), and close finished items with `ouro done <id>`.

Typical requests and how to do them well:

- **Create an account or pass KYC.** Use your real details on the venue's own site. The agent never creates accounts in your name.
- **Create an API key.** Enable read and trade only. **Never enable withdrawals.** Prefer a key restricted to the venue's smallest useful permission set. Then `ouro secret set KRAKEN_API_KEY` (hidden prompt) for each name it lists. The agent can use a secret through `secret_exec` and its venue adapters but never sees the value.
- **Fund a venue account.** Move the amount it asks for, then `ouro fund add <usd> --venue <id>`.
- **Raise the budget.** `ouro budget set --daily 10` (also raise the provider-side limit). The agent may ask; it may not raise limits itself, and Charter rule 9 forbids working around them.
- **Anything you did not expect.** Say no. `ouro say "Do not do that; explain why you asked."` wakes it and your message outranks its plans.

## 8. Day-two operations

| When | What |
| --- | --- |
| When your phone buzzes | Read the inbox item and act, or reply |
| Weekly | `ouro status` (NAV, growth, budget, venues, strategies); `ouro ledger verify`; `ouro selfmod status` |
| Monthly | Check the provider's bill against `ouro budget`; `ouro doctor --deep`; look at `ouro episodes 20` for failures |
| Tax time | `ouro ledger export --kind trades --out trades.csv`, and likewise `expenses`, `income`, `flows`, `nav`, `llm` |

Useful controls:

- `ouro pause` stops waking the agent (strategies keep running); `ouro resume` undoes it. `ouro halt` stops the agent and all strategies. `ouro kill` also stops the service.
- `ouro poke "look at X"` wakes the agent now; `ouro say <text>` sends it a message and wakes it.
- `ouro strategy list|logs NAME|stop NAME|start NAME` manages the programs it runs between episodes.
- `ouro venue list`, and `ouro venue value <id> <usd>` for a place with no adapter yet.
- `ouro chat` opens an interactive Pi session with the agent's tools, for talking to it directly.
- `ouro notify test` sends a test notification; `ouro notify telegram` (re)links Telegram.

Operator-owned limits live in `/etc/ouroboros/limits.json` (root-owned; keys `sponsorDailyUsd`, `sponsorTotalUsd`, `perEpisodeUsd`, `blockedVenues`, `maxNonUrgentInboxPerDay`). The daemon uses the lowest of the file, the audit-log copy and `config.json`. A venue id listed in `blockedVenues` cannot be registered.

## 9. Incidents

The reconciler and daemon raise incidents; the agent has a playbook for each (`agent/skills/incident-response`) and you get a phone alert. The ones that need you:

| Incident | What it means | What to do |
| --- | --- | --- |
| `nav_drop` | NAV fell 20% between reconcile rounds | The agent investigates and writes a post-mortem. If you doubt it, `ouro pause` |
| `unexplained_jump` | NAV rose 25% (and at least $0.25) with no recorded deposit, income or trade | Usually a deposit or withdrawal you forgot to record: `ouro fund add|out`. Otherwise treat as suspicious |
| `unclassified_inflow` | Money arrived from an unknown address | `ouro fund inflows`, then `ouro fund resolve <id> capital|income|ignore` |
| `guard_tripped` | A strategy hit its drawdown guard and was stopped | Read its post-mortem; the agent decides whether to retire it |
| `venue_unreachable` | A venue snapshot keeps failing | Its last value is kept and marked stale. Check the venue's status page and your keys |
| Charter check failed | `agent/CHARTER.md` no longer matches the seal; **the agent will not run** | See below |
| Audit log broken | The hash chain does not verify | Stop (`ouro halt`), copy `~/.ouroboros/events.jsonl` somewhere safe, and investigate before restarting. Assume tampering or disk damage |

**Charter mismatch.** In the VM run `cd ~/ouroboros && git log -p -- agent/CHARTER.md` to see who changed it. If the change was yours and intended, `ouro charter seal`. If not, restore it (`git checkout <last good sha> -- agent/CHARTER.md`), consider `ouro halt`, and treat it as the agent trying to rewrite its own rules.

## 10. Changing the harness itself

The agent owns `~/ouroboros` in the VM and changes it through the self-modification pipeline (`SYSTEM.md`, section 7). Nothing pulls changes from GitHub. To bring in a fix from the repository, copy a patch into the VM and ask the agent to apply and propose it:

```sh
git format-patch -1 -o /tmp/patch && limactl copy /tmp/patch/*.patch ouroboros:/tmp/fix.patch
ouro say "Apply /tmp/fix.patch to your working copy, run the tests and propose it through selfmod."
```

`ouro selfmod status` shows the current release, the last known good one, and any probation; `ouro selfmod history` lists promotions and rollbacks; `ouro selfmod rollback "reason"` returns to the last known good release by hand.

The boot supervisor is installed outside the repository and root-owned, so the pipeline cannot change it. To update it after editing `boot/ouro-boot.mjs`: `ouro boot install` (keeps a known-good copy) and `ouro boot status`.

## 11. Backups and recovery

- **Wallet key:** `ouro wallet export` once, into a password manager. This is the one thing that cannot be rebuilt.
- **Everything else** is in `~/.ouroboros` inside the VM: the audit log (`events.jsonl`), the agent's notes (`memory/`), its trading programs (`strategies/`) and venue adapters (`venues/`), the config, and the vault. The vault is encrypted with a key that sits in the same directory, so a backup of the whole directory is as sensitive as the secrets themselves. `limactl copy ouroboros:.ouroboros/events.jsonl .` copies the ledger out.
- **Rebuild after losing the VM:** run the installer again, restore `events.jsonl` and `memory/`, and re-enter API keys with `ouro secret set`. To keep the same wallet, restore the vault directory or import the exported key into a new vault entry named `WALLET_EVM_KEY`.

## 12. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `ouro status` says NOT RUNNING | `ouro start`, then `ouro logs boot` and `ouro logs daemon` |
| "agent cannot start an episode: ..." in `ouro doctor` | Read the reason: budget exhausted (`ouro budget`, raise with `ouro budget set`), paused or halted (`ouro resume`), charter mismatch (section 9) |
| Agent "cannot think" | No API key for the provider: `ouro secret set ANTHROPIC_API_KEY` |
| Daemon restarts in a loop after a change | `ouro selfmod status`; the supervisor rolls back a crash loop on its own, or `ouro selfmod rollback "crash loop"` |
| Dashboard does not open | `limactl list` shows the VM running? Then `ouro dashboard` for the URL and token; the port forward is `127.0.0.1:7777` |
| Agent stopped after your Mac slept | Install keep-awake: `./vm/mac/keep-awake.sh install` (`status`, `uninstall`) |
| Notifications do not arrive | `ouro notify test`; check you subscribed to the exact topic URL `ouro notify ntfy` prints |
| Firewall warning at install | `ouro doctor` says whether isolation is active; `sudo /opt/ouroboros/firewall/firewall.sh status` shows the rules |
| `ouro chat` prints nothing useful | It needs an interactive terminal |

Logs: `ouro logs [daemon|pi|boot|strategy NAME] [-f] [-n N]`. Every fact the system knows is in the audit log: `ouro ledger tail 50`, `ouro ledger tail 100 --types trade,expense`.

## 13. Winding down

1. `ouro say "Wind down: sell everything, send it all to <your address>, then stop."` The agent complies under Charter rule 1. Check `ouro status` until the wallet and venues are empty.
2. `ouro kill`, then revoke every API key you created at each venue and the LLM provider.
3. `limactl stop ouroboros` to freeze the VM, or `limactl delete ouroboros` to remove it and everything in it. Back up anything you want first (section 11).

If the VM or the agent cannot help, use your wallet key backup to move the funds yourself, and revoke keys at the venues directly.

## 14. Security checklist before funding more than pocket money

- [ ] Provider-side spending limit set on the LLM key.
- [ ] Exchange keys are trade-only, with withdrawals disabled.
- [ ] `ouro doctor --deep` passes, including host and LAN isolation.
- [ ] The wallet key is backed up outside the VM.
- [ ] You have subscribed to the ntfy topic (or linked Telegram) and `ouro notify test` reached your phone.
- [ ] You know the kill switches: `ouro halt`, `ouro kill`, `limactl stop ouroboros`, key revocation.
- [ ] You have read `agent/CHARTER.md` and are willing to be bound by what the agent does under it: it trades in your name.
- [ ] The amount you funded is an amount you would accept losing entirely.
