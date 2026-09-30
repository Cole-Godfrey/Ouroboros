// tests for the operator cli, run as a real subprocess against a temporary state directory with the daemon down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { Inbox } from '../src/core/inbox.ts';
import { ROOT_DIR } from '../src/lib/paths.ts';
import { tmpEnv } from './helpers.ts';

function setup() {
  const e = tmpEnv();
  const env = { ...e.env, OURO_OFFLINE: '1', NO_COLOR: '1', TEST_KEY: 'sk-ant-test-1234567890abcdef', OURO_LIMITS_FILE: path.join(e.dir, 'etc', 'limits.json'), OURO_CHARTER_SEAL: path.join(e.dir, 'etc', 'charter.sha256') };
  const ouro = (args: string[], input?: string) => {
    const r = spawnSync(path.join(ROOT_DIR, 'bin', 'ouro'), args, { env, input, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { ...e, env, ouro };
}

test('init (non-interactive) sets up state, vault, wallet, limits and the charter seal', () => {
  const t = setup();
  const r = t.ouro(['init', '--yes', '--jurisdiction', 'US-CA', '--timezone', 'America/Los_Angeles', '--provider', 'anthropic', '--model', 'claude-sonnet-5-5', '--mode', 'sponsor', '--key-from-env', 'TEST_KEY', '--daily-budget', '4', '--episode-budget', '1']);
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(fs.readFileSync(t.paths.config, 'utf8'));
  assert.equal(cfg.operator.jurisdiction, 'US-CA');
  assert.equal(cfg.budget.sponsorDailyUsd, 4);
  assert.match(cfg.notify.ntfy.topic, /^ouro-[a-z0-9]{10,}$/);
  const wallets = JSON.parse(fs.readFileSync(t.paths.wallets, 'utf8'));
  assert.match(wallets.evm.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(r.out, new RegExp(wallets.evm.address));
  assert.ok(!r.out.includes('sk-ant-test-1234567890abcdef'), 'the key is never echoed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'etc', 'limits.json'), 'utf8')).sponsorDailyUsd, 4);
  assert.match(fs.readFileSync(path.join(t.dir, 'etc', 'charter.sha256'), 'utf8'), /^[0-9a-f]{64}\n$/);
  const list = t.ouro(['secret', 'list']);
  assert.match(list.out, /ANTHROPIC_API_KEY/);
  assert.ok(!list.out.includes('sk-ant-test'));
  // re-running is safe and keeps the same wallet
  const again = t.ouro(['init', '--yes']);
  assert.equal(again.code, 0, again.out);
  assert.equal(JSON.parse(fs.readFileSync(t.paths.wallets, 'utf8')).evm.address, wallets.evm.address);
});

test('operator flows work with the daemon down: fund, secret, say/reply/done, budget, pause, ledger, charter', () => {
  const t = setup();
  t.ouro(['init', '--yes', '--provider', 'anthropic', '--model', 'claude-sonnet-5-5', '--key-from-env', 'TEST_KEY']);

  assert.equal(t.ouro(['fund', 'add', '1', '--venue', 'evm-wallet', '--note', 'first dollar']).code, 0);
  const funds = t.ouro(['fund']);
  assert.match(funds.out, /first dollar/);
  assert.match(funds.out, /Net contributed: \$1\.00/);
  assert.match(t.ouro(['fund', 'add', 'abc']).out, /not a number/);

  const st = t.ouro(['status']);
  assert.match(st.out, /NOT RUNNING/);
  assert.match(st.out, /contributed \$1\.00/);

  assert.equal(t.ouro(['secret', 'set', 'KRAKEN_API_KEY', '--from-env', 'TEST_KEY', '--note', 'read+trade']).code, 0);
  assert.match(t.ouro(['secret', 'list']).out, /KRAKEN_API_KEY\s+read\+trade/);
  assert.equal(t.ouro(['secret', 'rm', 'KRAKEN_API_KEY']).code, 0);
  assert.doesNotMatch(t.ouro(['secret', 'list']).out, /KRAKEN_API_KEY/);
  assert.notEqual(t.ouro(['secret', 'set', 'lowercase', '--from-env', 'TEST_KEY']).code, 0);

  // an agent request in the inbox, answered by the operator
  const store = new StateStore(new EventLog(t.paths.events, { lockDir: t.paths.eventsLock }));
  const item = new Inbox(store, {}).create({ kind: 'request', title: 'Please fund me', steps: ['send USDC'], secrets: ['X_KEY'], blocking: 'no trading until then' });
  const inbox = t.ouro(['inbox']);
  assert.match(inbox.out, new RegExp(`#${item.id}`));
  assert.match(inbox.out, /1\. send USDC/);
  assert.match(inbox.out, /ouro secret set X_KEY/);
  assert.equal(t.ouro(['reply', item.id, 'done', 'and', 'funded']).code, 0);
  assert.match(t.ouro(['inbox']).out, /done and funded/);
  assert.equal(t.ouro(['say', 'how', 'is', 'it', 'going?']).code, 0);
  store.sync();
  assert.equal(store.state.unseenForAgent().length, 2);
  assert.equal(t.ouro(['done', item.id]).code, 0);
  assert.match(t.ouro(['inbox', '--all']).out, /\[done\]/);

  assert.equal(t.ouro(['budget', 'set', '--daily', '3', '--episode', '0.5']).code, 0);
  assert.match(t.ouro(['budget']).out, /\$3\/day, \$0\.5\/episode/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'etc', 'limits.json'), 'utf8')).sponsorDailyUsd, 3);
  assert.notEqual(t.ouro(['budget', 'set', '--daily', '-1']).code, 0);

  assert.match(t.ouro(['pause']).out, /Paused/);
  store.sync();
  assert.equal(store.state.control.paused, true);
  assert.match(t.ouro(['resume']).out, /Resumed/);

  assert.match(t.ouro(['ledger', 'verify']).out, /verifies/);
  const csv = t.ouro(['ledger', 'export', '--kind', 'flows']).out;
  assert.match(csv, /time,direction,usd,venue,note,ref/);
  assert.match(csv, /,in,1,evm-wallet,first dollar,/);
  assert.match(t.ouro(['ledger', 'tail', '5']).out, /control/);

  assert.match(t.ouro(['charter']).out, /sealed-ok/);
  assert.match(t.ouro(['wallet']).out, /0x[0-9a-fA-F]{40}/);
  assert.match(t.ouro(['help']).out, /Everyday/);
  assert.notEqual(t.ouro(['frobnicate']).code, 0);
});

test('a modified charter is reported as a mismatch against the operator seal', () => {
  const t = setup();
  t.ouro(['init', '--yes']);
  fs.writeFileSync(path.join(t.dir, 'etc', 'charter.sha256'), '0'.repeat(64) + '\n');
  const c = t.ouro(['charter']);
  assert.match(c.out, /mismatch/);
});

test('wallet export refuses to print the key without an interactive terminal', () => {
  const t = setup();
  t.ouro(['init', '--yes', '--provider', 'anthropic', '--model', 'claude-sonnet-5-5', '--key-from-env', 'TEST_KEY']);
  const address = JSON.parse(fs.readFileSync(t.paths.wallets, 'utf8')).evm.address as string;
  const r = t.ouro(['wallet', 'export']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /interactive terminal/);
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(r.out), 'no private key in the output');
  assert.match(t.ouro(['wallet']).out, new RegExp(address));
  assert.match(t.ouro(['wallet']).out, /wallet export/);
});
