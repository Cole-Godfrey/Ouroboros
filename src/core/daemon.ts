#!/usr/bin/env node
// the Ouroboros daemon: composition root and main loops.
//
//   scheduler  -> decides when the agent thinks   -> runner (Pi) -> episodes
//   reconciler -> asks every venue what it holds  -> NAV points in the audit log
//   procman    -> keeps the agent's strategies alive
//   notify     -> operator pushes and replies
//   selfmod    -> probation / confirmation of promoted releases
//   api        -> unix socket (full) + localhost TCP (read-only dashboard)
//
// exit codes: 0 = operator-requested stop, 75 = restart me into `current`.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger, type Logger } from '../lib/log.ts';
import { deepMerge, loadConfig, loadLimits, type Limits, type OuroConfig } from '../lib/config.ts';
import { ensureDir, readJson, writeFileAtomic, writeJson } from '../lib/fsx.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { resolvePaths, type Paths } from '../lib/paths.ts';
import { createApiHandler } from './api.ts';
import { checkCharter, charterSha } from './charter.ts';
import { EventLog } from './eventlog.ts';
import { Inbox } from './inbox.ts';
import { LlmProxy } from './llm-proxy.ts';
import { FREE_ROUTER, isFreeModel, PROVIDERS, providerKeyEnv } from './llm.ts';
import { Meter, DEFAULT_PRICING, type Pricing } from './meter.ts';
import { NtfyChannel, Notifier, NotifyService, TelegramChannel, type Channel } from './notify.ts';
import { PriceOracle } from './prices.ts';
import { ProcMan } from './procman.ts';
import { Reconciler } from './reconciler.ts';
import { EpisodeRunner } from './runner.ts';
import { Scheduler } from './scheduler.ts';
import { DailyReports } from './report.ts';
import { SelfMod } from './selfmod.ts';
import { StateStore } from './state.ts';
import { Vault } from './vault.ts';
import { runVenueMethod } from './venues/run.ts';

// exit code that tells the boot supervisor to start the daemon again from the current release
export const EXIT_RESTART = 75;
const VERSION = '0.1.0';

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** boot-check mode used by the self-modification gate: no agent, no timers, ephemeral ports. */
  selftest?: boolean;
  clock?: Clock;
}

/** smallest daily inference allowance (usd) at which switching to a paid model is allowed */
const MIN_PAID_MODEL_DAILY_USD = 0.25;

export class Daemon {
  readonly paths: Paths;
  readonly clock: Clock;
  readonly startedAt: number;
  readonly selftest: boolean;
  readonly log: Logger;
  readonly vault: Vault;
  readonly store: StateStore;
  readonly inbox: Inbox;
  readonly meter: Meter;
  readonly oracle: PriceOracle;
  readonly reconciler: Reconciler;
  readonly procman: ProcMan;
  readonly selfmod: SelfMod;
  readonly runner: EpisodeRunner;
  readonly scheduler: Scheduler;
  readonly reports: DailyReports;
  readonly notifyService: NotifyService;
  proxy?: LlmProxy;

  private cfgCache?: { mtime: number; value: OuroConfig };
  private limitsCache?: { mtime: number; value: Limits };
  private notifier = new Notifier([]);
  private notifierSig = '';
  private timers: NodeJS.Timeout[] = [];
  private servers: http.Server[] = [];
  private dashToken = '';
  private episodeBusy = false;
  private stopping = false;
  private restartAsk?: { reason: string; at: number };
  private alerted = new Set<string>();
  private tcpPort = 0;
  private lastVerify = 0;

