// Runs one "episode": a bounded working session of the agent inside a fresh Pi
// process (RPC mode). The runner builds the briefing, enforces the budget, the
// wall-clock limit and a stall watchdog, records everything in the audit log, and
// always leaves the system in a clean state (no orphan Pi processes).

import fs from 'node:fs';
import path from 'node:path';
import type { OuroConfig, Limits } from '../lib/config.ts';
import { ensureDir } from '../lib/fsx.ts';
import { newId } from '../lib/ids.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { roundUsd } from '../lib/money.ts';
import { nullLogger, type Logger } from '../lib/log.ts';
import type { Paths } from '../lib/paths.ts';
import { buildBriefing, type StrategySummary, type Trigger } from './briefing.ts';
import { checkCharter } from './charter.ts';
import { modelId, providerEnv, providerKeyEnv } from './llm.ts';
import type { Meter } from './meter.ts';
import { PiRpc, type PiEvent, type PiSpawnOptions } from './pi-rpc.ts';
import type { StateStore } from './state.ts';

export type EpisodeOutcome = 'completed' | 'budget' | 'timeout' | 'stalled' | 'error' | 'aborted' | 'skipped';

export interface EpisodeResult {
  id: string;
  outcome: EpisodeOutcome;
  costUsd: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  handoff?: string;
  error?: string;
}

export interface EpisodeRequest {
  triggers: Trigger[];
  /** Use the cheap model for routine wake-ups. */
  tier?: 'cheap' | 'default';
}

export interface EndInfo {
  handoff: string;
  nextWakeMinutes?: number;
  tier?: 'cheap' | 'default';
  reason?: string;
}

export interface LlmProxyHandle {
  url: string;
  issueToken(o: { label: string; episode?: string; capUsd?: number }): string;
  revokeToken(token: string): void;
  spentUsd(token: string): number;
}

export interface RunnerDeps {
  paths: Paths;
  store: StateStore;
  meter: Meter;
  config: () => OuroConfig;
  limits: () => Limits;
  /** Secrets readable by the runner (LLM keys). */
  getSecret: (name: string) => string | undefined;
  strategies: () => StrategySummary[];
  releaseSha: () => string | undefined;
  proxy?: () => LlmProxyHandle | undefined;
  /** Test seam: how to start Pi. */
  spawn?: (o: PiSpawnOptions) => PiRpc;
  log?: Logger;
  clock?: Clock;
  /** Called when an LLM call fails for auth/billing reasons so the daemon can alert the operator. */
  onLlmProblem?: (kind: 'auth' | 'billing' | 'other', message: string) => void;
}

