// encrypted secret store (AES-256-GCM).
//
// purpose: keep API keys and wallet keys out of plaintext files, out of the git
// repository, out of logs and out of the model's context window. secrets are
// handed to processes as environment variables only for the lifetime of that
// process, and every outbound string passes through the redactor.
//
// honest limit: the agent has root inside its own VM, so it *can* read its keys
// if it goes looking. the vault prevents accidents, not intent. scope every key
// (no withdrawal rights, per-strategy sub-accounts) as if the agent could read it.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, withLockSync, writeFileAtomic } from '../lib/fsx.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import { globalRedactor, type Redactor } from '../lib/redact.ts';
import type { Paths } from '../lib/paths.ts';

export interface SecretMeta {
  name: string;
  createdAt: number;
  updatedAt: number;
  note?: string;
  length: number;
}

interface VaultFile {
  v: 1;
  mode: 'keyfile' | 'passphrase';
  salt?: string;
  nonce: string;
  tag: string;
  ct: string;
}

interface Plain {
  secrets: Record<string, { value: string; createdAt: number; updatedAt: number; note?: string }>;
}

const AAD = Buffer.from('ouroboros-vault-v1');
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export class VaultError extends Error {}

// secrets live in one encrypted file (aes-256-gcm). the key comes from a key file next to it,
// or from a passphrase in the environment. every change also refreshes the redactor, so a new secret is
// masked in all output immediately.
export class Vault {
  private paths: Pick<Paths, 'vaultDir' | 'vaultFile' | 'masterKey'>;
  private clock: Clock;
  private redactor: Redactor;
  private passphrase?: string;

  constructor(
    paths: Pick<Paths, 'vaultDir' | 'vaultFile' | 'masterKey'>,
    opts: { clock?: Clock; redactor?: Redactor; passphrase?: string } = {},
  ) {
    this.paths = paths;
    this.clock = opts.clock ?? systemClock;
    this.redactor = opts.redactor ?? globalRedactor;
    this.passphrase = opts.passphrase ?? process.env.OURO_VAULT_PASSPHRASE;
  }

  /** create the key file (keyfile mode) if neither it nor a passphrase exists. idempotent. */
  init(): void {
    ensureDir(this.paths.vaultDir, 0o700);
    try {
      fs.chmodSync(this.paths.vaultDir, 0o700);
    } catch {
      /* not fatal */
    }
    if (this.passphrase) return;
    if (!fs.existsSync(this.paths.masterKey)) {
      writeFileAtomic(this.paths.masterKey, randomBytes(32).toString('hex') + '\n', 0o600);
    }
  }

  private lockDir(): string {
    return path.join(this.paths.vaultDir, '.lock');
  }

  private deriveKey(file?: VaultFile): { key: Buffer; mode: 'keyfile' | 'passphrase'; salt?: string } {
    const mode = file?.mode ?? (this.passphrase ? 'passphrase' : 'keyfile');
    if (mode === 'passphrase') {
      if (!this.passphrase) throw new VaultError('vault is passphrase-protected: set OURO_VAULT_PASSPHRASE');
      const salt = file?.salt ?? randomBytes(16).toString('hex');
      const key = scryptSync(this.passphrase, Buffer.from(salt, 'hex'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
      return { key, mode, salt };
    }
    let hex: string;
    try {
      hex = fs.readFileSync(this.paths.masterKey, 'utf8').trim();
    } catch {
      throw new VaultError(`vault key missing: ${this.paths.masterKey} (run \`ouro init\`)`);
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new VaultError('vault key file is malformed');
    return { key: Buffer.from(hex, 'hex'), mode };
  }

  private read(): Plain {
    if (!fs.existsSync(this.paths.vaultFile)) return { secrets: {} };
    const file = readJson<VaultFile | null>(this.paths.vaultFile, null);
    if (!file) return { secrets: {} };
    const { key } = this.deriveKey(file);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce, 'hex'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
      const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, 'hex')), decipher.final()]);
      return JSON.parse(pt.toString('utf8')) as Plain;
    } catch {
      throw new VaultError('vault decryption failed (wrong key, or the file was modified)');
    }
  }

  private write(plain: Plain): void {
    const existing = fs.existsSync(this.paths.vaultFile) ? readJson<VaultFile | null>(this.paths.vaultFile, null) : null;
    const { key, mode, salt } = this.deriveKey(existing ?? undefined);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
    const out: VaultFile = { v: 1, mode, salt, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex') };
    writeFileAtomic(this.paths.vaultFile, JSON.stringify(out) + '\n', 0o600);
  }

  // read-modify-write under a lock so two processes cannot overwrite each other's changes
  private mutate<T>(fn: (p: Plain) => T): T {
    this.init();
    return withLockSync(this.lockDir(), () => {
      const p = this.read();
      const r = fn(p);
      this.write(p);
      this.refreshRedactor(p);
      return r;
    });
  }

  private refreshRedactor(p: Plain): void {
    this.redactor.setSecrets(Object.entries(p.secrets).map(([n, s]) => [n, s.value]));
  }

  /** load every secret value into the redactor (call at process start). */
  loadRedactor(): number {
    try {
      const p = this.read();
      this.refreshRedactor(p);
      return Object.keys(p.secrets).length;
    } catch {
      return 0;
    }
  }

  list(): SecretMeta[] {
    const p = this.read();
    return Object.entries(p.secrets)
      .map(([name, s]) => ({ name, createdAt: s.createdAt, updatedAt: s.updatedAt, note: s.note, length: s.value.length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return name in this.read().secrets;
  }

  get(name: string): string | undefined {
    return this.read().secrets[name]?.value;
  }

  set(name: string, value: string, note?: string): void {
    if (!SECRET_NAME_RE.test(name)) throw new VaultError(`secret names look like ENV_VARS: ${SECRET_NAME_RE}`);
    if (!value) throw new VaultError('empty secret');
    this.mutate((p) => {
      const now = this.clock();
      const prev = p.secrets[name];
      p.secrets[name] = { value, createdAt: prev?.createdAt ?? now, updatedAt: now, note: note ?? prev?.note };
    });
  }

  delete(name: string): boolean {
    return this.mutate((p) => {
      const had = name in p.secrets;
      delete p.secrets[name];
      return had;
    });
  }

  /** environment variables for the requested secret names. missing ones are reported, not thrown. */
  env(names: string[]): { env: Record<string, string>; missing: string[] } {
    const p = this.read();
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const n of names) {
      const s = p.secrets[n];
      if (s) env[n] = s.value;
      else missing.push(n);
    }
    return { env, missing };
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }
}
