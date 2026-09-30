#!/usr/bin/env node
// `ouro`: the operator's command line. talks to the daemon over its unix socket;
// commands that only read or append to the audit log also work while it is down.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkCharter, charterSha } from '../core/charter.ts';
import { EventLog } from '../core/eventlog.ts';
import { formatStatus, ago, pct, usd } from '../core/format.ts';
import { Inbox } from '../core/inbox.ts';
import { isFreeModel, modelId, providerEnv, providerKeyEnv } from '../core/llm.ts';
import { SelfMod } from '../core/selfmod.ts';
import { DailyReports, type StatusReport } from '../core/report.ts';
import { StateStore } from '../core/state.ts';
import { TelegramChannel } from '../core/notify.ts';
import { Vault, SECRET_NAME_RE } from '../core/vault.ts';
import { deepMerge, loadConfig, loadLimits, type Limits } from '../lib/config.ts';
import { readJson, writeJson } from '../lib/fsx.ts';
import { parseUsd } from '../lib/money.ts';
import { resolvePaths } from '../lib/paths.ts';
import { apiCall, DaemonDown, socketPath } from '../toolkit/client.ts';
import { runDoctor } from './doctor.ts';
import { runInit, writePrivileged } from './init.ts';
import { askHidden, bold, confirm, cyan, dim, die, green, parseArgs, red, table, yellow } from './ui.ts';

// every command resolves the same directories the daemon uses, from OURO_HOME and friends
const paths = resolvePaths();
const say = (s = '') => console.log(s);

// direct access to the ledger and vault for when the daemon is not running.
// the audit log is safe to append to from several processes, so the cli can still record facts offline.
function local() {
  const store = new StateStore(new EventLog(paths.events, { lockDir: paths.eventsLock }));
  return { store, inbox: new Inbox(store, {}), vault: new Vault(paths) };
}

// prefer the daemon's api, fall back to working on the files directly only when the daemon is down
async function viaApi<T>(api: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  try {
    return await api();
  } catch (e) {
    if (e instanceof DaemonDown) return fallback();
    throw e;
  }
}

// keep this list in step with the switch in main() at the bottom of the file
const HELP = `${bold('ouro')}: the Ouroboros operator CLI

${bold('Everyday')}
  status                       NAV, P&L, growth, budget, venues, strategies
  report [--short|--json] [--now]  latest daily UTC report, or an interim update
  inbox [--all]                what the agent needs from you (and the conversation)
  reply <id> <text...>         answer an inbox item
  say <text...>                message the agent (wakes it)
  done <id>                    close an inbox item
  dashboard                    URL of the read-only dashboard
  wallet [export]              the agent's wallet address and how to fund it; export prints the key for your own backup
  fund add <usd> [--venue V] [--note N] [--at ISO] [--ref TX]
                               record money YOU put in (so it is not mistaken for profit)
  fund out <usd> [...]         record money you took out
  fund inflows | resolve <id> capital|income|ignore
  secret set NAME | list | rm NAME     API keys and other secrets (hidden prompt)

${bold('Control')}
  pause | resume | halt        stop waking the agent / stop everything, including strategies
  start | stop | restart | kill    the system service (kill = halt + stop)
  poke [reason]                wake the agent now
  model [set <model> [--provider P]]   the model the agent thinks with (free by default)
  budget [set --daily N --episode N --total N | mode sponsor|capital]

${bold('Inspect')}
  doctor [--deep]              verify the install and the containment guarantees
  episodes [n]   ledger tail [n] [--types a,b] | verify | export --kind trades|expenses|income|flows|nav|llm
  strategy list|stop NAME|start NAME|logs NAME    venue list|value ID USD
  logs [daemon|pi|boot|strategy NAME] [-f] [-n N]
  chat                         talk to the agent directly (interactive Pi with its tools)

${bold('Harness')}
  selfmod status|history|rollback [reason]|baseline     charter status|seal|show
  boot install|status          the last-resort supervisor in /opt/ouroboros/boot
  notify ntfy|telegram|test    phone notifications
  init                         first-time setup (safe to re-run)
`;

// ------------------------------------------------------------------ commands

// show the headline numbers. works offline by folding the audit log.
async function status() {
  await viaApi(
    async () => say(formatStatus(await apiCall('GET', '/v1/status'))),
    () => {
      const { store } = local();
      const now = Date.now();
      say(red('Daemon: NOT RUNNING') + dim('  (showing the last state from the audit log; `ouro start`)'));
      say(formatStatus({ now, metrics: store.state.metrics(now), inbox: { open: store.state.openInbox().length, unseenForAgent: store.state.unseenForAgent().length }, incidents: store.state.openIncidents().length, control: store.state.control, charter: checkCharter(paths, paths.root), venues: store.state.liveVenues().map((v) => ({ id: v.id, strategy: v.strategy, totalUsd: v.latest?.totalUsd, at: v.latest?.ts })) }));
    },
  );
}