  private constructor(opts: DaemonOptions) {
    this.paths = resolvePaths(opts.env ?? process.env);
    this.clock = opts.clock ?? systemClock;
    this.startedAt = this.clock();
    this.selftest = !!opts.selftest;
    for (const d of [this.paths.home, this.paths.run, this.paths.logs, this.paths.memory, this.paths.strategies, this.paths.data, this.paths.workspace, this.paths.piAgentDir, this.paths.sessions, path.join(this.paths.home, 'skills'), path.join(this.paths.home, 'venues')]) ensureDir(d);
    this.log = createLogger('daemon', { file: path.join(this.paths.logs, 'daemon.log'), stderr: !this.selftest });
    this.vault = new Vault(this.paths, { clock: this.clock });
    this.vault.init();
    this.vault.loadRedactor();
    this.store = new StateStore(new EventLog(this.paths.events, { clock: this.clock, lockDir: this.paths.eventsLock }));
    this.inbox = new Inbox(this.store, { clock: this.clock, maxNonUrgentPerDay: () => Math.min(this.cfg().inbox.maxNonUrgentPerDay, this.limits().maxNonUrgentInboxPerDay ?? Infinity), timezone: () => this.cfg().operator.timezone });
    this.meter = new Meter({ store: this.store, config: () => this.cfg(), limits: () => this.limits(), pricing: () => this.pricing(), clock: this.clock });
    this.oracle = new PriceOracle({ overrides: readJson<Record<string, number>>(path.join(this.paths.home, 'prices-overrides.json'), {}), clock: this.clock });
    this.reconciler = new Reconciler({
      store: this.store,
      oracle: this.oracle,
      config: () => this.cfg(),
      clock: this.clock,
      log: this.log.child('reconciler'),
      callVenue: (v, method, args) => runVenueMethod({ paths: this.paths, module: v.module!, method, args, venueId: v.id, secrets: this.vault.env(v.secrets).env }),
      onGuardTripped: async (v) => {
        if (v.strategy) await this.procman.stop(v.strategy, `guard on ${v.id}`);
      },
    });
    this.procman = new ProcMan({ paths: this.paths, store: this.store, env: (n) => this.vault.env(n), log: this.log.child('procman'), clock: this.clock });
    this.selfmod = new SelfMod({ paths: this.paths, store: this.store, config: () => this.cfg(), requestRestart: (r) => this.requestRestart(r), log: this.log.child('selfmod'), clock: this.clock });
    this.runner = new EpisodeRunner({
      paths: this.paths,
      store: this.store,
      meter: this.meter,
      config: () => this.cfg(),
      limits: () => this.limits(),
      getSecret: (n) => {
        try {
          return this.vault.get(n);
        } catch {
          return undefined;
        }
      },
      strategies: () => this.procman.list(),
      releaseSha: () => this.selfmod.runningSha(),
      proxy: () => (this.proxy?.url ? { url: this.proxy.url, issueToken: (o) => this.proxy!.issueToken(o), revokeToken: (t) => this.proxy!.revokeToken(t), spentUsd: (t) => this.proxy!.spentUsd(t) } : undefined),
      log: this.log.child('runner'),
      clock: this.clock,
      onLlmProblem: (kind, message) => this.alert(`llm-${kind}`, kind === 'billing' ? 'The model provider reports a billing problem' : 'The model provider rejected the API key', `${message.slice(0, 500)}\n\nThe agent cannot think until this is fixed. Check the key/credits at the provider, then \`ouro secret set ${this.cfg().llm.provider.toUpperCase()}_API_KEY\` if the key changed.`),
    });
    this.scheduler = new Scheduler({ store: this.store, config: () => this.cfg(), precheck: () => this.runner.precheck(), clock: this.clock, log: this.log.child('scheduler') });
    this.reports = new DailyReports(this.paths, this.store, this.clock);
    this.notifyService = new NotifyService(this.store, this.inbox, () => this.currentNotifier(), this.log.child('notify'));
  }

  // the constructor is private because setup is async (sockets, proxy, charter check)
  static async create(opts: DaemonOptions = {}): Promise<Daemon> {
    const d = new Daemon(opts);
    await d.init();
    return d;
  }

  // ------------------------------------------------------------ config

  // config is cached and re-read when the file changes, so edits apply without a restart
  cfg(): OuroConfig {
    try {
      const st = fs.statSync(this.paths.config);
      if (!this.cfgCache || st.mtimeMs !== this.cfgCache.mtime) this.cfgCache = { mtime: st.mtimeMs, value: loadConfig(this.paths) };
    } catch {
      this.cfgCache ??= { mtime: 0, value: loadConfig(this.paths) };
    }
    return this.cfgCache.value;
  }

