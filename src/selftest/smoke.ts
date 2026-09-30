// Boot check run by the self-modification gate against a *candidate* release.
//
// It starts the candidate's own daemon in an isolated sandbox (temp HOME, random
// ports, no agent, no timers) and verifies the invariants that must never break:
// the daemon boots, serves its API, keeps a valid audit chain, the inbox and
// ledger endpoints work, the dashboard loads, and the Charter is intact. If the
// real Pi binary is installed it also loads the agent's extension into Pi and
// checks that every required tool registers.
//
// This file is protected: changing it makes a promotion "high risk".

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Daemon } from '../core/daemon.ts';
import { checkCharter } from '../core/charter.ts';
import { ROOT_DIR } from '../lib/paths.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

function call(socketPath: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { raw } });
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const REQUIRED_TOOLS = ['ouro_status', 'episode_end', 'inbox', 'journal', 'venue', 'ledger_record', 'strategy', 'selfmod', 'secret_exec', 'wake_set', 'web_fetch'];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouro-smoke-'));
  const env: NodeJS.ProcessEnv = { ...process.env, OURO_HOME: path.join(tmp, 'home'), OURO_CODE: path.join(tmp, 'code'), OURO_ETC: path.join(tmp, 'etc') };
  fs.mkdirSync(env.OURO_ETC!, { recursive: true });
  const charter = checkCharter({ charterSeal: path.join(env.OURO_ETC!, 'charter.sha256') }, ROOT_DIR);
  check('charter file present', charter.state !== 'missing', charter.message);

  const d = await Daemon.create({ env, selftest: true });
  try {
    await d.start();
    const sock = d.paths.sock;
    const health = await call(sock, 'GET', '/healthz');
    check('daemon serves /healthz', health.status === 200 && health.json.ok === true);

    const st = await call(sock, 'GET', '/v1/status');
    check('status endpoint reports metrics', st.status === 200 && typeof st.json.metrics?.navUsd === 'number');

    const sent = await call(sock, 'POST', '/v1/inbox/send', { kind: 'info', title: 'smoke test', body: 'hello' });
    check('inbox accepts a message', sent.status === 200 && typeof sent.json.id === 'string');
    const say = await call(sock, 'POST', '/v1/inbox/say', { text: 'operator says hi' });
    check('operator messages are accepted', say.status === 200);
    const inbox = await call(sock, 'GET', '/v1/inbox');
    check('agent sees the operator message as unseen', inbox.json.unseen?.length === 1);

    const fund = await call(sock, 'POST', '/v1/fund', { direction: 'in', usd: 1, note: 'smoke' });
    check('capital can be recorded', fund.status === 200 && fund.json.netContributedUsd === 1);

    const verify = await call(sock, 'GET', '/v1/ledger/verify');
    check('audit chain verifies', verify.status === 200 && verify.json.ok === true, `${verify.json.count} events`);

    const dash = await call(sock, 'GET', '/v1/dashboard');
    check('dashboard payload builds', dash.status === 200 && Array.isArray(dash.json.nav));

    const denied = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: d.dashboardPort, path: '/v1/status' }, (res) => resolve(res.statusCode ?? 0)).on('error', () => resolve(0));
    });
    check('dashboard listener requires a token', denied === 401, `status ${denied}`);
    const html = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: d.dashboardPort, path: '/' }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(raw));
      }).on('error', () => resolve(''));
    });
    check('dashboard page is served', html.includes('Ouroboros'));

    const red = await call(sock, 'POST', '/v1/secret/set', { name: 'SMOKE_SECRET', value: 'smoke-secret-value-123456' });
    const echoed = await call(sock, 'POST', '/v1/redact', { text: 'the secret is smoke-secret-value-123456' });
    check('vault + redaction work end to end', red.status === 200 && !String(echoed.json.text).includes('smoke-secret-value-123456'));

    const ext = path.join(ROOT_DIR, 'src', 'pi', 'extension', 'index.ts');
    const pi = [path.join(ROOT_DIR, 'node_modules', '.bin', 'pi')].find((p) => fs.existsSync(p));
    if (pi && fs.existsSync(ext)) {
      const tools = await piTools(pi, ext, env, tmp);
      const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
      check('the Pi extension loads and registers every required tool', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${tools.length} tools`);
    } else {
      console.log('skip Pi extension check (pi or the extension is not present)');
    }
  } finally {
    await d.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\nSMOKE TEST FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nsmoke test passed');
  process.exit(0);
}

/** Start the real Pi in RPC mode with our extension and ask it (via the /ouro-tools command) which tools exist. */
function piTools(pi: string, ext: string, env: NodeJS.ProcessEnv, tmp: string): Promise<string[]> {
  return new Promise((resolve) => {
    const agentDir = path.join(tmp, 'pi');
    fs.mkdirSync(agentDir, { recursive: true });
    const child = spawn(pi, ['--mode', 'rpc', '--no-session', '--offline', '-e', ext], {
      env: { PATH: process.env.PATH, HOME: tmp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', OURO_HOME: env.OURO_HOME!, OURO_ROOT: ROOT_DIR, OURO_SOCK: path.join(env.OURO_HOME!, 'run', 'ouro.sock') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let done = false;
    const finish = (tools: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(tools);
    };
    const timer = setTimeout(() => finish([]), 60_000);
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'extension_ui_request' && msg.method === 'notify' && typeof msg.message === 'string' && msg.message.startsWith('OURO_TOOLS:')) {
            finish(msg.message.slice('OURO_TOOLS:'.length).split(',').filter(Boolean));
          }
        } catch {
          /* not protocol */
        }
      }
    });
    child.on('exit', () => finish([]));
    child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: '/ouro-tools' }) + '\n');
  });
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
