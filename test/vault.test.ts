// tests for the encrypted vault and the redactor it feeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Vault, VaultError } from '../src/core/vault.ts';
import { Redactor } from '../src/lib/redact.ts';
import { tmpDir } from './helpers.ts';

function mk(passphrase?: string) {
  const dir = tmpDir();
  const paths = { vaultDir: path.join(dir, 'vault'), vaultFile: path.join(dir, 'vault', 'secrets.enc.json'), masterKey: path.join(dir, 'vault', 'master.key') };
  const redactor = new Redactor();
  return { dir, paths, redactor, vault: new Vault(paths, { redactor, passphrase }) };
}

test('set/get/list/delete round trip; the file on disk never contains the plaintext', () => {
  const { vault, paths } = mk();
  vault.init();
  vault.set('KRAKEN_API_KEY', 'abcdef-1234567890-secret', 'read-only key');
  vault.set('WALLET_EVM_KEY', '0x' + 'ab'.repeat(32));
  assert.equal(vault.get('KRAKEN_API_KEY'), 'abcdef-1234567890-secret');
  assert.deepEqual(vault.list().map((s) => s.name), ['KRAKEN_API_KEY', 'WALLET_EVM_KEY']);
  assert.equal(vault.list()[0].note, 'read-only key');
  const raw = fs.readFileSync(paths.vaultFile, 'utf8');
  assert.ok(!raw.includes('abcdef-1234567890-secret'));
  assert.ok(!raw.includes('ab'.repeat(32)));
  assert.equal(vault.delete('KRAKEN_API_KEY'), true);
  assert.equal(vault.delete('KRAKEN_API_KEY'), false);
  assert.equal(vault.has('KRAKEN_API_KEY'), false);
});

test('files are created with restrictive permissions', () => {
  const { vault, paths } = mk();
  vault.set('SOME_TOKEN', 'value-value-value');
  assert.equal(fs.statSync(paths.vaultFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.masterKey).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.vaultDir).mode & 0o777, 0o700);
});

test('tampering or a different key makes decryption fail loudly', () => {
  const { vault, paths } = mk();
  vault.set('A_SECRET', 'value-value-value');
  const f = JSON.parse(fs.readFileSync(paths.vaultFile, 'utf8'));
  f.ct = (f.ct[0] === 'a' ? 'b' : 'a') + f.ct.slice(1);
  fs.writeFileSync(paths.vaultFile, JSON.stringify(f));
  assert.throws(() => vault.get('A_SECRET'), VaultError);

  const other = mk();
  other.vault.set('A_SECRET', 'value-value-value');
  fs.copyFileSync(other.paths.vaultFile, paths.vaultFile); // key file of `vault` does not match
  assert.throws(() => vault.get('A_SECRET'), /decryption failed/);
});

test('names must look like env vars and values must be non-empty', () => {
  const { vault } = mk();
  assert.throws(() => vault.set('lower', 'x'), VaultError);
  assert.throws(() => vault.set('OK_NAME', ''), VaultError);
});

test('env() returns what exists and reports what is missing', () => {
  const { vault } = mk();
  vault.set('ONE_KEY', 'value-one-value');
  const r = vault.env(['ONE_KEY', 'TWO_KEY']);
  assert.deepEqual(r.env, { ONE_KEY: 'value-one-value' });
  assert.deepEqual(r.missing, ['TWO_KEY']);
});

test('every stored secret is registered with the redactor, including the bare hex of a private key', () => {
  const { vault, redactor } = mk();
  const pk = '0x' + '12'.repeat(32);
  vault.set('WALLET_EVM_KEY', pk);
  vault.set('API_TOKEN', 'tok_live_abcdefghijklmnop');
  const text = `key=${pk} bare=${pk.slice(2)} token=tok_live_abcdefghijklmnop end`;
  const out = redactor.redact(text);
  assert.ok(!out.includes('12'.repeat(32)));
  assert.ok(!out.includes('tok_live_abcdefghijklmnop'));
  assert.match(out, /«WALLET_EVM_KEY»/);
  assert.match(out, /«API_TOKEN»/);
});

test('passphrase mode derives the key from the passphrase and refuses the wrong one', () => {
  const a = mk('correct horse battery staple');
  a.vault.set('P_SECRET', 'value-value-value');
  assert.equal(fs.existsSync(a.paths.masterKey), false);
  assert.equal(a.vault.get('P_SECRET'), 'value-value-value');
  const wrong = new Vault(a.paths, { redactor: new Redactor(), passphrase: 'wrong' });
  assert.throws(() => wrong.get('P_SECRET'), VaultError);
});

test('generic patterns catch API-key shaped strings even when unknown to the vault', () => {
  const r = new Redactor();
  const out = r.redact('here: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and Bearer abcdefghijklmnopqrstuvwxyz012345');
  assert.ok(!out.includes('AAAAAAAAAAAAAAAA'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'));
});
