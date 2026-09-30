// tests for venue adapters: the paper engine, child-process isolation and the evm wallet adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { runVenueMethod, resolveVenueModule } from '../src/core/venues/run.ts';
import { PaperExchange } from '../src/toolkit/paper.ts';
import { ROOT_DIR } from '../src/lib/paths.ts';
import { tmpEnv } from './helpers.ts';

function env() {
  const e = tmpEnv();
  fs.mkdirSync(e.paths.data, { recursive: true });
  return { ...e, p: { root: ROOT_DIR, home: e.paths.home, data: e.paths.data } };
}

test('resolveVenueModule: builtin, relative-to-home and absolute', () => {
  const { p } = env();
  assert.equal(resolveVenueModule('builtin/paper', p), path.join(ROOT_DIR, 'src/core/venues/paper.ts'));
  assert.equal(resolveVenueModule('kraken/index.ts', p), path.join(p.home, 'venues/kraken/index.ts'));
  assert.equal(resolveVenueModule('/abs/x.ts', p), '/abs/x.ts');
});

test('paper engine models fees and slippage and never lets you overspend', () => {
  const { dir } = env();
  const ex = new PaperExchange(path.join(dir, 'paper.json'), { feeBps: 10, slippageBps: 5 });
  ex.deposit(100);
  const fill = ex.buy('BTC', 50, 50_000);
  assert.ok(Math.abs(fill.price - 50_025) < 1e-6);
  assert.ok(Math.abs(fill.qty - 49.95 / 50_025) < 1e-12);
  assert.throws(() => ex.buy('BTC', 60, 50_000), /insufficient cash/);
  assert.throws(() => ex.sell('BTC', 1, 50_000), /insufficient BTC/);
  const sell = ex.sell('BTC', fill.qty, 50_000);
  const s = ex.load();
  assert.ok(s.cashUsd < 100, 'round trip must cost money');
  assert.ok(Math.abs(s.cashUsd - (50 + sell.qty * sell.price - sell.feeUsd)) < 1e-9);
  assert.deepEqual(s.positions, {});
});

test('the built-in paper venue reports its account through a real child process', async () => {
  const { p } = env();
  const ex = new PaperExchange(path.join(p.data, 'venues/paper/paper.json'));
  ex.deposit(10);
  ex.buy('ETH', 5, 2000);
  const r = await runVenueMethod<{ holdings: Array<{ asset: string; qty: number }> }>({ paths: p, module: 'builtin/paper', method: 'snapshot', venueId: 'paper' });
  assert.equal(r.ok, true, r.error);
  const usd = r.result!.holdings.find((h) => h.asset === 'USD')!;
  const eth = r.result!.holdings.find((h) => h.asset === 'ETH')!;
  assert.equal(usd.qty, 5);
  assert.ok(eth.qty > 0.002 && eth.qty < 0.0025);
});

function writeModule(dir: string, name: string, body: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
}

test('venue processes get declared secrets and args, and nothing else from the parent environment', async () => {
  const { p, dir } = env();
  process.env.SHOULD_NOT_LEAK = 'leak';
  const mod = writeModule(dir, 'echo.mjs', `export default { id: 'echo', async snapshot(ctx) { return { holdings: [{ asset: 'USD', qty: 1 }], note: JSON.stringify({ secret: ctx.env.MY_KEY, leaked: ctx.env.SHOULD_NOT_LEAK ?? null, args: ctx.args }) }; } };`);
  const r = await runVenueMethod<{ note: string }>({ paths: p, module: mod, method: 'snapshot', secrets: { MY_KEY: 'k-123' }, args: { a: 1 } });
  delete process.env.SHOULD_NOT_LEAK;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.result!.note), { secret: 'k-123', leaked: null, args: { a: 1 } });
});

