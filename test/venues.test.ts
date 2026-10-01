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

test('evm-wallet scans confirmed Base USDC logs and successful ETH transfers with stable unique refs', async () => {
  const { p, paths } = env();
  const wallet = '0x1111111111111111111111111111111111111111';
  const sender = '0x2222222222222222222222222222222222222222';
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const cutoff = Date.UTC(2026, 0, 2);
  const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;
  const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
  const tx = (n: number, value: bigint, blockNumber: number) => ({ hash: hash(n), blockHash: hash(blockNumber + 100), blockNumber: hex(blockNumber), from: sender, to: wallet, value: hex(value), gas: '0x5208', gasPrice: '0x1', input: '0x', nonce: '0x0', transactionIndex: hex(n - 1), type: '0x0', v: '0x1b', r: hash(0), s: hash(0) });
  const transfers = [
    { block: 4, index: 0, value: 1_500_000 },
    { block: 4, index: 1, value: 2_000_000 },
    { block: 4, index: 2, value: 4_000_000, own: true }, // swap proceeds are not external funding.
    { block: 5, index: 0, value: 3_000_000 },
    { block: 6, index: 0, value: 9_000_000 }, // the unconfirmed block must stay invisible.
  ];
  const methods: string[] = [];
  const rpc = await rpcServer((method, params) => {
    methods.push(method);
    if (method === 'eth_blockNumber') return hex(17); // block 5 has 12 confirmations.
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(params[0]));
      assert.ok(n <= 5, 'unconfirmed blocks must not be read');
      const transactions = n === 4 ? [tx(1, 1_000_000_000_000_000n, n), tx(2, 100_000_000_000_000_000n, n), { ...tx(24, 0n, n), to: usdc }, { ...tx(26, 0n, n), from: wallet, to: usdc }] : n === 5 ? [{ ...tx(25, 0n, n), to: usdc }] : [];
      return { number: hex(n), timestamp: hex(Math.floor((cutoff - 5_000 + n * 1_000) / 1000)), hash: hash(n + 100), parentHash: hash(n + 99), nonce: '0x0000000000000000', sha3Uncles: hash(0), logsBloom: `0x${'0'.repeat(512)}`, transactionsRoot: hash(0), stateRoot: hash(0), receiptsRoot: hash(0), miner: wallet, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: '0x100000', gasUsed: '0x0', baseFeePerGas: '0x1', transactions: params[1] ? transactions : transactions.map((t) => t.hash), uncles: [] };
    }
    if (method === 'eth_getLogs') {
      const filter = params[0];
      assert.equal(filter.address.toLowerCase(), usdc.toLowerCase());
      assert.equal(filter.topics[2].toLowerCase(), topicAddress(wallet).toLowerCase());
      return transfers.filter((t) => t.block >= Number(BigInt(filter.fromBlock)) && t.block <= Number(BigInt(filter.toBlock))).map((t) => ({ address: usdc, blockNumber: hex(t.block), blockHash: hash(t.block + 100), transactionHash: hash(t.own ? 26 : 20 + t.block), transactionIndex: '0x0', logIndex: hex(t.index), data: hash(t.value), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topicAddress(sender), topicAddress(wallet)], removed: false }));
    }
    if (method === 'eth_getTransactionReceipt') {
      const failed = params[0] === hash(2);
      return { blockHash: hash(104), blockNumber: '0x4', contractAddress: null, cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', from: sender, to: wallet, gasUsed: '0x5208', logs: [], logsBloom: `0x${'0'.repeat(512)}`, status: failed ? '0x0' : '0x1', transactionHash: params[0], transactionIndex: failed ? '0x1' : '0x0', type: '0x0' };
    }
    throw new Error(`unexpected ${method}`);
  });
  try {
    fs.writeFileSync(paths.wallets, JSON.stringify({ evm: { address: wallet } }));
    const dataDir = path.join(p.data, 'venues', 'evm-wallet');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ chains: ['base'], rpc: { base: rpc.url } }));
    const scan = (since: number) => runVenueMethod<{ flows: Array<{ asset: string; qty: number; ref: string; ts: number }>; through: number }>({ paths: p, module: 'builtin/evm-wallet', method: 'flows', venueId: 'evm-wallet', args: { since } });
    const first = await scan(cutoff - 2_500);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.result!.through, cutoff);
    assert.equal(first.result!.flows.length, 4);
    assert.equal(new Set(first.result!.flows.map((f) => f.ref)).size, 4);
    assert.deepEqual(first.result!.flows.map((f) => f.asset).sort(), ['ETH', 'USDC', 'USDC', 'USDC']);
    assert.equal(first.result!.flows.find((f) => f.asset === 'ETH')?.qty, 0.001);
    assert.equal(first.result!.flows.filter((f) => f.ts < cutoff).length, 3);
    assert.deepEqual((await scan(cutoff - 2_500)).result!.flows.map((f) => f.ref), first.result!.flows.map((f) => f.ref));
    assert.equal((await scan(cutoff)).result!.flows.length, 1);
    assert.ok(methods.includes('eth_getTransactionReceipt'));
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
