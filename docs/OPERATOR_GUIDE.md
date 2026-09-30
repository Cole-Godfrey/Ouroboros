# Operator guide

This guide covers installing, running, watching and stopping Ouroboros. The design is described in [SYSTEM.md](SYSTEM.md).

## Before you start

You are giving an autonomous program a hot wallet and a VM with root. Three decisions bound your exposure, so make them first. The first is how much money to fund. The default is $1 plus $0.25 to $1 of ETH for gas, and that is the most it can lose in trading. The second is which model pays for thinking. By default the agent starts on a free model and pays for any upgrade from its own capital, so your inference cost is zero. If you would rather sponsor a paid model, pass `--mode sponsor` to `ouro init` and choose a daily limit, which defaults to $5 a day or about $150 a month. The third is your jurisdiction, such as `US-CA`, `DE` or `SG`, which the agent uses to avoid venues you may not lawfully use. Trades are taxable events in most places, and the agent keeps a complete trade log you can export.

If you ever let the agent or yourself use a paid model, set a hard spending limit on that key in the provider's console first. Everything inside the VM is a tripwire, and the provider console is a wall.

## Requirements

You need a Mac on macOS 13 or newer with [Homebrew](https://brew.sh), about 8 GiB of RAM and 80 GiB of disk to spare, kept on power. Apple silicon and Intel both work, and the VM uses Apple's Virtualization.framework through [Lima](https://lima-vm.io) 2.0 or newer. You also need a free [OpenRouter](https://openrouter.ai) account and API key, which is what the agent uses to reach free models, the free [ntfy](https://ntfy.sh) app on your phone or a Telegram bot, and USDC on Base plus a little ETH on Base, sent from an exchange or wallet you control.

## Install

Clone the repository on your Mac, check out the branch and run the installer. It is safe to run again.

```sh
git clone https://github.com/Cole-Godfrey/Ouroboros
cd Ouroboros
git checkout claude/stoic-hamilton-k9fz00
./vm/mac/setup.sh --keep-awake
```

The installer installs Lima with Homebrew and creates an Ubuntu 24.04 VM named `ouroboros` with 4 CPUs, 8 GiB of RAM, 80 GiB of disk and no shared folders. It copies only the committed repository into the VM and runs `vm/provision/provision.sh` inside it, which installs Node 22, Pi and the dependencies, the egress firewall, the boot supervisor and the systemd services. It then turns on start-at-login, puts an `ouro` shortcut in `~/.local/bin`, and starts `ouro init`. The options are `--name`, `--cpus`, `--memory`, `--disk`, `--no-init` and `--keep-awake`. Make sure `~/.local/bin` is on your `PATH`, because the shortcut runs `limactl shell ouroboros -- ouro ...`.

The `--keep-awake` option installs a LaunchAgent that runs `caffeinate`. A sleeping Mac freezes the VM and the agent with it, and a closed laptop lid still sleeps the Mac unless it is on power with an external display. If `limactl create` rejects `vm/lima/ouroboros.yaml`, note that the file was written from the Lima 2.x documentation and has never booted on a Mac, so the fix is usually a line or two. Nothing else in the repository depends on it.

## First-time setup

`ouro init` runs at the end of the installer and can be run again at any time, because it never overwrites an existing wallet, key or seal. It asks for your timezone, which defines the budget day, and your jurisdiction and name. It asks for the provider and model, which default to `openrouter` and NVIDIA's free Nemotron 3 Ultra, then for the API key, which it checks against the provider and stores encrypted in the vault. It creates a private ntfy topic and prints the URL to subscribe to, and offers Telegram for authenticated two-way chat. It creates the agent's EVM wallet once and prints its address. It asks you to read `agent/CHARTER.md` and then seals its hash, so any later edit is detected, and it creates the first immutable release the supervisor can roll back to.

For scripts, use the non-interactive form, for example `ouro init --yes --timezone Europe/Berlin --jurisdiction DE --key-from-env OPENROUTER_API_KEY`. To use another provider, store its key with `ouro secret set OPENAI_API_KEY` and run `ouro model set <model> --provider openai`. Providers that Pi supports but the metering proxy does not, which are Google, Mistral, Cerebras and GitHub Copilot, receive the key directly. Spend is then recorded from Pi's own usage numbers and caps are enforced less tightly, so prefer a metered provider.

## Verify

Run `ouro doctor --deep`. Every line should pass. The ones to look at are the vault and key lines, which are fixed with `ouro secret set OPENROUTER_API_KEY`, the charter line, which is explained below, and the audit log line, where a failure means the hash chain is broken and should be treated as a security incident. The daemon lines are fixed with `ouro start` followed by `ouro logs boot`. The most important line says the VM cannot reach the host or LAN services. If it fails, the egress firewall is not active. Run `sudo /opt/ouroboros/firewall/firewall.sh apply`, read its output, and do not fund the agent until the check passes. The `--deep` option also loads the agent extension in the real Pi, and if that fails you should not start the agent.

## Fund the wallet

`ouro wallet` prints the agent's EVM address and a Basescan link. The same address works on Base, Arbitrum, Optimism, Polygon and Ethereum. Send USDC on Base, not another chain, choosing the Base network when you withdraw from an exchange, and check the sending app's minimum. Also send $0.25 to $1 of ETH on Base for gas, because without any ETH the wallet cannot transact. A swap costs a fraction of a cent to a few cents, and the ETH counts toward NAV.

Then record the total in dollars so the deposit counts as capital and not profit, for example `ouro fund add 1.25 --venue evm-wallet`. The built-in wallet adapter does not detect deposits by itself yet, so without this step the deposit shows up as an unexplained NAV rise and an incident. Finally run `ouro wallet export` once, in an interactive terminal, and keep the key in a password manager. If the VM disk is lost the funds go with it. Withdrawals you make yourself are recorded with `ouro fund out <usd>`, and money from an address the system does not know waits in `ouro fund inflows` until you classify it with `ouro fund resolve <id> capital|income|ignore`. Only send what you are prepared to lose.

## Start

Run `ouro start`. The service also starts at boot and when the Mac logs in. The first episode runs at once. The agent checks its environment, runs the test suite, checks that its free model is still the best one available, writes a one-page world model and sends you one inbox item with its wallet address, the funding steps and any questions. It then researches and builds paper-trading tooling while it waits. Watch it with `ouro logs -f`, `ouro inbox` and `ouro dashboard`, which prints the address of a read-only page on `127.0.0.1:7777` behind a token. Expect the first weeks to produce notes, code and a paper-trading record and not profit.

## When the agent asks for something

Requests arrive in the inbox and on your phone with the reason, numbered steps, the exact secret names and what the agent does meanwhile. Answer with `ouro reply <id> <text>`, or from ntfy or Telegram, and close finished items with `ouro done <id>`.

To create an account or pass KYC, use your real details on the venue's own site, since the agent never creates accounts in your name. To create an API key, enable read and trade permissions only and never enable withdrawals, then store it with `ouro secret set NAME` for each name the agent lists. The agent can use a secret through `secret_exec` and its venue adapters but never sees the value. To fund a venue account, move the amount it asks for and run `ouro fund add <usd> --venue <id>`. To give it a smarter model, store that provider's key and let the agent switch, or run `ouro model set` yourself. The agent may only switch to a paid model once its daily allowance, which is 5 percent of NAV, reaches 25 cents. If it asks for something you did not expect, say no with `ouro say "Do not do that, and explain why you asked."`, which wakes it, and your message outranks its plans.

## Day-two operations

When your phone buzzes, read the inbox item and act or reply. Weekly, look at `ouro status`, which shows NAV, growth, budget, venues and strategies, and run `ouro ledger verify` and `ouro selfmod status`. Monthly, check the provider's bill if you use a paid model, run `ouro doctor --deep`, and look at `ouro episodes 20` for failures. At tax time, run `ouro ledger export --kind trades --out trades.csv`, and likewise for `expenses`, `income`, `flows`, `nav` and `llm`.

`ouro pause` stops waking the agent while its strategies keep running, and `ouro resume` undoes it. `ouro halt` stops the agent and all strategies, and `ouro kill` also stops the service. `ouro poke "look at X"` wakes the agent now and `ouro say <text>` sends it a message. `ouro strategy list`, `logs NAME`, `stop NAME` and `start NAME` manage the programs it runs between episodes. `ouro venue list` shows where it holds value, and `ouro venue value <id> <usd>` sets a value for a place with no adapter yet. `ouro chat` opens an interactive Pi session with the agent's tools, and `ouro notify test` sends a test notification.

Operator-owned limits live in `/etc/ouroboros/limits.json`, which is root-owned and accepts the keys `sponsorDailyUsd`, `sponsorTotalUsd`, `perEpisodeUsd`, `blockedVenues` and `maxNonUrgentInboxPerDay`. The daemon uses the lowest of the file, the audit-log copy and `config.json`, and a venue id listed in `blockedVenues` cannot be registered.

## Incidents

The reconciler and daemon raise incidents, the agent has a playbook for each, and you get a phone alert. A `nav_drop` means NAV fell 20 percent between reconcile rounds, and the agent writes a post-mortem. An `unexplained_jump` means NAV rose 25 percent, and at least 25 cents, with no recorded deposit, income or trade. It is usually a deposit you forgot to record with `ouro fund add`, and otherwise it is suspicious. An `unclassified_inflow` means money arrived from an unknown address, which you classify with `ouro fund resolve`. A `guard_tripped` incident means a strategy hit its drawdown guard and was stopped. A `venue_unreachable` incident means a venue keeps failing, so its last value is kept and marked stale.

Two incidents need more care. If the Charter check fails, `agent/CHARTER.md` no longer matches the seal and the agent will not run. In the VM run `cd ~/ouroboros && git log -p -- agent/CHARTER.md` to see who changed it. If the change was yours and intended, run `ouro charter seal`. If not, restore it with `git checkout <last good sha> -- agent/CHARTER.md`, consider `ouro halt`, and treat it as the agent trying to rewrite its own rules. If the audit log check fails, run `ouro halt`, copy `~/.ouroboros/events.jsonl` somewhere safe, and investigate before restarting, assuming tampering or disk damage.

## Changing the harness

The agent owns `~/ouroboros` in the VM and changes it through the self-modification pipeline. Nothing pulls changes from GitHub. To bring in a fix from the repository, copy a patch into the VM and ask the agent to apply and propose it.

```sh
git format-patch -1 -o /tmp/patch && limactl copy /tmp/patch/*.patch ouroboros:/tmp/fix.patch
ouro say "Apply /tmp/fix.patch to your working copy, run the tests and propose it through selfmod."
```

`ouro selfmod status` shows the current release, the last known good one and any probation. `ouro selfmod history` lists promotions and rollbacks, and `ouro selfmod rollback "reason"` returns to the last known good release by hand. The boot supervisor is installed outside the repository and is root-owned, so the pipeline cannot change it. After editing `boot/ouro-boot.mjs`, run `ouro boot install` and then `ouro boot status`.

## Backups and recovery

The wallet key is the one thing that cannot be rebuilt, so export it once with `ouro wallet export`. Everything else is in `~/.ouroboros` inside the VM, which holds the audit log, the agent's notes, strategies and venue adapters, the config and the vault. The vault is encrypted with a key that sits in the same directory, so a backup of the whole directory is as sensitive as the secrets themselves. `limactl copy ouroboros:.ouroboros/events.jsonl .` copies the ledger out. After losing the VM, run the installer again, restore `events.jsonl` and `memory/`, and enter API keys with `ouro secret set`. To keep the same wallet, restore the vault directory or import the exported key as a vault entry named `WALLET_EVM_KEY`.

## Troubleshooting

If `ouro status` says the daemon is not running, run `ouro start` and read `ouro logs boot` and `ouro logs daemon`. If `ouro doctor` says the agent cannot start an episode, read the reason. It is usually a missing key (`ouro secret set OPENROUTER_API_KEY`), a pause (`ouro resume`), a spent sponsor budget (`ouro budget`) or a charter mismatch. If the daemon restarts in a loop after a change, run `ouro selfmod status`, since the supervisor rolls back a crash loop on its own, or run `ouro selfmod rollback "crash loop"`. If the agent thinks badly or fails to reach its model, check `ouro model` and the provider's status, because free models are rate limited and can disappear, and pin another with `ouro model set`. If the dashboard does not open, check that `limactl list` shows the VM running and use the URL from `ouro dashboard`. If the agent stopped after your Mac slept, install keep-awake with `./vm/mac/keep-awake.sh install`. If notifications do not arrive, run `ouro notify test` and check you subscribed to the exact topic URL that `ouro notify ntfy` prints.

Logs are available with `ouro logs [daemon|pi|boot|strategy NAME] [-f] [-n N]`, and every fact the system knows is in the audit log, which `ouro ledger tail 50` and `ouro ledger tail 100 --types trade,expense` read.

## Winding down

Run `ouro say "Wind down: sell everything, send it all to <your address>, then stop."` The agent complies under Charter rule 1. Check `ouro status` until the wallet and venues are empty. Then run `ouro kill`, revoke every API key you created at each venue and provider, and run `limactl stop ouroboros` to freeze the VM or `limactl delete ouroboros` to remove it with everything in it. If the VM or the agent cannot help, use your wallet key backup to move the funds yourself and revoke keys at the venues directly.

## Security checklist

Before funding more than pocket money, confirm the following. A provider-side spending limit is set on any paid key. Exchange keys are trade-only, with withdrawals disabled. `ouro doctor --deep` passes, including host and LAN isolation. The wallet key is backed up outside the VM. You have subscribed to the ntfy topic or linked Telegram, and `ouro notify test` reached your phone. You know the kill switches, which are `ouro halt`, `ouro kill`, `limactl stop ouroboros` and key revocation. You have read `agent/CHARTER.md` and accept that the agent trades in your name. The amount you funded is one you would accept losing entirely.