  /** operator limits: /etc file merged with those the operator set via the CLI. the stricter value wins, the agent can raise neither. */
  // the lowest of the root-owned file and the operator's audit-log entries wins.
  // the agent can edit config.json but not these, so it cannot raise its own budget.
  limits(): Limits {
    let file: Limits = {};
    try {
      const st = fs.statSync(this.paths.limitsFile);
      if (!this.limitsCache || st.mtimeMs !== this.limitsCache.mtime) this.limitsCache = { mtime: st.mtimeMs, value: loadLimits(this.paths) };
      file = this.limitsCache.value;
    } catch {
      /* no limits file */
    }
    const ol = this.store.state.operatorLimits;
    const min = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
    return { ...file, sponsorDailyUsd: min(file.sponsorDailyUsd, ol.sponsorDailyUsd), sponsorTotalUsd: min(file.sponsorTotalUsd, ol.sponsorTotalUsd), perEpisodeUsd: min(file.perEpisodeUsd, ol.perEpisodeUsd) };
  }

  pricing(): Record<string, Pricing> {
    return { ...DEFAULT_PRICING, ...readJson<Record<string, Pricing>>(this.paths.pricing, {}) };
  }

  // merge a partial config into the file on disk and drop the cache
  patchConfig(patch: unknown): OuroConfig {
    const onDisk = readJson<Record<string, unknown>>(this.paths.config, {});
    const next = deepMerge(onDisk, patch);
    writeJson(this.paths.config, next);
    this.cfgCache = undefined;
    return this.cfg();
  }

  /** the model in use, whether it is free, and whether its provider key is in the vault */
  modelInfo() {
    const { llm, budget } = this.cfg();
    const keyName = providerKeyEnv(llm.provider);
    return { provider: llm.provider, model: llm.model, cheapModel: llm.cheapModel, thinking: llm.thinking, free: isFreeModel(llm.model), keyName, keyPresent: !!keyName && this.vault.has(keyName), fundedBy: budget.mode };
  }

  /**
   * switch the model the agent thinks with. a paid model needs its provider key in the
   * vault and, when the agent pays from its own capital, enough NAV that the daily cap
   * (a share of NAV) can actually cover an episode. otherwise the agent could lock itself out.
 */
  setModel(o: { provider?: string; model: string; cheapModel?: string; thinking?: string; by: string }): { ok: boolean; reason?: string; model?: ReturnType<Daemon['modelInfo']> } {
    const cfg = this.cfg();
    const provider = o.provider ?? cfg.llm.provider;
    const keyName = providerKeyEnv(provider);
    if (!keyName) return { ok: false, reason: `unknown provider "${provider}"` };
    if (!this.vault.has(keyName)) return { ok: false, reason: `${keyName} is not in the vault. ask the operator with the inbox tool to run: ouro secret set ${keyName}` };
    const free = isFreeModel(o.model);
    if (!free && cfg.budget.mode === 'capital') {
      const cap = this.meter.status().dailyLimitUsd;
      if (cap < MIN_PAID_MODEL_DAILY_USD) return { ok: false, reason: `a paid model needs a daily inference allowance of at least $${MIN_PAID_MODEL_DAILY_USD.toFixed(2)} and yours is $${cap.toFixed(2)} (${(cfg.budget.capitalMaxDailyPctNav * 100).toFixed(0)}% of NAV). stay on a free model until NAV grows` };
    }
    const llm: Record<string, string> = { provider, model: o.model };
    // when the provider changes, the routine tier follows unless told otherwise
    if (o.cheapModel) llm.cheapModel = o.cheapModel;
    else if (provider !== cfg.llm.provider || free) llm.cheapModel = o.model;
    if (o.thinking) llm.thinking = o.thinking;
    this.patchConfig({ llm });
    this.store.append('model.set', { provider, model: o.model, free, by: o.by });
    return { ok: true, model: this.modelInfo() };
  }

