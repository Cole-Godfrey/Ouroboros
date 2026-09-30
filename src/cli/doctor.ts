// `ouro doctor`: verify that the installation is sound and that the containment
// guarantees the Charter relies on actually hold on this machine.

import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { checkCharter } from '../core/charter.ts';
import { EventLog } from '../core/eventlog.ts';
import { PROVIDERS, providerKeyEnv } from '../core/llm.ts';
import { Vault } from '../core/vault.ts';
import { loadConfig } from '../lib/config.ts';
import { readJson } from '../lib/fsx.ts';
import { resolvePaths } from '../lib/paths.ts';
import { apiCall } from '../toolkit/client.ts';
import { dim, fail, ok, warn } from './ui.ts';

// // try to open a tcp connection: open means reachable, refused means the host answered, timeout means filtered
function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<'open' | 'closed' | 'blocked'> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r: 'open' | 'closed' | 'blocked') => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done('blocked'));
    s.on('connect', () => done('open'));
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'closed' : 'blocked'));
  });
}

function defaultGateway(): string | undefined {
  try {
    const r = spawnSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
    return /default via (\S+)/.exec(r.stdout)?.[1];
  } catch {
    return undefined;
  }
}

// // check the install, then check that the containment the charter relies on actually holds.
// // returns the number of problems found, which becomes the exit code.
export async function runDoctor(deep: boolean): Promise<number> {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  let bad = 0;
  const out = (line: string, isBad = false) => {
    console.log(line);
    if (isBad) bad++;
  };

  // runtime
  const [maj, min] = process.versions.node.split('.').map(Number);
  out(maj > 22 || (maj === 22 && min >= 18) ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} (need 22.18+)`), !(maj > 22 || (maj === 22 && min >= 18)));
  const pi = [path.join(paths.root, 'node_modules', '.bin', 'pi'), path.join(paths.code, 'node_modules', '.bin', 'pi')].find((p) => fs.existsSync(p));
  if (pi) {
    const v = spawnSync(pi, ['--version'], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } });
    out(v.status === 0 ? ok(`Pi ${v.stdout.trim()}`) : fail('pi is installed but does not run'), v.status !== 0);
  } else out(fail('pi (the agent harness) is not installed: run `npm ci` in the harness repository'), true);
  out(spawnSync('git', ['--version']).status === 0 ? ok('git') : fail('git is missing'), spawnSync('git', ['--version']).status !== 0);

  // state + vault
  out(fs.existsSync(paths.home) ? ok(`state directory ${paths.home}`) : fail(`state directory missing: run \`ouro init\``), !fs.existsSync(paths.home));
  const vault = new Vault(paths);
  try {
    const names = vault.list().map((s) => s.name);
    out(ok(`vault readable (${names.length} secret${names.length === 1 ? '' : 's'})`));
    const keyName = providerKeyEnv(cfg.llm.provider);
    if (keyName) out(names.includes(keyName) ? ok(`${keyName} present`) : fail(`${keyName} missing: the agent cannot think (ouro secret set ${keyName})`), !names.includes(keyName));
  } catch (e) {
    out(fail(`vault unreadable: ${e instanceof Error ? e.message : e}`), true);
  }
  const wallets = readJson<{ evm?: { address: string } }>(paths.wallets, {});
  out(wallets.evm ? ok(`wallet ${wallets.evm.address}`) : warn('no wallet yet (created when the daemon or `ouro init` first runs)'));

  // charter + ledger
  const ch = checkCharter(paths, paths.root);
  out(ch.state === 'sealed-ok' ? ok('charter sealed and intact') : ch.state === 'unsealed' ? warn(ch.message) : fail(ch.message), !ch.ok);
  const v = new EventLog(paths.events, { lockDir: paths.eventsLock }).verify();
  out(v.ok ? ok(`audit log verifies (${v.count} events)`) : fail(`audit log BROKEN at event ${v.error?.seq}: ${v.error?.reason}`), !v.ok);

  // daemon
  try {
    const h = await apiCall<{ ok: boolean; sha?: string; uptimeSec: number }>('GET', '/healthz', undefined, 5000);
    out(ok(`daemon running (release ${h.sha?.slice(0, 10) ?? 'unmanaged'}, up ${h.uptimeSec}s)`));
    const hb = readJson<{ ts: number } | null>(paths.heartbeat, null);
    out(hb && Date.now() - hb.ts < 30_000 ? ok('heartbeat fresh') : warn('heartbeat is stale'));
    const s = await apiCall<any>('GET', '/v1/status');
    if (s.scheduler?.blockedReason) out(warn(`agent cannot start an episode: ${s.scheduler.blockedReason}`));
  } catch (e) {
    out(warn(`daemon not reachable: ${e instanceof Error ? e.message : e}`));
  }
  out(fs.existsSync(paths.current) ? ok(`current release -> ${path.basename(fs.realpathSync(paths.current))}`) : warn('no release installed yet (run `ouro init`)'));
  out(fs.existsSync('/opt/ouroboros/boot/ouro-boot.mjs') ? ok('boot supervisor installed') : warn('boot supervisor not installed in /opt/ouroboros/boot (provisioning does this)'));

  // resources
  try {
    const st = fs.statfsSync(paths.home);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    out(freeGb > 2 ? ok(`disk free ${freeGb.toFixed(1)} GB`) : fail(`only ${freeGb.toFixed(1)} GB free`), freeGb <= 2);
  } catch {
    /* statfs unsupported */
  }
  out(ok(`memory ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB, ${os.cpus().length} CPUs`));

  // network: works, and containment holds
  try {
    // test the route to the configured model provider, since that is the connection the agent depends on
    const upstream = PROVIDERS[cfg.llm.provider]?.upstream ?? 'https://api.anthropic.com';
    await dns.lookup(new URL(upstream).hostname);
    const r = await fetch(upstream + '/', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    out(ok(`internet reachable (${new URL(upstream).hostname} answered ${r.status})`));
  } catch (e) {
    out(fail(`cannot reach the internet: ${e instanceof Error ? e.message : e}`), true);
  }
  // // isolation test: the host and the gateway must not accept connections on common ports
  const gw = defaultGateway();
  const targets = [...new Set(['host.lima.internal', '192.168.5.2', gw].filter(Boolean) as string[])];
  const open: string[] = [];
  for (const t of targets) {
    let addr = t;
    try {
      addr = (await dns.lookup(t)).address;
    } catch {
      continue;
    }
    for (const port of [22, 80, 443, 8080, 5900]) if ((await tcpProbe(addr, port)) === 'open') open.push(`${t}:${port}`);
  }
  if (!targets.length) out(warn('could not determine the host/gateway address to test isolation'));
  else out(open.length ? fail(`LAN/host isolation NOT active: reached ${open.join(', ')}. The VM can talk to your Mac or network (see vm/provision/firewall.sh).`) : ok('the VM cannot reach the host or LAN services (isolation active)'), open.length > 0);

  // notifications + budget sanity
  const notifyOn = !!cfg.notify.ntfy.topic || !!cfg.notify.telegram.chatId;
  out(notifyOn ? ok('operator notifications configured') : warn('no notification channel configured: you will not be pinged when the agent needs you'));
  out(cfg.operator.jurisdiction ? ok(`jurisdiction ${cfg.operator.jurisdiction}`) : warn('jurisdiction not set (the agent will ask)'));
  out(ok(`budget: $${cfg.budget.sponsorDailyUsd}/day, $${cfg.budget.perEpisodeUsd}/episode (${cfg.budget.mode}-funded)`));

  if (deep) {
    console.log(dim('running the boot check (loads the agent extension in the real Pi)...'));
    const r = spawnSync(process.execPath, [path.join(paths.root, 'src', 'selftest', 'smoke.ts')], { encoding: 'utf8', timeout: 240_000 });
    out(r.status === 0 ? ok('boot check passed') : fail(`boot check failed:\n${(r.stdout + r.stderr).split('\n').slice(-12).join('\n')}`), r.status !== 0);
  } else console.log(dim('(use `ouro doctor --deep` to also run the full boot check)'));

  console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'} found.` : '\nAll checks passed.');
  return bad ? 1 : 0;
}
