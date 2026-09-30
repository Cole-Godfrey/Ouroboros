import os from 'node:os';
import path from 'node:path';

/** root of the release (or working copy) this file is running from. */
export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

// // every directory and file the system uses, resolved once.
// // state survives releases and rollbacks, code is what the supervisor swaps.
export interface Paths {
  /** state directory. survives releases and rollbacks. default ~/.ouroboros */
  home: string;
  /** editable working copy of the harness repository. default ~/ouroboros */
  code: string;
  /** the release this process is running from. */
  root: string;
  /** operator-owned config directory (limits, charter seal). default /etc/ouroboros */
  etc: string;

  current: string; // symlink -> releases/<sha>
  lkg: string; // symlink -> last known good release
  releases: string;
  run: string;
  sock: string;
  dashboardToken: string;
  heartbeat: string;
  logs: string;
  vaultDir: string;
  vaultFile: string;
  masterKey: string;
  memory: string;
  strategies: string;
  data: string;
  workspace: string;
  piAgentDir: string;
  sessions: string;
  config: string;
  events: string;
  eventsLock: string;
  venues: string;
  limitsFile: string;
  charterSeal: string;
  pricing: string;
  wallets: string;
}

// // environment variables let tests and unusual installs move everything without touching the code
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = path.resolve(env.OURO_HOME ?? path.join(os.homedir(), '.ouroboros'));
  const code = path.resolve(env.OURO_CODE ?? path.join(os.homedir(), 'ouroboros'));
  const etc = path.resolve(env.OURO_ETC ?? '/etc/ouroboros');
  const run = path.join(home, 'run');
  const vaultDir = path.join(home, 'vault');
  return {
    home,
    code,
    root: ROOT_DIR,
    etc,
    current: path.join(home, 'current'),
    lkg: path.join(home, 'lkg'),
    releases: path.join(home, 'releases'),
    run,
    sock: path.join(run, 'ouro.sock'),
    dashboardToken: path.join(run, 'dashboard.token'),
    heartbeat: path.join(run, 'heartbeat.json'),
    logs: path.join(home, 'logs'),
    vaultDir,
    vaultFile: path.join(vaultDir, 'secrets.enc.json'),
    masterKey: path.join(vaultDir, 'master.key'),
    memory: path.join(home, 'memory'),
    strategies: path.join(home, 'strategies'),
    data: path.join(home, 'data'),
    workspace: path.join(home, 'workspace'),
    piAgentDir: path.join(home, 'pi'),
    sessions: path.join(home, 'sessions'),
    config: path.join(home, 'config.json'),
    events: path.join(home, 'events.jsonl'),
    eventsLock: path.join(run, 'events.lock'),
    venues: path.join(home, 'venues.json'),
    limitsFile: env.OURO_LIMITS_FILE ?? path.join(etc, 'limits.json'),
    charterSeal: env.OURO_CHARTER_SEAL ?? path.join(etc, 'charter.sha256'),
    pricing: path.join(home, 'pricing.json'),
    wallets: path.join(home, 'wallets.json'),
  };
}

export const CHARTER_FILE = 'agent/CHARTER.md';