  wallets(): unknown {
    return readJson(this.paths.wallets, {});
  }

  private currentNotifier(): Notifier {
    const n = this.cfg().notify;
    let tgToken: string | undefined;
    let ntfyToken: string | undefined;
    try {
      tgToken = this.vault.has('TELEGRAM_BOT_TOKEN') ? this.vault.get('TELEGRAM_BOT_TOKEN') : undefined;
      ntfyToken = this.vault.has('NTFY_TOKEN') ? this.vault.get('NTFY_TOKEN') : undefined;
    } catch {
      /* vault unreadable: no channels */
    }
    const sig = JSON.stringify([n, !!tgToken, !!ntfyToken]);
    if (sig !== this.notifierSig) {
      const channels: Channel[] = [];
      if (n.ntfy.topic) channels.push(new NtfyChannel({ server: n.ntfy.server, topic: n.ntfy.topic, replyTopic: n.ntfy.replyTopic || undefined, token: ntfyToken }));
      if (tgToken && n.telegram.chatId) channels.push(new TelegramChannel({ token: tgToken, chatId: n.telegram.chatId }));
      this.notifier = new Notifier(channels, this.log.child('notifier'));
      this.notifierSig = sig;
    }
    return this.notifier;
  }

  // ----------------------------------------------------------- alerts

  /** system-originated inbox alert, at most once per key per day. */
  // one inbox alert per kind per day, so a persistent problem does not spam the operator
  alert(key: string, title: string, body: string, urgency: 'low' | 'normal' | 'high' = 'high'): void {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const k = `${key}:${day}`;
    if (this.alerted.has(k)) return;
    this.alerted.add(k);
    this.inbox.create({ kind: 'alert', from: 'system', title, body, urgency });
    this.log.warn(`alert: ${title}`);
  }

  // restart is deferred until the agent is between episodes, with a 15 minute upper bound (see mainTick)
  requestRestart(reason: string): void {
    this.restartAsk ??= { reason, at: this.clock() };
    this.log.info(`restart requested: ${reason}`);
  }

  // ------------------------------------------------------------- init

  private async init(): Promise<void> {
    const st = this.store;
    if (!st.state.genesis) {
      st.append('genesis', { version: VERSION, charterSha: charterSha(this.paths.root) ?? '', hostname: (await import('node:os')).hostname() });
      this.seedHome();
    }
    // record the configured model on first boot and after offline edits for historical reports.
    const previousModel = st.log.readAll().filter((ev) => ev.type === 'model.set').at(-1)?.data;
    const { provider, model } = this.cfg().llm;
    if (previousModel?.provider !== provider || previousModel?.model !== model) {
      st.append('model.set', { provider, model, free: isFreeModel(model), by: 'system' });
    }
    // wallet + default venue
    if (!this.selftest) {
      try {
        const { ensureEvmWallet } = await import('../toolkit/evm.ts');
        const w = ensureEvmWallet(this.vault, this.paths.wallets, this.clock());
        if (w.created) this.log.info(`created the agent's EVM wallet ${w.address}`);
        if (!st.state.venues.has('evm-wallet')) st.append('venue.register', { id: 'evm-wallet', module: 'builtin/evm-wallet', description: "The agent's own EVM wallet (Base, Arbitrum, Optimism, Polygon, Ethereum)", secrets: [], enabled: true, hasFlows: true });
      } catch (e) {
        this.log.warn('could not set up the EVM wallet', e instanceof Error ? e.message : String(e));
      }
    }
    this.selfmod.onStart();
    const charter = checkCharter(this.paths, this.paths.root);
    if (!charter.ok) this.alert('charter', 'Charter check failed', `${charter.message}. The agent will not run until the Charter matches the seal. If you changed it on purpose, run \`ouro charter seal\`.`);
    if (!this.selftest) {
      const v = st.log.verify();
      if (!v.ok) this.alert('ledger-chain', 'The audit log failed verification', `Event ${v.error?.seq}: ${v.error?.reason}. Something edited or deleted history. The ledger is no longer tamper-evident from that point.`);
      this.lastVerify = this.clock();
    }
  }