// the archived report remains available even when the daemon is stopped.
async function report(flags: Record<string, string | true>) {
  const result = await viaApi(
    () => apiCall<StatusReport>('GET', `/v1/report${flags.now ? '?now=1' : ''}`),
    () => {
      const { store, vault } = local();
      vault.loadRedactor();
      return new DailyReports(paths, store).latest(!!flags.now);
    },
  );
  say(flags.json ? JSON.stringify(result, null, 2) : flags.short ? result.short : result.text);
}

// render one inbox item with its steps, the secrets to set and the conversation so far
function fmtItem(it: any, now: number): string {
  const head = `${bold('#' + it.id)} ${statusColor(it.status)} ${it.kind} from ${it.from} ${dim(ago(now, it.ts))}${it.urgency === 'high' ? red(' URGENT') : ''}`;
  const L = [head, `  ${bold(it.title)}`];
  if (it.body && it.from !== 'operator') L.push(...it.body.split('\n').map((l: string) => `  ${l}`));
  if (it.steps?.length) it.steps.forEach((s: string, i: number) => L.push(`  ${i + 1}. ${s}`));
  if (it.secrets?.length) L.push(`  ${yellow('secrets to set:')} ${it.secrets.map((n: string) => `ouro secret set ${n}`).join('   ')}`);
  if (it.blocking) L.push(`  ${dim('blocking: ' + it.blocking)}`);
  for (const r of it.replies ?? []) L.push(`  ${dim('↳')} ${r.by === 'operator' ? green('you') : cyan(r.by)} ${dim(`(${r.channel ?? 'cli'})`)}: ${r.text}`);
  return L.join('\n');
}
const statusColor = (s: string) => (s === 'open' ? yellow('[open]') : s === 'answered' ? green('[answered]') : dim(`[${s}]`));

// list what the agent needs from the operator. by default only open items.
async function inbox(flags: Record<string, string | true>) {
  const now = Date.now();
  const items: any[] = await viaApi(
    async () => (await apiCall<{ items: any[] }>('GET', `/v1/inbox?all=1&limit=${flags.all ? 40 : 100}`)).items,
    () => local().inbox.all(flags.all ? 40 : 100),
  );
  const shown = (flags.all ? items : items.filter((i) => i.status === 'open' || i.status === 'answered')).sort((a, b) => a.ts - b.ts);
  if (!shown.length) return say(dim(flags.all ? 'Inbox is empty.' : 'Nothing needs you. (`ouro inbox --all` shows history.)'));
  say(shown.map((i) => fmtItem(i, now)).join('\n\n'));
  const open = shown.filter((i) => i.status === 'open' && i.from !== 'operator');
  if (open.length) say(`\n${dim('Answer with:')} ouro reply ${open[0].id} "..."   ${dim('close with:')} ouro done ${open[0].id}`);
}

