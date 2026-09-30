// Money helpers. Amounts are plain numbers in USD, rounded to micro-dollars at
// the edges so accumulated floating point error cannot creep into the books.

export function roundUsd(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  if (a >= 1000) return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(4)}`;
  return `${sign}$${a.toFixed(6)}`;
}

export function fmtPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(digits)}%`;
}

/** Parse "$1.50", "1,5", "1.5" style operator input. Throws on garbage. */
export function parseUsd(input: string): number {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${input}`);
  return roundUsd(n);
}
