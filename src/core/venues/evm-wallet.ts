// reference venue adapter: balances of the agent's own EVM wallet.
//
// reports the native gas token and USDC on the chains listed in
// $OURO_HOME/data/venues/evm-wallet/config.json (default: Base, Arbitrum,
// optimism, Polygon, Ethereum) using public RPC endpoints. everything else the
// wallet holds can be added as tokens in that config, or by extending this file.
//
// if ANY configured chain cannot be read the whole snapshot fails: a partial
// answer would look like a phantom loss.

import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, parseAbiItem, type Chain } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import type { VenueContext, VenueFlow, VenueFlowScan, VenueHolding, VenueModule } from './types.ts';

const CHAINS: Record<string, { chain: Chain; native: string; usdc: `0x${string}` }> = {
  base: { chain: base, native: 'ETH', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  arbitrum: { chain: arbitrum, native: 'ETH', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  optimism: { chain: optimism, native: 'ETH', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  polygon: { chain: polygon, native: 'POL', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  ethereum: { chain: mainnet, native: 'ETH', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
};

interface EvmConfig {
  chains?: string[];
  rpc?: Record<string, string>;
  tokens?: Array<{ chain: string; address: string; symbol: string; decimals: number }>;
}

// count transfers after twelve later blocks and resume large backfills in bounded chunks.
const BASE_CONFIRMATIONS = 12n;
const MAX_SCAN_BLOCKS = 1_000n;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

function readAddress(ctx: VenueContext): string {
  if (ctx.env.WALLET_EVM_ADDRESS) return ctx.env.WALLET_EVM_ADDRESS;
  const home = ctx.env.OURO_HOME;
  if (home) {
    try {
      const book = JSON.parse(fs.readFileSync(path.join(home, 'wallets.json'), 'utf8')) as { evm?: { address?: string } };
      if (book.evm?.address) return book.evm.address;
    } catch {
      /* fall through */
    }
  }
  throw new Error('no wallet address: run `ouro wallet new evm`');
}

function readConfig(ctx: VenueContext): EvmConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8')) as EvmConfig;
  } catch {
    return {};
  }
}

const venue: VenueModule = {
  id: 'evm-wallet',
  description: "The agent's own EVM wallet: native gas token + USDC on Base, Arbitrum, Optimism, Polygon and Ethereum (configurable).",
  // read the native balance and usdc on every configured chain.
  // if any chain cannot be read the whole snapshot fails, because a partial answer would look like a loss.
  async snapshot(ctx) {
    const address = readAddress(ctx) as `0x${string}`;
    const cfg = readConfig(ctx);
    const names = cfg.chains ?? Object.keys(CHAINS);
    const holdings: VenueHolding[] = [];
    await Promise.all(
      names.map(async (name) => {
        const spec = CHAINS[name];
        if (!spec) throw new Error(`unknown chain "${name}"`);
        const client = createPublicClient({ chain: spec.chain, transport: http(cfg.rpc?.[name], { timeout: 15_000, retryCount: 2 }) });
        const [native, usdc] = await Promise.all([
          client.getBalance({ address }),
          client.readContract({ address: spec.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        ]);
        holdings.push({ asset: spec.native, qty: Number(formatEther(native)) });
        holdings.push({ asset: 'USDC', qty: Number(formatUnits(usdc, 6)) });
        for (const t of (cfg.tokens ?? []).filter((x) => x.chain === name)) {
          const bal = await client.readContract({ address: t.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
          holdings.push({ asset: t.symbol.toUpperCase(), qty: Number(formatUnits(bal, t.decimals)) });
        }
      }),
    );
    // merge per-asset across chains
    const merged = new Map<string, number>();
    for (const h of holdings) merged.set(h.asset, (merged.get(h.asset) ?? 0) + h.qty);
    return { holdings: [...merged].map(([asset, qty]) => ({ asset, qty })), note: `${address} on ${names.join(', ')}` };
  },
  async flows(ctx, sinceTs): Promise<VenueFlowScan> {
    const cfg = readConfig(ctx);
    if (!(cfg.chains ?? Object.keys(CHAINS)).includes('base')) return { flows: [], through: ctx.now };
    const address = readAddress(ctx) as `0x${string}`;
    const wallet = address.toLowerCase();
    const client = createPublicClient({ chain: base, transport: http(cfg.rpc?.base, { timeout: 15_000, retryCount: 2 }) });
    const head = await client.getBlockNumber();
    const confirmed = head > BASE_CONFIRMATIONS ? head - BASE_CONFIRMATIONS : 0n;
    const tip = await client.getBlock({ blockNumber: confirmed });
    const tipTs = Number(tip.timestamp) * 1000;
    if (tipTs < sinceTs) return { flows: [], through: tipTs };

    // block timestamps are monotonic, so locate the first block in the requested window.
    let low = 0n;
    let high = confirmed + 1n;
    while (low < high) {
      const mid = (low + high) / 2n;
      const block = await client.getBlock({ blockNumber: mid });
      if (Number(block.timestamp) * 1000 < sinceTs) low = mid + 1n;
      else high = mid;
    }
    const end = low + MAX_SCAN_BLOCKS - 1n < confirmed ? low + MAX_SCAN_BLOCKS - 1n : confirmed;
    const logs = await client.getLogs({ address: CHAINS.base.usdc, event: TRANSFER, args: { to: address }, fromBlock: low, toBlock: end });
    const blocks = new Map<bigint, Awaited<ReturnType<typeof client.getBlock>>>();
    let next = low;
    // keep native-transfer block reads bounded so public RPCs can serve a full scan.
    await Promise.all(Array.from({ length: 12 }, async () => {
      for (let number = next++; number <= end; number = next++) {
        blocks.set(number, await client.getBlock({ blockNumber: number, includeTransactions: true }));
      }
    }));
    const flows: VenueFlow[] = [];
    for (const log of logs) {
      if (!log.transactionHash || log.logIndex === null || log.args.from?.toLowerCase() === wallet) continue;
      const block = blocks.get(log.blockNumber!);
      if (!block) throw new Error('missing block for Base USDC transfer');
      flows.push({ kind: 'deposit', asset: 'USDC', qty: Number(formatUnits(log.args.value ?? 0n, 6)), ref: `base:${log.transactionHash}:usdc:${log.logIndex}`, from: log.args.from, to: address, ts: Number(block.timestamp) * 1000 });
    }
    for (const block of blocks.values()) {
      for (const tx of block.transactions) {
        if (typeof tx === 'string' || tx.to?.toLowerCase() !== wallet || tx.from.toLowerCase() === wallet || tx.value === 0n) continue;
        // a reverted call has no incoming value even when its transaction declares one.
        const receipt = await client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.status !== 'success') continue;
        flows.push({ kind: 'deposit', asset: 'ETH', qty: Number(formatEther(tx.value)), ref: `base:${tx.hash}:eth`, from: tx.from, to: address, ts: Number(block.timestamp) * 1000 });
      }
    }
    flows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.ref.localeCompare(b.ref));
    return { flows, through: Number(blocks.get(end)!.timestamp) * 1000 };
  },
};

export default venue;
