// The Charter is the operator's short list of non-negotiables (agent/CHARTER.md).
// Its SHA-256 is "sealed" by the operator into a root-owned file at install time.
// Every episode start compares the two. This is a tripwire, not a wall: the agent
// has root in its VM, so a change is not impossible, but it can never be silent.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../lib/fsx.ts';
import { CHARTER_FILE, type Paths } from '../lib/paths.ts';

export function charterFile(root: string): string {
  return path.join(root, CHARTER_FILE);
}

/** Hash of the charter with line endings normalised so git checkout settings cannot change it. */
export function charterSha(root: string): string | undefined {
  try {
    const text = fs.readFileSync(charterFile(root), 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(text).digest('hex');
  } catch {
    return undefined;
  }
}

export interface CharterStatus {
  ok: boolean;
  state: 'sealed-ok' | 'unsealed' | 'mismatch' | 'missing';
  sha?: string;
  sealed?: string;
  message: string;
}

export function readSeal(paths: Pick<Paths, 'charterSeal'>): string | undefined {
  try {
    const s = fs.readFileSync(paths.charterSeal, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function checkCharter(paths: Pick<Paths, 'charterSeal'>, root: string): CharterStatus {
  const sha = charterSha(root);
  if (!sha) return { ok: false, state: 'missing', message: `charter file not found at ${charterFile(root)}` };
  const sealed = readSeal(paths);
  if (!sealed) return { ok: true, state: 'unsealed', sha, message: 'charter has not been sealed (run `ouro init` or `ouro charter seal`)' };
  if (sealed !== sha) return { ok: false, state: 'mismatch', sha, sealed, message: `charter hash ${sha.slice(0, 12)} does not match the sealed hash ${sealed.slice(0, 12)}` };
  return { ok: true, state: 'sealed-ok', sha, sealed, message: 'charter matches its seal' };
}

/** Write the seal. Needs write access to the seal path (root, for /etc/ouroboros). */
export function sealCharter(paths: Pick<Paths, 'charterSeal'>, root: string): string {
  const sha = charterSha(root);
  if (!sha) throw new Error('charter file missing');
  ensureDir(path.dirname(paths.charterSeal));
  fs.writeFileSync(paths.charterSeal, sha + '\n', { mode: 0o644 });
  return sha;
}
