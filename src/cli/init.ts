// `ouro init`: one-time interactive setup. safe to re-run.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../core/eventlog.ts';
import { checkCharter, sealCharter, charterSha } from '../core/charter.ts';
import { PROVIDERS, providerKeyEnv } from '../core/llm.ts';
import { SelfMod } from '../core/selfmod.ts';
import { StateStore } from '../core/state.ts';
import { TelegramChannel } from '../core/notify.ts';
import { Vault } from '../core/vault.ts';
import { DEFAULT_CONFIG, loadConfig, type Limits } from '../lib/config.ts';
import { ensureDir, readJson, writeJson } from '../lib/fsx.ts';
import { resolvePaths, ROOT_DIR } from '../lib/paths.ts';
import { ensureEvmWallet } from '../toolkit/evm.ts';
import { NODE_REQUIREMENT, supportedNode } from '../lib/runtime.ts';
import { ask, askHidden, bold, confirm, dim, green, yellow, cyan } from './ui.ts';

/** write a root-owned file: try directly, then via passwordless sudo. */
// // write a root-owned file: try directly, then through passwordless sudo
export function writePrivileged(file: string, content: string): boolean {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content, { mode: 0o644 });
    return true;
  } catch {
    const r = spawnSync('sudo', ['-n', 'sh', '-c', `mkdir -p "${path.dirname(file)}" && cat > "${file}" && chmod 644 "${file}"`], { input: content, encoding: 'utf8' });
    return r.status === 0;
  }
}