// answer an inbox item. the daemon wakes the agent when an operator message arrives.
async function reply(pos: string[]) {
  const [id, ...text] = pos;
  if (!id || !text.length) die('usage: ouro reply <id> <text...>');
  await viaApi(() => apiCall('POST', '/v1/inbox/reply', { id: id.replace(/^#/, ''), text: text.join(' '), by: 'operator', channel: 'cli' }), () => local().inbox.reply(id.replace(/^#/, ''), text.join(' '), 'operator', 'cli'));
  say(green('Sent.') + dim(' The agent is woken for operator messages.'));
}

async function sayCmd(pos: string[]) {
  if (!pos.length) die('usage: ouro say <text...>');
  await viaApi(() => apiCall('POST', '/v1/inbox/say', { text: pos.join(' ') }), () => local().inbox.say(pos.join(' ')));
  say(green('Sent.'));
}

// secrets are typed at a hidden prompt or read from an environment variable, never passed as arguments,
// so they do not end up in shell history.
async function secret(pos: string[], flags: Record<string, string | true>) {
  const [sub, name] = pos;
  if (sub === 'list' || !sub) {
    const list: any[] = await viaApi(async () => (await apiCall<{ secrets: any[] }>('GET', '/v1/secrets')).secrets, () => local().vault.list());
    if (!list.length) return say(dim('The vault is empty.'));
    say(table(list.map((s) => [s.name, s.note ?? '', new Date(s.updatedAt).toISOString().slice(0, 16) + 'Z', `${s.length} chars`]), ['NAME', 'NOTE', 'SET', 'LENGTH']));
    return;
  }
  if (sub === 'rm') {
    if (!name) die('usage: ouro secret rm NAME');
    const r: any = await viaApi(() => apiCall('POST', '/v1/secret/delete', { name }), () => ({ ok: local().vault.delete(name) }));
    return say(r.ok ? green('Removed.') : dim('No such secret.'));
  }
  if (sub === 'set') {
    if (!name || !SECRET_NAME_RE.test(name)) die('usage: ouro secret set NAME   (names look like KRAKEN_API_KEY)');
    let value = '';
    if (typeof flags['from-env'] === 'string') value = process.env[flags['from-env']] ?? '';
    else value = await askHidden(`Value for ${name}`);
    if (!value) die('empty value; nothing stored');
    const note = typeof flags.note === 'string' ? flags.note : undefined;
    await viaApi(() => apiCall('POST', '/v1/secret/set', { name, value, note }), () => local().vault.set(name, value, note));
    return say(green(`Stored ${name} (${value.length} chars).`) + dim(' The agent can use it via secret_exec; it never sees the value.'));
  }
  die('usage: ouro secret set NAME | list | rm NAME');
}

// record money the operator moved. this is what keeps a deposit from looking like profit.
// fund add and fund out are flows, inflows lists unknown money waiting to be classified.
async function fund(pos: string[], flags: Record<string, string | true>) {
  const [sub, arg] = pos;
  if (sub === 'add' || sub === 'out') {
    if (!arg) die(`usage: ouro fund ${sub} <usd> [--venue V] [--note N] [--at ISO] [--ref TX]`);
    const usdAmt = parseUsd(arg);
    const at = typeof flags.at === 'string' ? Date.parse(flags.at) : undefined;
    if (at !== undefined && !Number.isFinite(at)) die('--at must be an ISO timestamp, e.g. 2026-10-01T12:00:00Z');
    const body = { direction: sub === 'add' ? 'in' : 'out', usd: usdAmt, venue: typeof flags.venue === 'string' ? flags.venue : undefined, note: typeof flags.note === 'string' ? flags.note : undefined, ref: typeof flags.ref === 'string' ? flags.ref : undefined, at, by: 'operator' };
    const r: any = await viaApi(
      () => apiCall('POST', '/v1/fund', body),
      () => {
        const { store } = local();
        store.append(sub === 'add' ? 'capital.in' : 'capital.out', { usd: usdAmt, venue: body.venue, note: body.note, ref: body.ref, at, by: 'operator' });
        return { netContributedUsd: store.state.netContributedUsd() };
      },
    );
    return say(green(`Recorded ${sub === 'add' ? 'deposit' : 'withdrawal'} of ${usd(usdAmt)}.`) + ` Net contributed capital is now ${usd(r.netContributedUsd)}.`);
  }
  if (sub === 'inflows') {
    const { store } = local();
    const list = store.state.unclassifiedInflows();
    if (!list.length) return say(dim('No unclassified inflows.'));
    say(table(list.map((i) => [i.id, usd(i.usd), i.venue, i.asset ?? '', i.from ?? '', ago(Date.now(), i.ts)]), ['ID', 'USD', 'VENUE', 'ASSET', 'FROM', 'WHEN']));
    return say(dim('\nClassify with: ouro fund resolve <id> capital|income|ignore'));
  }
  if (sub === 'resolve') {
    const [, id, as] = pos;
    if (!id || !['capital', 'income', 'ignore'].includes(as)) die('usage: ouro fund resolve <id> capital|income|ignore');
    await apiCall('POST', '/v1/inflow/resolve', { id, as, by: 'operator' });
    return say(green('Classified.'));
  }
  const { store } = local();
  say(table(store.state.flows.slice(-15).reverse().map((f) => [new Date(f.ts).toISOString().slice(0, 16) + 'Z', f.kind === 'in' ? green('in') : yellow('out'), usd(f.usd), f.venue ?? '', f.note ?? '']), ['WHEN', 'DIR', 'USD', 'VENUE', 'NOTE']));
  say(`\nNet contributed: ${bold(usd(store.state.netContributedUsd()))}`);
}

/** print the wallet's private key once, on a terminal, so the operator can keep their own backup. */
async function walletExport() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('run `ouro wallet export` in an interactive terminal');
  const { vault } = local();
  if (!vault.has('WALLET_EVM_KEY')) die('no wallet yet: run `ouro init`');
  say(yellow('This prints the wallet private key. Anyone who sees it can move the funds.'));
  say('Put it in a password manager, then clear your terminal. Without a copy, losing the VM disk means losing the funds.');
  if (!(await confirm('Print the key now?', false))) return;
  say(vault.get('WALLET_EVM_KEY'));
}

function wallet() {
  const w = readJson<{ evm?: { address: string } }>(paths.wallets, {});
  if (!w.evm) return say(yellow('No wallet yet. Run `ouro init` (or start the daemon).'));
  say(`${bold('EVM address')}  ${cyan(w.evm.address)}  ${dim('(same on Base, Arbitrum, Optimism, Polygon, Ethereum)')}`);
  say(dim(`  https://basescan.org/address/${w.evm.address}`));
  say('\nTo give the agent money: send USDC on Base to that address, plus $0.25 to $1 of ETH on Base for gas (without any ETH the wallet cannot transact; it counts toward NAV),\nthen run: ' + cyan('ouro fund add <amount> --venue evm-wallet') + '\nOnly send what you are prepared to lose. Keep your own copy of the key: ' + cyan('ouro wallet export') + '.');
}

// show or change the model the agent thinks with (the agent can also do this itself)
async function model(pos: string[], flags: Record<string, string | true>) {
  const [sub, name] = pos;
  const cfg = loadConfig(paths);
  if (sub === 'set') {
    if (!name) die('usage: ouro model set <model> [--provider P] [--cheap M] [--thinking LEVEL]');
    const provider = typeof flags.provider === 'string' ? flags.provider : cfg.llm.provider;
    const keyName = providerKeyEnv(provider);
    if (!keyName) die(`unknown provider "${provider}"`);
    const llm: Record<string, string> = { provider, model: name, cheapModel: typeof flags.cheap === 'string' ? flags.cheap : name };
    if (typeof flags.thinking === 'string') llm.thinking = flags.thinking;
    writeJson(paths.config, deepMerge(readJson<Record<string, unknown>>(paths.config, {}), { llm }));
    if (!local().vault.has(keyName)) say(yellow(`${keyName} is not in the vault yet: ouro secret set ${keyName}`));
    return say(green(`Model is now ${provider}/${name}${isFreeModel(name) ? ' (free)' : ''}. It applies from the next episode.`));
  }
  const free = isFreeModel(cfg.llm.model);
  say(`${bold(cfg.llm.provider + '/' + cfg.llm.model)} ${free ? green('free') : yellow('paid, funded by ' + cfg.budget.mode)}  routine tier: ${cfg.llm.cheapModel}  thinking: ${cfg.llm.thinking}`);
  say(dim('Change with: ouro model set <model> [--provider P]. The agent may also switch when it judges a smarter model is worth its cost.'));
}

// inference limits. raising a limit writes three places (config, audit log, root-owned file)
// because the daemon always enforces the lowest of them.
async function budget(pos: string[], flags: Record<string, string | true>) {
  const [sub, arg] = pos;
  const cfg = loadConfig(paths);
  if (sub === 'set') {
    const patch: any = { budget: {} };
    const opLimits: any = {};
    const setNum = (flag: string, key: string, limitKey: string) => {
      if (typeof flags[flag] !== 'string') return;
      const n = Number(flags[flag]);
      if (!Number.isFinite(n) || n <= 0) die(`--${flag} must be a positive number`);
      patch.budget[key] = n;
      opLimits[limitKey] = n;
    };
    setNum('daily', 'sponsorDailyUsd', 'sponsorDailyUsd');
    setNum('episode', 'perEpisodeUsd', 'perEpisodeUsd');
    setNum('total', 'sponsorTotalUsd', 'sponsorTotalUsd');
    if (!Object.keys(patch.budget).length) die('usage: ouro budget set [--daily N] [--episode N] [--total N]');
    writeJson(paths.config, deepMerge(readJson<Record<string, unknown>>(paths.config, {}), patch));
    const { store } = local();
    store.append('operator.limits', opLimits);
    const limits: Limits = { ...loadLimits(paths), ...opLimits };
    const wrote = writePrivileged(paths.limitsFile, JSON.stringify(limits, null, 2) + '\n');
    say(green('Budget updated.') + (wrote ? '' : dim(' (could not write the root-owned limits file; the audit-log copy is enforced)')));
    return;
  }
  // sponsor means the operator pays for thinking, capital means the agent pays from its own nav
  if (sub === 'mode') {
    if (!['sponsor', 'capital'].includes(arg)) die('usage: ouro budget mode sponsor|capital');
    if (arg === 'capital') say(yellow('In capital mode the agent pays for its own thinking out of NAV (capped at ' + (cfg.budget.capitalMaxDailyPctNav * 100).toFixed(0) + '% of NAV per day). With small NAV that may leave it unable to think.'));
    writeJson(paths.config, deepMerge(readJson<Record<string, unknown>>(paths.config, {}), { budget: { mode: arg } }));
    return say(green(`Inference is now ${arg}-funded.`));
  }
  const s: any = await viaApi(() => apiCall('GET', '/v1/budget'), () => null);
  if (s) {
    say(`Mode ${bold(s.mode)}: today ${usd(s.spentTodayUsd)} of ${usd(s.dailyLimitUsd)} · per episode ≤ ${usd(s.episodeBudgetUsd)} · lifetime ${usd(s.spentTotalUsd)}${s.totalLimitUsd !== null ? ` of ${usd(s.totalLimitUsd)}` : ''}`);
    if (s.exhausted) say(red(`Exhausted: ${s.reason}`));
  } else say(`Configured: $${cfg.budget.sponsorDailyUsd}/day, $${cfg.budget.perEpisodeUsd}/episode, mode ${cfg.budget.mode} (daemon not running)`);
  say(dim('Raise with: ouro budget set --daily 10   (also set the spending limit at your provider)'));
}

// pause stops waking the agent, halt also stops every strategy
async function control(action: 'pause' | 'resume' | 'halt') {
  await viaApi(() => apiCall('POST', '/v1/control', { action, by: 'operator' }), () => local().store.append('control', { action, by: 'operator' }));
  say(action === 'pause' ? yellow('Paused: the agent will not be woken; strategies keep running.') : action === 'halt' ? red('Halted: the agent and all strategies are stopped.') : green('Resumed.'));
}

// recent episodes with their trigger, outcome, cost and handoff note
async function episodes(n: number) {
  const { store } = local();
  const now = Date.now();
  const eps = store.state.episodes.slice(-n).reverse();
  if (!eps.length) return say(dim('No episodes yet.'));
  say(table(eps.map((e) => [e.id, ago(now, e.startedAt), e.reason, e.outcome ?? 'running', usd(e.costUsd), String(e.turns ?? ''), (e.handoff ?? e.error ?? '').replace(/\s+/g, ' ').slice(0, 70)]), ['EPISODE', 'STARTED', 'TRIGGER', 'OUTCOME', 'COST', 'TURNS', 'HANDOFF']));
}

// read or check the audit log. export writes csv for tax records.
async function ledger(pos: string[], flags: Record<string, string | true>) {
  const { store } = local();
  const [sub, arg] = pos;
  if (sub === 'verify') {
    const v = store.log.verify();
    say(v.ok ? green(`Audit log verifies: ${v.count} events, head ${v.headHash.slice(0, 16)}…`) : red(`BROKEN at event ${v.error?.seq}: ${v.error?.reason}`));
    process.exit(v.ok ? 0 : 1);
  }
  if (sub === 'export') {
    const kind = String(flags.kind ?? 'trades');
    const st = store.state;
    const rows: Array<Array<string | number>> =
      kind === 'trades' ? [['time', 'venue', 'market', 'side', 'qty', 'price', 'fee_usd', 'pnl_usd', 'strategy'], ...st.trades.map((t) => [new Date(t.ts).toISOString(), t.venue, t.market, t.side, t.qty, t.price, t.feeUsd, t.pnlUsd ?? '', t.strategy ?? ''])] :
      kind === 'flows' ? [['time', 'direction', 'usd', 'venue', 'note', 'ref'], ...st.flows.map((f) => [new Date(f.ts).toISOString(), f.kind, f.usd, f.venue ?? '', f.note ?? '', f.ref ?? ''])] :
      kind === 'nav' ? [['time', 'nav_usd'], ...st.navSeries.map((p) => [new Date(p.ts).toISOString(), p.usd])] :
      kind === 'llm' ? [['time', 'model', 'usd', 'funding'], ...st.llm.entries.map((e) => [new Date(e.ts).toISOString(), e.model, e.usd, e.funding])] :
      kind === 'expenses' || kind === 'income' ? store.log.readAll().filter((e) => e.type === kind).reduce<Array<Array<string | number>>>((acc, e) => (acc.push([new Date(e.ts).toISOString(), e.data.usd, e.data.category ?? '', e.data.funding ?? '', e.data.counterparty ?? '', e.data.memo ?? '', e.data.ref ?? '']), acc), [['time', 'usd', 'category', 'funding', 'counterparty', 'memo', 'ref']]) :
      die('--kind must be trades|expenses|income|flows|nav|llm');
    const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
    if (typeof flags.out === 'string') {
      fs.writeFileSync(flags.out, csv + '\n');
      return say(green(`Wrote ${rows.length - 1} rows to ${flags.out}`));
    }
    return say(csv);
  }
  const n = Number(arg ?? 20);
  const types = typeof flags.types === 'string' ? flags.types.split(',') : undefined;
  const all = store.log.readAll().filter((e) => !types || types.some((t) => e.type === t || e.type.startsWith(t + '.')));
  for (const e of all.slice(-n)) say(`${dim(String(e.seq).padStart(5))} ${dim(new Date(e.ts).toISOString().slice(0, 19))} ${bold(e.type)} ${JSON.stringify(e.data).slice(0, 220)}`);
}

// manage the long-running programs the agent registered
async function strategy(pos: string[], flags: Record<string, string | true>) {
  const [sub, name] = pos;
  if (sub === 'list' || !sub) {
    const r = await apiCall<{ strategies: any[] }>('GET', '/v1/strategies');
    if (!r.strategies.length) return say(dim('No strategies registered.'));
    return say(table(r.strategies.map((s) => [s.name, s.status, s.desired, String(s.restarts), s.lastExit ?? '', (s.spec.venue ?? '')]), ['NAME', 'STATUS', 'DESIRED', 'RESTARTS', 'LAST EXIT', 'VENUE']));
  }
  if (!name) die(`usage: ouro strategy ${sub} NAME`);
  if (sub === 'logs') return say((await apiCall<{ logs: string }>('GET', `/v1/strategy/logs?name=${encodeURIComponent(name)}&lines=${Number(flags.n ?? 80)}`)).logs);
  if (sub === 'stop' || sub === 'start') {
    await apiCall('POST', '/v1/strategy', { action: sub, name, by: 'operator' });
    return say(green(`${sub === 'stop' ? 'Stopped' : 'Started'} ${name}.`));
  }
  die('usage: ouro strategy list|stop NAME|start NAME|logs NAME');
}

// list the places the agent holds value, or set a manual value for one without an adapter
async function venue(pos: string[]) {
  const [sub, id, amount] = pos;
  if (sub === 'value') {
    if (!id || !amount) die('usage: ouro venue value ID USD');
    await apiCall('POST', '/v1/venue/value', { id, usd: parseUsd(amount), note: 'manual valuation by operator' });
    return say(green('Recorded.'));
  }
  const { store } = local();
  const now = Date.now();
  say(table(store.state.liveVenues().map((v) => [v.id, v.kind ?? '', v.latest ? usd(v.latest.totalUsd) : '-', v.latest ? ago(now, v.latest.ts) : 'never', v.strategy ?? '', v.lastError ? red('error') : '']), ['VENUE', 'KIND', 'VALUE', 'RECONCILED', 'STRATEGY', '']));
}

// inspect the self-modification pipeline or roll back by hand
async function selfmod(pos: string[]) {
  const [sub, ...rest] = pos;
  const { store } = local();
  const cfg = loadConfig(paths);
  const sm = new SelfMod({ paths, store, config: () => cfg, requestRestart: () => {} });
  if (sub === 'baseline') {
    const b = await sm.baseline();
    return say(green(`Baseline release ${b.sha.slice(0, 10)} installed at ${b.dir}`));
  }
  if (sub === 'rollback') {
    const r = await viaApi(() => apiCall<any>('POST', '/v1/selfmod/rollback', { reason: rest.join(' ') || 'operator request', by: 'operator' }), () => sm.rollback(rest.join(' ') || 'operator request', 'operator'));
    return say(r.ok ? green(`Rolled back ${r.from?.slice(0, 10)} → ${r.to?.slice(0, 10)}. The daemon restarts into it when idle.`) : yellow(r.reason ?? 'nothing to roll back'));
  }
  if (sub === 'history') {
    const h = sm.history(25);
    return say(table(h.map((x) => [new Date(x.ts).toISOString().slice(0, 16) + 'Z', x.kind, x.sha?.slice(0, 10) ?? '', x.risk ?? '', (x.message ?? x.reason ?? '').slice(0, 70)]), ['WHEN', 'EVENT', 'RELEASE', 'RISK', 'DETAIL']));
  }
  const s = sm.status();
  say(`current ${bold(s.current?.slice(0, 10) ?? 'none')}   last-known-good ${bold(s.lkg?.slice(0, 10) ?? 'none')}   running ${s.running?.slice(0, 10) ?? 'n/a'}`);
  if (s.promotion) say(`promotion ${s.promotion.id}: ${s.promotion.state}${s.promotion.probationUntil ? `, probation until ${new Date(s.promotion.probationUntil).toISOString()}` : ''}${s.promotion.reason ? ` (${s.promotion.reason})` : ''}`);
  say(`working copy: ${s.workingCopy.dirty ? yellow('uncommitted changes') : 'clean'}, ${s.workingCopy.ahead} commit(s) ahead, ${s.workingCopy.changedFiles.length} file(s) differ from the running release`);
}

// the charter is sealed by hash. seal records the current hash after the operator reviewed it.
function charter(pos: string[]) {
  const [sub] = pos;
  if (sub === 'seal') {
    const sha = charterSha(paths.root);
    if (!sha) die('charter file missing');
    if (writePrivileged(paths.charterSeal, sha + '\n')) return say(green(`Sealed ${sha.slice(0, 12)} in ${paths.charterSeal}`));
    die(`could not write ${paths.charterSeal}; run: echo ${sha} | sudo tee ${paths.charterSeal}`);
  }
  if (sub === 'show') return say(fs.readFileSync(path.join(paths.root, 'agent', 'CHARTER.md'), 'utf8'));
  const c = checkCharter(paths, paths.root);
  say(`${c.ok ? green(c.state) : red(c.state)}: ${c.message}`);
}

// set up phone notifications through ntfy or telegram
async function notify(pos: string[]) {
  const [sub] = pos;
  const cfg = loadConfig(paths);
  if (sub === 'ntfy') {
    say(`Subscribe in the ntfy app to ${cyan(`${cfg.notify.ntfy.server}/${cfg.notify.ntfy.topic}`)}`);
    return say(dim(`The agent reads your replies from ${cfg.notify.ntfy.replyTopic} (untrusted).`));
  }
  if (sub === 'telegram') {
    const token = local().vault.has('TELEGRAM_BOT_TOKEN') ? local().vault.get('TELEGRAM_BOT_TOKEN')! : await askHidden('Bot token from @BotFather');
    if (!token) die('no token');
    local().vault.set('TELEGRAM_BOT_TOKEN', token, 'Telegram bot');
    say('Send any message to your bot in Telegram now...');
    for (let i = 0; i < 20; i++) {
      const chat = await TelegramChannel.discoverChatId(token).catch(() => undefined);
      if (chat) {
        writeJson(paths.config, deepMerge(readJson<Record<string, unknown>>(paths.config, {}), { notify: { telegram: { chatId: chat } } }));
        return say(green(`Linked Telegram chat ${chat}. Only messages from this chat are trusted.`));
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return die('no message received from Telegram within a minute');
  }
  if (sub === 'test') {
    await viaApi(() => apiCall('POST', '/v1/inbox/send', { kind: 'info', title: 'Test notification', body: 'If you can read this on your phone, notifications work. Reply with "#<id> ok" to test replies.', urgency: 'high' }), () => local().inbox.create({ kind: 'info', from: 'system', title: 'Test notification', body: 'If you can read this on your phone, notifications work.', urgency: 'high' }));
    return say(green('Queued: the daemon pushes it within about 20 seconds.'));
  }
  die('usage: ouro notify ntfy|telegram|test');
}

// tail one of the log files. boot is the supervisor's output.
function logs(pos: string[], flags: Record<string, string | true>) {
  const [which, name] = pos;
  const file = which === 'pi' ? path.join(paths.logs, 'pi-stderr.log') : which === 'boot' ? path.join(paths.logs, 'daemon.out.log') : which === 'strategy' && name ? path.join(paths.logs, `strategy-${name}.log`) : path.join(paths.logs, 'daemon.log');
  if (!fs.existsSync(file)) die(`no log at ${file}`);
  const args = ['-n', String(flags.n ?? 60), ...(flags.f ? ['-f'] : []), file];
  spawnSync('tail', args, { stdio: 'inherit' });
}

// an interactive pi session with the same tools the agent has. model traffic still goes through
// the metering proxy when the daemon is up, so the conversation is metered like any episode.
async function chat() {
  const cfg = loadConfig(paths);
  const vault = new Vault(paths);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PI_CODING_AGENT_DIR: paths.piAgentDir, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', OURO_HOME: paths.home, OURO_CODE: paths.code, OURO_ROOT: paths.root, OURO_SOCK: socketPath() };
  let proxy: { url: string; token: string } | undefined;
  try {
    const t = await apiCall<{ token: string | null; url: string | null }>('POST', '/v1/llm/token', { label: 'operator chat' });
    if (t.token && t.url) proxy = { url: t.url, token: t.token };
  } catch {
    say(dim('(daemon not reachable: tools that need it will say so; using your key directly)'));
  }
  const keyEnv = providerKeyEnv(cfg.llm.provider);
  Object.assign(env, providerEnv({ provider: cfg.llm.provider, proxy, secret: keyEnv && vault.has(keyEnv) ? vault.get(keyEnv) : undefined }));
  const pi = [path.join(paths.root, 'node_modules', '.bin', 'pi'), path.join(paths.code, 'node_modules', '.bin', 'pi')].find((p) => fs.existsSync(p)) ?? 'pi';
  say(dim('You are talking to the agent directly. Your messages are operator instructions. Ctrl-D to leave.\n'));
  const child = spawn(pi, ['--provider', cfg.llm.provider, '--model', modelId(cfg.llm.model, cfg.llm.provider), '--thinking', cfg.llm.thinking, '-e', path.join(paths.root, 'src', 'pi', 'extension', 'index.ts'), '--skill', path.join(paths.root, 'agent', 'skills'), '--skill', path.join(paths.home, 'skills'), '--session-dir', paths.sessions, '--name', `chat-${new Date().toISOString().slice(0, 16)}`], { stdio: 'inherit', env, cwd: paths.workspace });
  child.on('exit', (c) => process.exit(c ?? 0));
}

// start, stop or restart the system service. needs passwordless sudo, which the vm provides.
function systemctl(verb: string) {
  const r = spawnSync('sudo', ['-n', 'systemctl', verb, 'ouroboros'], { stdio: 'inherit' });
  if (r.status !== 0) die(`systemctl ${verb} ouroboros failed (is the service installed? provisioning does that)`);
}

// print the dashboard address. the token keeps other local processes from reading it.
function dashboard() {
  const cfg = loadConfig(paths);
  let token = '';
  try {
    token = fs.readFileSync(paths.dashboardToken, 'utf8').trim();
  } catch {
    die('no dashboard token yet: start the daemon first');
  }
  say(`${bold('Dashboard')} ${cyan(`http://localhost:${cfg.dashboard.port}/?token=${token}`)}`);
  say(dim('Open that on your Mac: the VM forwards its localhost port automatically. Read-only.'));
}

// install or inspect the boot supervisor, which lives outside the repository on purpose
// so the agent's own changes cannot replace it.
function boot(pos: string[]) {
  const [sub] = pos;
  const target = '/opt/ouroboros/boot';
  const src = path.join(paths.root, 'boot', 'ouro-boot.mjs');
  if (sub === 'install') {
    const check = spawnSync(process.execPath, ['--check', src], { encoding: 'utf8' });
    if (check.status !== 0) die(`the new boot supervisor fails a syntax check:\n${check.stderr}`);
    const r = spawnSync('sudo', ['-n', 'sh', '-c', `mkdir -p ${target} && { [ -f ${target}/ouro-boot.mjs ] && cp -f ${target}/ouro-boot.mjs ${target}/ouro-boot.lkg.mjs; }; cp -f "${src}" ${target}/ouro-boot.mjs && sudo -n systemctl restart ouroboros`], { stdio: 'inherit' });
    if (r.status !== 0) die('installing the boot supervisor failed');
    return say(green('Boot supervisor installed (the previous copy is kept as ouro-boot.lkg.mjs and used automatically if the new one dies at start-up).'));
  }
  say(fs.existsSync(`${target}/ouro-boot.mjs`) ? green('installed') + `: ${target}/ouro-boot.mjs` + (fs.existsSync(`${target}/ouro-boot.lkg.mjs`) ? dim(' (+ lkg copy)') : '') : yellow('not installed'));
}

// wake the agent now instead of waiting for its next scheduled episode
async function poke(pos: string[]) {
  await apiCall('POST', '/v1/poke', { reason: pos.join(' ') || 'poked by operator' });
  say(green('The agent will start an episode shortly (budget permitting).'));
}

// ---------------------------------------------------------------------- main

// dispatch on the first word. the agent and the operator use the same commands.
async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2), ['yes', 'all', 'deep', 'f', 'stdin', 'key-stdin', 'short', 'json', 'now']);
  const [cmd, ...rest] = pos;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return say(HELP);
    case 'init':
      return runInit(flags);
    case 'status':
      return status();
    case 'report':
      return report(flags);
    case 'doctor':
      process.exit(await runDoctor(!!flags.deep));
      return;
    case 'inbox':
      return inbox(flags);
    case 'reply':
      return reply(rest);
    case 'say':
      return sayCmd(rest);
    case 'done':
      if (!rest[0]) die('usage: ouro done <id>');
      await viaApi(() => apiCall('POST', '/v1/inbox/status', { id: rest[0].replace(/^#/, ''), status: 'done', by: 'operator' }), () => local().inbox.setStatus(rest[0].replace(/^#/, ''), 'done', 'operator'));
      return say(green('Closed.'));
    case 'secret':
      return secret(rest, flags);
    case 'fund':
      return fund(rest, flags);
    case 'wallet':
      return rest[0] === 'export' ? walletExport() : wallet();
    case 'model':
      return model(rest, flags);
    case 'budget':
      return budget(rest, flags);
    case 'pause':
    case 'resume':
    case 'halt':
      return control(cmd);
    case 'poke':
      return poke(rest);
    case 'episodes':
      return episodes(Number(rest[0] ?? 15));
    case 'ledger':
      return ledger(rest, flags);
    case 'strategy':
      return strategy(rest, flags);
    case 'venue':
      return venue(rest);
    case 'selfmod':
      return selfmod(rest);
    case 'charter':
      return charter(rest);
    case 'notify':
      return notify(rest);
    case 'logs':
      return logs(rest, flags);
    case 'chat':
      return chat();
    case 'boot':
      return boot(rest);
    case 'dashboard':
      return dashboard();
    case 'start':
    case 'stop':
    case 'restart':
      return systemctl(cmd);
    case 'kill':
      await control('halt').catch(() => undefined);
      return systemctl('stop');
    case 'version': {
      const pkg = readJson<{ version: string }>(path.join(paths.root, 'package.json'), { version: '?' });
      return say(`ouroboros ${pkg.version} (release ${(readJson<{ sha?: string }>(path.join(paths.root, '.ouro-release.json'), {}).sha ?? 'unmanaged').slice(0, 10)})`);
    }
    default:
      die(`unknown command "${cmd}". Try \`ouro help\`.`);
  }
}

void pct; // keeps the import used for future status output
main().catch((e) => {
  die(e instanceof Error ? e.message : String(e));
});
