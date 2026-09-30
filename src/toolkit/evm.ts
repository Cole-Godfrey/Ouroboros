// EVM wallet helpers for the agent's own on-chain "bank account".
// Private keys live only in the vault (WALLET_EVM_KEY); wallets.json holds the public address.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readJson, writeJson } from '../lib/fsx.ts';
import type { Vault } from '../core/vault.ts';

export interface WalletBook {
  evm?: { address: string; createdAt: number; note?: string };
}

export function newEvmWallet(): { privateKey: `0x${string}`; address: string } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export function addressOf(privateKey: string): string {
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}

/** Create the wallet once. Returns the (existing or new) public address; never returns the key. */
export function ensureEvmWallet(vault: Vault, walletsFile: string, now = Date.now()): { address: string; created: boolean } {
  const book = readJson<WalletBook>(walletsFile, {});
  const existingKey = vault.has('WALLET_EVM_KEY') ? vault.get('WALLET_EVM_KEY') : undefined;
  if (existingKey) {
    const address = addressOf(existingKey);
    if (book.evm?.address !== address) writeJson(walletsFile, { ...book, evm: { address, createdAt: book.evm?.createdAt ?? now } });
    return { address, created: false };
  }
  const w = newEvmWallet();
  vault.set('WALLET_EVM_KEY', w.privateKey, 'agent EVM wallet (Base/Arbitrum/Optimism/Polygon/Ethereum)');
  writeJson(walletsFile, { ...book, evm: { address: w.address, createdAt: now } });
  return { address: w.address, created: true };
}
