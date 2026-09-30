---
name: self-modification
description: How to safely change your own harness: repo map, where to add tools, skills, adapters and tests, how the propose/gate/probation/rollback pipeline behaves, and what to do after a rollback. Use before editing anything under the harness repository.
---

# Changing yourself

## Map (harness repo = `$OURO_CODE`, default `~/ouroboros`. State = `$OURO_HOME`, default `~/.ouroboros`)

| Path | What it is |
| --- | --- |
| `agent/CHARTER.md` | The operator's rules. Sealed by hash. Not yours to edit. |
| `agent/CONSTITUTION.md`, `agent/skills/` | Your manual and skills (injected into every prompt / loaded on demand). |
| `src/pi/extension/` | The Pi extension: your tools, prompt injection, redaction. Add a tool here. |
| `src/core/` | Daemon: ledger (`state.ts`, `eventlog.ts`), `reconciler.ts`, `scheduler.ts`, `runner.ts`, `llm-proxy.ts`, `selfmod.ts`, `procman.ts`, `api.ts`, `daemon.ts`, dashboard. |
| `src/core/venues/` | Reference adapters (`evm-wallet`, `paper`). Your own adapters live in `$OURO_HOME/venues/` instead. |
| `src/toolkit/` | Libraries for strategies (`paper.ts`, `evm.ts`, `client.ts`). |
| `boot/ouro-boot.mjs` | The last-resort supervisor, installed outside the repo (`/opt/ouroboros/boot`). |
| `src/selftest/smoke.ts` | The boot check used by the gate. Protected. |
| `test/` | Unit and integration tests, including a full fake-model episode with the real Pi. |

## The pipeline

1. Edit the working copy with your file tools. `npm run check` (typecheck + tests) tells you what the gate will say. Run it yourself first.
2. `selfmod propose {message}` commits, exports a release, and runs the gate: typecheck, the full test suite, a smoke boot of the candidate daemon (which also loads the extension in the real Pi), and the Charter check. Failing output is returned to you. Nothing is promoted.
3. On success `current` flips atomically and the daemon restarts into the new release **when it is idle** (never mid-episode, at most 15 minutes later).
4. **Probation** (15 min. 60 min if you touched protected paths: boot, selftest, selfmod, charter, eventlog, vault, reconciler, state, vm). The boot supervisor rolls back on a crash loop or if the new release never becomes healthy. The daemon rolls back if your episodes keep failing. Surviving probation makes the release the new "last known good".
5. A rolled-back commit is remembered and cannot be proposed unchanged. Read `selfmod history` and the briefing's rollback note, journal the lesson, and change something before trying again.

## Rules of thumb

- Small diffs. One idea per proposal. Add a test for anything you add: the tests are what protect your future self.
- Write the hypothesis and the metric before the change ("cuts tokens per episode by 20%": check `ouro_status` costs after a day).
- Do not "fix" a failing test by deleting it, and do not edit the gate to make a change pass. If the gate is wrong, fix the gate in its own proposal and say why in the journal.
- Adding dependencies changes `package.json`/`package-lock.json`: the release is rebuilt with `npm ci` (needs network) and takes longer.
- Changes to `agent/skills`, `CONSTITUTION.md` and the extension take effect at the next episode (a fresh Pi process), daemon changes at the restart.
- You can always add your own local skills and notes under `$OURO_HOME/skills` and `$OURO_HOME/memory` without any pipeline.

## Good first improvements (each is a small, testable proposal)

Deposit detection for `evm-wallet` (`flows()` from a block explorer API). A cheaper "monitor only" episode mode. Caching of research notes. A price source for assets the oracle cannot price. Better briefing sections once you know what you actually look at. Stricter or looser incident triggers based on what woke you needlessly.