// // check a key against the provider's model list. offline or unsure counts as unknown, never as a failure.
async function validateKey(provider: string, key: string): Promise<'ok' | 'rejected' | 'unknown'> {
  const spec = PROVIDERS[provider];
  if (!spec || process.env.OURO_OFFLINE) return 'unknown';
  try {
    const url = provider === 'anthropic' ? `${spec.upstream}/v1/models` : provider === 'openrouter' ? `${spec.upstream}/api/v1/auth/key` : `${spec.upstream}${spec.basePath}/models`;
    const headers: Record<string, string> = provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 200) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// // every step is safe to repeat: existing keys, wallet, seal and release are kept
export async function runInit(flags: Record<string, string | true>): Promise<void> {
  const paths = resolvePaths();
  const interactive = !flags.yes && !!process.stdin.isTTY;
  const say = (s = '') => console.log(s);
  const flag = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);

  say(bold('Ouroboros setup'));
  say(dim(`state: ${paths.home}   harness: ${paths.code}   running from: ${paths.root}`));
  say();

  // // refuse to continue on a node too old to run typescript natively
  // 0. environment
  if (!supportedNode()) throw new Error(`Node ${process.versions.node} is unsupported. Ouroboros needs ${NODE_REQUIREMENT}`);
  for (const d of [paths.home, paths.run, paths.logs, paths.memory, paths.strategies, paths.data, paths.workspace, paths.piAgentDir, paths.sessions, paths.releases]) ensureDir(d);
  fs.chmodSync(paths.home, 0o700);
  const vault = new Vault(paths);
  vault.init();
  vault.loadRedactor();

  // 1. operator + budget
  const cfg = loadConfig(paths);
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  cfg.operator.timezone = flag('timezone') ?? (interactive ? await ask('Your timezone (defines the budget "day")', cfg.operator.timezone !== 'UTC' ? cfg.operator.timezone : detectedTz) : cfg.operator.timezone !== 'UTC' ? cfg.operator.timezone : detectedTz);
  cfg.operator.jurisdiction = flag('jurisdiction') ?? (interactive ? await ask('Your jurisdiction, e.g. US-CA, DE, SG (the agent uses it to avoid venues you may not use)', cfg.operator.jurisdiction) : cfg.operator.jurisdiction);
  cfg.operator.name = flag('name') ?? (interactive ? await ask('Your name (optional, for the agent)', cfg.operator.name) : cfg.operator.name);
  cfg.llm.provider = flag('provider') ?? (interactive ? await ask('LLM provider (openrouter has free models; also anthropic, openai, ...)', cfg.llm.provider) : cfg.llm.provider);
  cfg.llm.model = flag('model') ?? (interactive ? await ask('Main model (a free one by default; the agent can upgrade itself later)', cfg.llm.model) : cfg.llm.model);
  cfg.llm.cheapModel = flag('model') ? cfg.llm.model : cfg.llm.cheapModel;
  // by default the agent starts on a free model and pays for any upgrade from its own capital.
  // sponsor mode (you pay for inference) is opt-in with --mode sponsor
  cfg.budget.mode = flag('mode') === 'sponsor' ? 'sponsor' : flag('mode') === 'capital' ? 'capital' : cfg.budget.mode;
  const sponsored = cfg.budget.mode === 'sponsor';
  const daily = Number(flag('daily-budget') ?? (interactive && sponsored ? await ask('Daily inference budget you will pay for, USD', String(cfg.budget.sponsorDailyUsd)) : cfg.budget.sponsorDailyUsd));
  const perEp = Number(flag('episode-budget') ?? (interactive && sponsored ? await ask('Maximum per episode, USD', String(cfg.budget.perEpisodeUsd)) : cfg.budget.perEpisodeUsd));
  if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(perEp) || perEp <= 0) throw new Error('budgets must be positive numbers');
  cfg.budget.sponsorDailyUsd = daily;
  cfg.budget.perEpisodeUsd = Math.min(perEp, daily);

  // 2. LLM key
  const keyName = providerKeyEnv(cfg.llm.provider);
  if (!keyName) say(yellow(`Unknown provider "${cfg.llm.provider}": store its key yourself with \`ouro secret set\`.`));
  else if (!vault.has(keyName) || flag('key-from-env') || flags['key-stdin']) {
    let key = flag('key-from-env') ? process.env[flag('key-from-env')!] ?? '' : flags['key-stdin'] ? await askHidden('') : '';
    if (!key && interactive) key = await askHidden(`Paste your ${cfg.llm.provider} API key (${keyName})`);
    if (key) {
      const v = await validateKey(cfg.llm.provider, key);
      if (v === 'rejected') say(yellow('The provider rejected that key. Stored anyway; fix it with `ouro secret set ' + keyName + '`.'));
      else say(v === 'ok' ? green('Key accepted by the provider.') : dim('Could not verify the key (offline?); stored.'));
      vault.set(keyName, key, `${cfg.llm.provider} API key`);
    } else say(yellow(`No ${keyName} stored yet. The agent cannot think until you run: ouro secret set ${keyName}`));
  } else say(dim(`${keyName} already in the vault.`));
  say(dim('A free OpenRouter account and key is enough to start. If you later let the agent use a paid model, set a hard spending limit on the key in the provider console: it is the backstop that cannot be edited from inside the VM.'));

  // 3. notifications
  if (!cfg.notify.ntfy.topic) {
    const t = `ouro-${randomBytes(10).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    cfg.notify.ntfy.topic = t;
    cfg.notify.ntfy.replyTopic = `${t}-reply`;
  }
  say();
  say(`${bold('Phone notifications (ntfy):')} install the ntfy app and subscribe to ${cyan(`${cfg.notify.ntfy.server}/${cfg.notify.ntfy.topic}`)}`);
  say(dim(`Replies you publish to ${cfg.notify.ntfy.replyTopic} reach the agent as untrusted hints. For authenticated two-way chat use Telegram.`));
  if (interactive && !vault.has('TELEGRAM_BOT_TOKEN') && (await confirm('Set up Telegram now? (recommended: replies are authenticated by chat id)', false))) {
    const token = await askHidden('Bot token from @BotFather');
    if (token) {
      vault.set('TELEGRAM_BOT_TOKEN', token, 'Telegram bot');
      await ask('Send any message to your bot in Telegram, then press Enter here');
      try {
        const chat = await TelegramChannel.discoverChatId(token);
        if (chat) {
          cfg.notify.telegram.chatId = chat;
          say(green(`Telegram chat ${chat} linked.`));
        } else say(yellow('No message seen. Re-run `ouro notify telegram` later.'));
      } catch (e) {
        say(yellow(`Telegram check failed: ${e instanceof Error ? e.message : e}`));
      }
    }
  }
  writeJson(paths.config, cfg);

  // 4. limits the agent cannot raise
  const store = new StateStore(new EventLog(paths.events, { lockDir: paths.eventsLock }));
  store.append('operator.limits', { sponsorDailyUsd: cfg.budget.sponsorDailyUsd, perEpisodeUsd: cfg.budget.perEpisodeUsd });
  const limits: Limits = { ...readJson<Limits>(paths.limitsFile, {}), sponsorDailyUsd: cfg.budget.sponsorDailyUsd, perEpisodeUsd: cfg.budget.perEpisodeUsd };
  const wroteLimits = writePrivileged(paths.limitsFile, JSON.stringify(limits, null, 2) + '\n');
  say(wroteLimits ? dim(`Limits recorded in ${paths.limitsFile} (root-owned) and in the audit log.`) : yellow(`Could not write ${paths.limitsFile}; limits are still enforced from the audit log.`));

  // 5. wallet
  const w = ensureEvmWallet(vault, paths.wallets);
  say();
  say(`${bold('The agent\'s wallet')} ${dim(w.created ? '(created)' : '(existing)')}: ${cyan(w.address)}`);
  say(dim('Same address on Base, Arbitrum, Optimism, Polygon and Ethereum. Only ever send funds you accept losing.'));

  // 6. charter seal
  const status = checkCharter(paths, paths.root);
  if (status.state === 'sealed-ok') say(dim('Charter already sealed.'));
  else if (status.state === 'mismatch') say(yellow(`Charter differs from its seal (${status.message}). Review agent/CHARTER.md, then run: ouro charter seal`));
  else {
    let go = !interactive;
    if (interactive) {
      say();
      say(bold('Charter'));
      say(dim('These ten rules bind the agent. Read them in agent/CHARTER.md. Sealing records their hash so any later change is detected.'));
      go = await confirm('Seal the Charter as it stands?', true);
    }
    if (go) {
      const sha = charterSha(paths.root)!;
      const okSeal = writePrivileged(paths.charterSeal, sha + '\n');
      say(okSeal ? green(`Charter sealed (${sha.slice(0, 12)}).`) : yellow(`Could not write ${paths.charterSeal}. Run: echo ${sha} | sudo tee ${paths.charterSeal}`));
    }
  }

  // 7. baseline release
  if (!fs.existsSync(paths.current)) {
    if (fs.existsSync(path.join(paths.code, '.git'))) {
      try {
        const sm = new SelfMod({ paths, store, config: () => cfg, requestRestart: () => {} });
        const b = await sm.baseline();
        say(green(`Baseline release ${b.sha.slice(0, 10)} created.`));
      } catch (e) {
        say(yellow(`Baseline release failed: ${e instanceof Error ? e.message : e}`));
      }
    } else say(yellow(`No git repository at ${paths.code}: put the harness there (or set OURO_CODE) and re-run \`ouro init\`.`));
  } else say(dim('Baseline release already present.'));

  say();
  say(bold('Next'));
  say(`  1. ${cyan('ouro start')}           start the daemon (it also starts at boot)`);
  say(`  2. ${cyan('ouro doctor')}          verify everything, including network isolation`);
  say(`  3. Send the agent its first dollar to ${w.address} (USDC on Base), then ${cyan('ouro fund add 1 --venue evm-wallet')}`);
  say(`  4. ${cyan('ouro dashboard')}       open the dashboard from your Mac`);
  say(`  5. ${cyan('ouro inbox')}           the agent will ask you for what it needs`);
}
