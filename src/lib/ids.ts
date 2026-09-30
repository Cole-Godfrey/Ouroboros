import { randomBytes } from 'node:crypto';

/** Sortable-ish short id: base36 time + 4 random bytes. */
export function newId(prefix = ''): string {
  const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  return prefix ? `${prefix}_${id}` : id;
}

/** Short human-friendly counter-style id for inbox items: "a3f9". */
export function shortId(): string {
  return randomBytes(2).toString('hex');
}