const CHILD_ENV = ['PI_OFFLINE', 'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'XDG_CONFIG_HOME'];

export class EpisodeRunner {
  private d: RunnerDeps;
  private log: Logger;
  private clock: Clock;
  private active?: { id: string; startedAt: number; pi?: PiRpc; abortReason?: string; end?: EndInfo };
  private lastHandoff?: string;

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.log = deps.log ?? nullLogger;
    this.clock = deps.clock ?? systemClock;
    // recover the last handoff after a restart
    const last = deps.store.state.episodes.at(-1);
    this.lastHandoff = last?.handoff;
  }

  running(): boolean {
    return !!this.active;
  }

  current(): { id: string; startedAt: number } | undefined {
    return this.active ? { id: this.active.id, startedAt: this.active.startedAt } : undefined;
  }

  /** Called by the API when the agent uses the episode_end tool. */
  noteEnd(episodeId: string, info: EndInfo): boolean {
    if (!this.active || this.active.id !== episodeId) return false;
    this.active.end = info;
    return true;
  }

  abort(reason: string): void {
    if (this.active) {
      this.active.abortReason = reason;
      void this.active.pi?.abort();
    }
  }

  private piCommand(): { command: string; prefix: string[] } {
    const local = path.join(this.d.paths.root, 'node_modules', '.bin', 'pi');
    if (fs.existsSync(local)) return { command: local, prefix: [] };
    const code = path.join(this.d.paths.code, 'node_modules', '.bin', 'pi');
    if (fs.existsSync(code)) return { command: code, prefix: [] };
    return { command: 'pi', prefix: [] };
  }

  buildEnv(episodeId: string, token: string | undefined, budgetUsd: number): Record<string, string> {
    const { paths } = this.d;
    const cfg = this.d.config();
    const env: Record<string, string> = {};
    for (const k of CHILD_ENV) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
    Object.assign(env, {
      PI_CODING_AGENT_DIR: paths.piAgentDir,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      OURO_HOME: paths.home,
      OURO_CODE: paths.code,
      OURO_ROOT: paths.root,
      OURO_SOCK: paths.sock,
      OURO_EPISODE: episodeId,
      OURO_BUDGET_USD: String(budgetUsd),
    });
    const proxy = this.d.proxy?.();
    const keyEnv = providerKeyEnv(cfg.llm.provider);
    // with the proxy, every LLM caller in the VM goes through the meter and the real key never enters this process tree
    Object.assign(env, providerEnv({ provider: cfg.llm.provider, proxy: proxy && token ? { url: proxy.url, token } : undefined, secret: keyEnv ? this.d.getSecret(keyEnv) : undefined }));
    return env;
  }

  /** Can an episode run right now? Returns a human reason when not. */
  precheck(): { ok: boolean; reason?: string } {
    if (this.active) return { ok: false, reason: 'an episode is already running' };
    const cfg = this.d.config();
    const budget = this.d.meter.canStartEpisode();
    if (!budget.ok) return budget;
    const keyEnv = providerKeyEnv(cfg.llm.provider);
    if (keyEnv && !this.d.getSecret(keyEnv)) return { ok: false, reason: `no ${keyEnv} in the vault (run \`ouro secret set ${keyEnv}\`)` };
    const charter = checkCharter(this.d.paths, this.d.paths.root);
    if (!charter.ok) return { ok: false, reason: `charter check failed: ${charter.message}` };
    return { ok: true };
  }

  async run(req: EpisodeRequest): Promise<EpisodeResult> {
    const { store, meter, paths } = this.d;
    const cfg = this.d.config();
    const started = this.clock();
    const pre = this.precheck();
    if (!pre.ok) return { id: '', outcome: 'skipped', costUsd: 0, turns: 0, toolCalls: 0, durationMs: 0, error: pre.reason };

    store.sync();
    const id = newId('ep');
    this.active = { id, startedAt: started };
    const model = req.tier === 'cheap' ? cfg.llm.cheapModel : cfg.llm.model;
    const budgetUsd = meter.episodeBudgetUsd();
    const charter = checkCharter(paths, paths.root);
    const proxy = this.d.proxy?.();
    const token = proxy?.issueToken({ label: `episode ${id}`, episode: id, capUsd: budgetUsd });
    store.append('episode.start', { id, reason: req.triggers[0]?.kind ?? 'manual', model, triggers: req.triggers.map((t) => t.kind) });

    let costUsd = 0;
    let turns = 0;
    let toolCalls = 0;
    let lastAssistantText = '';
    let lastError: string | undefined;
    let outcome: EpisodeOutcome = 'completed';
    let error: string | undefined;
    let pi: PiRpc | undefined;

    try {
      ensureDir(paths.workspace);
      ensureDir(paths.sessions);
      ensureDir(paths.logs);
      const briefing = buildBriefing({
        now: started,
        episodeId: id,
        episodeNumber: store.state.episodes.length + 1,
        triggers: req.triggers,
        state: store.state,
        metrics: store.state.metrics(started),
        budget: meter.status(),
        episodeBudgetUsd: budgetUsd,
        cfg,
        strategies: this.d.strategies(),
        charterNote: charter.state === 'unsealed' ? charter.message : undefined,
        release: { sha: this.d.releaseSha() },
        genesisPath: path.join(paths.memory, 'GENESIS.md'),
        handoff: this.lastHandoff,
        model,
      });
      fs.writeFileSync(path.join(paths.run, 'last-briefing.md'), briefing);

      const cmd = this.piCommand();
      const args = [
        ...cmd.prefix,
        '--mode', 'rpc',
        '--session-dir', paths.sessions,
        '--name', id,
        '--provider', cfg.llm.provider,
        '--model', modelId(model),
        '--thinking', cfg.llm.thinking,
        '-e', path.join(paths.root, 'src', 'pi', 'extension', 'index.ts'),
        '--skill', path.join(paths.root, 'agent', 'skills'),
        '--skill', path.join(paths.home, 'skills'),
      ];
      const spawnOpts: PiSpawnOptions = { command: cmd.command, args, env: this.buildEnv(id, token, budgetUsd), cwd: paths.workspace, stderrFile: path.join(paths.logs, 'pi-stderr.log') };
      pi = (this.d.spawn ?? PiRpc.spawn)(spawnOpts);
      this.active.pi = pi;
      this.log.info(`episode ${id} started`, { model, budgetUsd, pid: pi.pid });

      let settled: () => void = () => {};
      const settledP = new Promise<void>((r) => (settled = r));
      pi.onEvent((ev: PiEvent) => {
        switch (ev.type) {
          case 'message_end': {
            const m = ev.message;
            if (m?.role !== 'assistant') break;
            turns++;
            const u = m.usage;
            if (u) {
              const usage = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
              const reported = typeof u.cost?.total === 'number' && u.cost.total > 0 ? u.cost.total : undefined;
              const cost = reported ?? meter.cost(m.model ?? modelId(model), usage);
              costUsd = roundUsd(costUsd + cost);
              // with the proxy on, the proxy is the ledger's source; otherwise record Pi's own numbers
              if (!proxy) meter.record({ provider: m.provider ?? cfg.llm.provider, model: m.model ?? modelId(model), usage, costUsd: reported, episode: id, source: 'pi' });
            }
            if (m.stopReason === 'error' && m.errorMessage) lastError = String(m.errorMessage);
            const text = Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : '';
            if (text.trim()) lastAssistantText = text;
            if (costUsd >= budgetUsd && !this.active?.abortReason) {
              this.active!.abortReason = 'budget';
              this.log.warn(`episode ${id} hit its budget (${costUsd} >= ${budgetUsd}); aborting`);
              void pi!.abort();
            }
            break;
          }
          case 'tool_execution_start':
            toolCalls++;
            break;
          case 'extension_error':
            this.log.warn('pi extension error', { extension: ev.extensionPath, event: ev.event, error: ev.error });
            break;
          case 'agent_settled':
            settled();
            break;
          case 'spawn_error':
            error = `failed to start pi: ${ev.error}`;
            settled();
            break;
          default:
            break;
        }
      });
      // if pi dies before the run settled, unblock and report it
      let finished = false;
      void pi.exited.then(() => {
        if (!finished && !this.active?.abortReason) error ??= 'pi exited unexpectedly';
        settled();
      });

      // wait for readiness, then send the briefing
      await pi.request({ type: 'get_state' }, 60_000);
      const ack = await pi.prompt(briefing);
      if (ack?.disposition === 'handled') error = 'briefing was consumed by an extension command instead of starting a run';

      // supervise: wall-clock limit, stall watchdog, abort requests
      const deadline = started + cfg.schedule.episodeTimeoutSec * 1000;
      const stallMs = cfg.schedule.stallSec * 1000;
      let settledFlag = false;
      void settledP.then(() => (settledFlag = true));
      while (!settledFlag && !error) {
        await Promise.race([settledP, new Promise((r) => setTimeout(r, 1000))]);
        if (settledFlag) break;
        const now = this.clock();
        if (this.active.abortReason) {
          await Promise.race([settledP, new Promise((r) => setTimeout(r, 30_000))]);
          if (!settledFlag) {
            pi.kill();
            await pi.exited;
          }
          break;
        }
        if (now > deadline) {
          this.active.abortReason = 'timeout';
          await pi.abort();
          await Promise.race([settledP, new Promise((r) => setTimeout(r, 15_000))]);
          if (!settledFlag) pi.kill();
          break;
        }
        if (Date.now() - pi.lastEventAt > stallMs) {
          this.active.abortReason = 'stalled';
          await pi.abort();
          await Promise.race([settledP, new Promise((r) => setTimeout(r, 10_000))]);
          if (!settledFlag) pi.kill();
          break;
        }
      }

      finished = true;
      // final numbers straight from Pi, for the log
      if (!pi.hasExited) {
        const stats = await pi.request<{ cost?: number; tokens?: { total?: number } }>({ type: 'get_session_stats' }, 10_000).catch(() => undefined);
        if (stats?.cost !== undefined && Math.abs(stats.cost - costUsd) > 0.02 + 0.2 * costUsd) this.log.warn(`episode cost drift: events ${costUsd}, pi stats ${stats.cost}`);
        if (stats?.cost !== undefined && stats.cost > costUsd) costUsd = roundUsd(stats.cost);
      }

      const reason = this.active.abortReason;
      if (reason === 'budget') outcome = 'budget';
      else if (reason === 'timeout') outcome = 'timeout';
      else if (reason === 'stalled') outcome = 'stalled';
      else if (reason) outcome = 'aborted';
      else if (error) outcome = 'error';
      else if (lastError && !this.active.end) {
        outcome = 'error';
        error = lastError;
      }
      if (error === undefined && lastError && outcome === 'completed' && turns <= 1) {
        outcome = 'error';
        error = lastError;
      }
      if (error && /401|403|invalid.*api.?key|authentication|unauthorized|credit balance|billing|insufficient/i.test(error)) {
        this.d.onLlmProblem?.(/credit|billing|insufficient/i.test(error) ? 'billing' : 'auth', error);
      }
    } catch (e) {
      outcome = 'error';
      error = e instanceof Error ? e.message : String(e);
      this.log.error(`episode ${id} failed`, e);
    } finally {
      if (pi && !pi.hasExited) await pi.stop(3000).catch(() => undefined);
      if (token) proxy?.revokeToken(token);
      const end = this.active?.end;
      const handoff = end?.handoff ?? (lastAssistantText ? `(no episode_end call; last words) ${lastAssistantText}`.slice(0, 4000) : undefined);
      if (handoff) this.lastHandoff = handoff;
      const durationMs = this.clock() - started;
      store.append('episode.end', { id, outcome, costUsd, turns, toolCalls, durationMs, handoff, error });
      this.active = undefined;
      this.log.info(`episode ${id} ended: ${outcome}`, { costUsd, turns, toolCalls, durationMs, error });
      this._last = { id, outcome, costUsd, turns, toolCalls, durationMs, handoff, error, end };
    }
    return { id, outcome: this._last!.outcome, costUsd, turns, toolCalls, durationMs: this._last!.durationMs, handoff: this._last!.handoff, error: this._last!.error };
  }

  /** Details of the most recent episode (including the agent's requested wake-up), for the scheduler. */
  _last?: EpisodeResult & { end?: EndInfo };
}