  /** first-run: copy the seed memory (GENESIS.md and friends) and Pi defaults into the state directory. */
  // first run: copy the seed memory and write the pi settings the agent starts from. existing files are never overwritten.
  private seedHome(): void {
    const seed = path.join(this.paths.root, 'agent', 'memory');
    try {
      for (const f of fs.readdirSync(seed)) {
        const dest = path.join(this.paths.memory, f);
        if (!fs.existsSync(dest)) fs.cpSync(path.join(seed, f), dest, { recursive: true });
      }
    } catch {
      /* no seed */
    }
    const agents = path.join(this.paths.piAgentDir, 'AGENTS.md');
    if (!fs.existsSync(agents)) {
      writeFileAtomic(
        agents,
        `# Notes to myself (loaded into every episode)\n\nThis file is mine: I can edit it. The Charter and Constitution are injected separately.\n\n- State lives in ${this.paths.home}; the harness code is in ${this.paths.code} (edit it, then use the selfmod tool to promote changes).\n- Memory notes: ${this.paths.memory}. Skills I write: ${path.join(this.paths.home, 'skills')}. Venue adapters: ${path.join(this.paths.home, 'venues')}.\n`,
      );
    }
    const settings = path.join(this.paths.piAgentDir, 'settings.json');
    if (!fs.existsSync(settings)) {
      writeJson(settings, { defaultTools: ['+grep', '+find', '+ls'], enableInstallTelemetry: false, compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } });
    }
  }

  // ------------------------------------------------------------ start

  async start(): Promise<void> {
    const cfg = this.cfg();
    // subscribe before any loops begin so operator messages and incidents wake the agent.
    this.scheduler.attach();
    if (cfg.llm.proxy && !this.selftest) {
      this.proxy = new LlmProxy({ meter: this.meter, config: () => this.cfg(), getSecret: (n) => { try { return this.vault.get(n); } catch { return undefined; } }, log: this.log.child('llm-proxy'), upstream: (p) => this.cfg().llm.upstreams?.[p] ?? PROVIDERS[p]!.upstream });
      try {
        await this.proxy.start(cfg.llm.proxyPort);
        this.log.info(`LLM metering proxy on ${this.proxy.url}`);
      } catch (e) {
        this.log.error('LLM proxy failed to start; falling back to direct provider access', e);
        this.proxy = undefined;
      }
    }
    await this.listen();
    this.procman.adoptAll();
    this.heartbeat();
    this.every(5_000, () => this.heartbeat());
    if (this.selftest) return;
    this.reports.start((e) => this.log.error('daily report failed', e));
    this.every(5_000, () => void this.mainTick());
    this.every(Math.max(60_000, cfg.reconcile.intervalSec * 1000), () => void this.reconcile());
    setTimeout(() => void this.reconcile(), 15_000).unref();
    this.every(20_000, () => void this.notifyService.tick(this.clock()).catch((e) => this.log.debug('notify tick failed', e)));
    this.every(30_000, () => this.housekeeping());
    this.log.info(`daemon up (release ${this.selfmod.runningSha()?.slice(0, 10) ?? 'unmanaged'}), socket ${this.paths.sock}${this.tcpPort ? `, dashboard 127.0.0.1:${this.tcpPort}` : ''}`);
  }

  // background timers never keep the process alive on their own
  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref();
    this.timers.push(t);
  }

  // the supervisor watches this file. a stale heartbeat means the daemon is stuck and gets restarted.
  private heartbeat(): void {
    try {
      writeFileAtomic(this.paths.heartbeat, JSON.stringify({ pid: process.pid, ts: this.clock(), sha: this.selfmod.runningSha(), uptimeSec: Math.round((this.clock() - this.startedAt) / 1000), episode: this.runner.current()?.id ?? null }));
    } catch {
      /* disk full etc.: the supervisor will notice the stale heartbeat */
    }
  }

  // two listeners: a unix socket with full access for the agent and cli (same user),
  // and a read-only tcp port behind a token for the dashboard.
  private async listen(): Promise<void> {
    const handler = createApiHandler(this);
    // unix socket: full access
    try {
      fs.rmSync(this.paths.sock, { force: true });
    } catch {
      /* ignore */
    }
    const unix = http.createServer((req, res) => void handler(req, res, { trusted: true }));
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject);
      unix.listen(this.paths.sock, () => resolve());
    });
    fs.chmodSync(this.paths.sock, 0o600);
    this.servers.push(unix);

    // tcp: read-only dashboard
    if (!fs.existsSync(this.paths.dashboardToken)) writeFileAtomic(this.paths.dashboardToken, randomBytes(24).toString('hex') + '\n', 0o600);
    this.dashToken = fs.readFileSync(this.paths.dashboardToken, 'utf8').trim();
    const token = Buffer.from(this.dashToken);
    const html = () => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard', 'index.html'));
    const tcp = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        try {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
          res.end(html());
        } catch {
          res.writeHead(500).end('dashboard missing');
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ouroboros.png') {
        try {
          const artwork = fs.readFileSync(path.join(this.paths.root, 'docs', 'img', 'ouroboros.png'));
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
          res.end(artwork);
        } catch {
          res.writeHead(404).end('artwork missing');
        }
        return;
      }
      void handler(req, res, { trusted: false, token });
    });
    const port = this.selftest ? 0 : this.cfg().dashboard.port;
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(port, this.cfg().dashboard.host, () => resolve());
      });
      this.tcpPort = (tcp.address() as AddressInfo).port;
      this.servers.push(tcp);
    } catch (e) {
      this.log.warn(`dashboard port ${port} unavailable`, e instanceof Error ? e.message : String(e));
    }
  }

  get dashboardPort(): number {
    return this.tcpPort;
  }

  // ------------------------------------------------------------ loops

  // the daemon's single loop, every few seconds:
  // supervise strategies, check the release on probation, restart if one is pending and the agent is idle,
  // then ask the scheduler whether an episode should start.
  private async mainTick(): Promise<void> {
    if (this.stopping) return;
    try {
      this.procman.tick();
      const probation = this.selfmod.tickProbation();
      if (probation === 'rolledback') this.requestRestart('rollback after failing probation');
      if (this.restartAsk && (!this.runner.running() || this.clock() - this.restartAsk.at > 15 * 60_000)) {
        this.log.info(`restarting now: ${this.restartAsk.reason}`);
        await this.stop(EXIT_RESTART);
        return;
      }
      if (this.episodeBusy) return;
      const req = this.scheduler.tick(this.clock());
      if (!req) return;
      this.episodeBusy = true;
      try {
        const res = await this.runner.run(req);
        this.scheduler.onEpisodeEnd(res, this.runner._last?.end);
        this.afterEpisode(res);
      } finally {
        this.episodeBusy = false;
      }
    } catch (e) {
      this.log.error('main tick failed', e);
      this.episodeBusy = false;
    }
  }

  // alert the operator about failure streaks and budget stops, then re-check balances because money may have moved
  private afterEpisode(res: { outcome: string; error?: string }): void {
    const eps = this.store.state.episodes;
    const lastFive = eps.slice(-3);
    if (lastFive.length === 3 && lastFive.every((e) => ['error', 'stalled', 'timeout'].includes(e.outcome ?? ''))) {
      this.alert('episodes-failing', 'The agent has failed 3 episodes in a row', `Last error: ${lastFive.at(-1)?.error ?? res.error ?? 'unknown'}\nCheck \`ouro logs\` and \`ouro episodes\`. If a recent self-modification caused this it will be rolled back automatically.`, 'high');
    }
    // a pinned free model can vanish without notice. after failed episodes in a row, fall back to the free router
    const cfg = this.cfg();
    const lastTwo = eps.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((e) => ['error', 'stalled', 'timeout'].includes(e.outcome ?? '')) && cfg.llm.provider === 'openrouter' && isFreeModel(cfg.llm.model) && cfg.llm.model !== FREE_ROUTER) {
      this.patchConfig({ llm: { model: FREE_ROUTER } });
      this.store.append('model.set', { provider: 'openrouter', model: FREE_ROUTER, free: true, by: 'system' });
      this.alert('model-fallback', 'The free model failed, so the agent moved to the free router', `Two episodes in a row failed on ${cfg.llm.model}. It now uses ${FREE_ROUTER}, which picks any available free model. The agent can pin a better one with its model tool.`, 'low');
    }
    if (res.outcome === 'skipped' && res.error && /budget/.test(res.error)) this.alert('budget', 'The agent is paused: inference budget spent', `${res.error}. It resumes when the budget resets (midnight in ${this.cfg().operator.timezone}) or when you raise it with \`ouro budget set\`.`, 'normal');
    void this.reconcile(); // money may have moved during the episode
  }

  private async reconcile(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.reconciler.round();
    } catch (e) {
      this.log.error('reconcile failed', e);
    }
  }

  // slow checks: budget alerts, the graduation hint, and a daily verification of the audit log's hash chain
  private housekeeping(): void {
    if (this.stopping) return;
    try {
      const s = this.scheduler.status();
      if (s.blockedReason && /budget/.test(s.blockedReason)) this.alert('budget', 'The agent is paused: inference budget spent', `${s.blockedReason}. It resumes at midnight (${this.cfg().operator.timezone}) or when you raise the budget with \`ouro budget set\`.`, 'normal');
      const m = this.store.state.metrics(this.clock());
      const cfg = this.cfg();
      // when the operator sponsors thinking, tell them once nav is large enough for the agent to pay for itself
      if (cfg.budget.mode === 'sponsor' && m.navUsd >= cfg.budget.graduationNavUsd) {
        this.alert('graduation', 'The agent can now afford to pay for its own thinking', `NAV is ${m.navUsd.toFixed(2)} USD, above the graduation threshold of ${cfg.budget.graduationNavUsd}. Switch inference to capital funding with \`ouro budget mode capital\` (the agent then pays for tokens out of its own NAV, capped at ${(cfg.budget.capitalMaxDailyPctNav * 100).toFixed(0)}% of NAV per day), or keep sponsoring it.`, 'low');
      }
      if (this.clock() - this.lastVerify > 24 * 3_600_000) {
        this.lastVerify = this.clock();
        const v = this.store.log.verify();
        if (!v.ok) this.alert('ledger-chain', 'The audit log failed verification', `Event ${v.error?.seq}: ${v.error?.reason}.`);
      }
    } catch (e) {
      this.log.debug('housekeeping failed', e);
    }
  }

  // ------------------------------------------------------------- stop

  /** stop loops and listeners without exiting the process (tests, smoke check). */
  async close(): Promise<void> {
    this.stopping = true;
    this.scheduler.close();
    this.reports.close();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.runner.running()) {
      this.runner.abort('daemon shutting down');
      for (let i = 0; i < 100 && this.runner.running(); i++) await new Promise((r) => setTimeout(r, 200));
    }
    await this.proxy?.stop();
    for (const s of this.servers) {
      s.closeAllConnections?.();
      s.close();
    }
    this.servers = [];
    try {
      fs.rmSync(this.paths.sock, { force: true });
    } catch {
      /* ignore */
    }
  }

  async stop(code = 0): Promise<never> {
    if (this.stopping) return new Promise(() => {});
    try {
      await this.close();
    } finally {
      process.exit(code);
    }
  }
}

// -------------------------------------------------------------- main

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const d = await Daemon.create({ selftest: process.env.OURO_SELFTEST === '1' });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void d.stop(0));
  process.on('uncaughtException', (e) => {
    d.log.error('uncaught exception', e);
  });
  process.on('unhandledRejection', (e) => {
    d.log.error('unhandled rejection', e);
  });
  await d.start();
}