test('a throwing, hanging, missing or chatty venue never breaks the caller', async () => {
  const { p, dir } = env();
  const bad = writeModule(dir, 'bad.mjs', `export default { id: 'bad', async snapshot() { throw new Error('boom'); } };`);
  const hang = writeModule(dir, 'hang.mjs', `export default { id: 'hang', async snapshot() { await new Promise(() => setInterval(() => {}, 1000)); } };`);
  const chatty = writeModule(dir, 'chatty.mjs', `console.log('hello from adapter'); export default { id: 'chatty', async snapshot() { console.log('more noise'); return { holdings: [] }; } };`);
  const noExport = writeModule(dir, 'empty.mjs', `export const x = 1;`);
  const r1 = await runVenueMethod({ paths: p, module: bad, method: 'snapshot' });
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /boom/);
  const r2 = await runVenueMethod({ paths: p, module: hang, method: 'snapshot', timeoutMs: 700 });
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /timed out/);
  const r3 = await runVenueMethod({ paths: p, module: path.join(dir, 'missing.mjs'), method: 'snapshot' });
  assert.equal(r3.ok, false);
  const r4 = await runVenueMethod({ paths: p, module: chatty, method: 'snapshot' });
  assert.equal(r4.ok, true);
  const r5 = await runVenueMethod({ paths: p, module: noExport, method: 'snapshot' });
  assert.equal(r5.ok, false);
  assert.match(r5.error!, /no default export/);
  const r6 = await runVenueMethod<{ id: string; hasFlows: boolean }>({ paths: p, module: chatty, method: 'describe' });
  assert.deepEqual([r6.ok, r6.result?.id, r6.result?.hasFlows], [true, 'chatty', false]);
});

function rpcServer(handler: (method: string, params: any[]) => unknown): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body);
        const one = (m: any) => ({ jsonrpc: '2.0', id: m.id, result: handler(m.method, m.params) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => s.close(() => r())) }));
  });
}

test('evm-wallet adapter reads native + USDC balances over JSON-RPC and sums them across chains', async () => {
  const { p, paths } = env();
  const addr = '0x1111111111111111111111111111111111111111';
  fs.writeFileSync(paths.wallets, JSON.stringify({ evm: { address: addr } }));
  const rpc = await rpcServer((method) => {
    if (method === 'eth_getBalance') return '0x' + (10n ** 15n).toString(16); // 0.001 ETH
    if (method === 'eth_call') return '0x' + (1_500_000n).toString(16).padStart(64, '0'); // 1.5 USDC
    if (method === 'eth_chainId') return '0x2105';
    throw new Error('unexpected ' + method);
  });
  try {
    const dataDir = path.join(p.data, 'venues', 'evm-wallet');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ chains: ['base', 'arbitrum'], rpc: { base: rpc.url, arbitrum: rpc.url } }));
    const r = await runVenueMethod<{ holdings: Array<{ asset: string; qty: number }> }>({ paths: p, module: 'builtin/evm-wallet', method: 'snapshot', venueId: 'evm-wallet' });
    assert.equal(r.ok, true, r.error);
    const by = Object.fromEntries(r.result!.holdings.map((h) => [h.asset, h.qty]));
    assert.ok(Math.abs(by.ETH - 0.002) < 1e-12, JSON.stringify(by));
    assert.ok(Math.abs(by.USDC - 3) < 1e-9, JSON.stringify(by));
  } finally {
    await rpc.close();
  }
});

test('evm-wallet adapter fails the whole snapshot if any chain is unreachable (no phantom loss)', async () => {
  const { p, paths } = env();
  fs.writeFileSync(paths.wallets, JSON.stringify({ evm: { address: '0x1111111111111111111111111111111111111111' } }));
  const dataDir = path.join(p.data, 'venues', 'evm-wallet');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ chains: ['base'], rpc: { base: 'http://127.0.0.1:1' } }));
  const r = await runVenueMethod({ paths: p, module: 'builtin/evm-wallet', method: 'snapshot', venueId: 'evm-wallet', timeoutMs: 30_000 });
  assert.equal(r.ok, false);
});
