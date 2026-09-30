// Human-readable formatting shared by the CLI and the agent's tools.

export const usd = (n: unknown): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  const s = a >= 1000 ? a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(4) : a === 0 ? '0.00' : a.toFixed(6);
  return `${n < 0 ? '-' : ''}$${s}`;
};

export const pct = (n: unknown, digits = 2): string => (typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : 'n/a');

export const ago = (now: number, ts?: number): string => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export function formatStatus(s: any): string {
  const m = s.metrics;
  const L: string[] = [];
  L.push(`NAV ${usd(m.navUsd)} · contributed ${usd(m.netContributedUsd)} · P&L ${m.pnlUsd >= 0 ? '+' : ''}${usd(m.pnlUsd)} (${pct(m.pnlPct)}) · after operator subsidy ${usd(m.pnlAfterSubsidyUsd)}`);
  const g = m.growth ?? {};
  L.push(`Growth/day (log, deposits removed): 1d ${pct(g.d1)} · 7d ${pct(g.d7)} · 30d ${pct(g.d30)} · all ${pct(g.all)}${m.doublingDays ? ` · doubling ≈ ${m.doublingDays.toFixed(1)}d` : ''}`);
  L.push(`Drawdown now ${pct(m.drawdown)} (max ${pct(m.maxDrawdown)}) · burn ${usd(m.burnPerDayUsd)}/day`);
  if (s.budget) {
    const b = s.budget;
    L.push(`Inference budget (${b.mode}): today ${usd(b.spentTodayUsd)} / ${usd(b.dailyLimitUsd)}; this episode ≤ ${usd(s.episodeBudgetUsd)}${b.exhausted ? ` — EXHAUSTED: ${b.reason}` : ''}`);
  }
  if (s.venues) {
    L.push(`Venues (${s.venues.length}):`);
    for (const v of s.venues) L.push(`  - ${v.id}${v.strategy ? ` [${v.strategy}]` : ''}: ${usd(v.totalUsd)} (${ago(s.now, v.at)})${v.error ? ` ERROR: ${v.error}` : ''}${v.guard?.maxDrawdownPct ? ` guard ${pct(v.guard.maxDrawdownPct, 0)}` : ''}`);
    if (!s.venues.length) L.push('  (none registered)');
  }
  if (s.strategies) L.push(`Strategies (${s.strategies.length}): ${s.strategies.map((x: any) => `${x.name}=${x.status}`).join(', ') || 'none'}`);
  if (s.inbox) L.push(`Inbox: ${s.inbox.open} open, ${s.inbox.unseenForAgent} unseen by the agent · open incidents: ${s.incidents}`);
  if (m.unclassifiedUsd > 0) L.push(`UNCLASSIFIED inflows: ${usd(m.unclassifiedUsd)} (excluded from P&L)`);
  if (m.unpricedAssets?.length) L.push(`Unpriced assets excluded from NAV: ${m.unpricedAssets.join(', ')}`);
  if (s.release) {
    const r = s.release;
    L.push(`Release: running ${r.running?.slice(0, 10) ?? 'unmanaged'}, lkg ${r.lkg?.slice(0, 10) ?? 'n/a'}${r.promotion && ['pending', 'probation'].includes(r.promotion.state) ? `, PROBATION until ${new Date(r.promotion.probationUntil ?? 0).toISOString()}` : ''}`);
  }
  if (s.charter) L.push(`Charter: ${s.charter.state} · control: ${s.control?.halted ? 'HALTED' : s.control?.paused ? 'PAUSED' : 'running'}${s.uptimeSec !== undefined ? ` · uptime ${s.uptimeSec}s` : ''}`);
  if (s.scheduler?.blockedReason) L.push(`Agent cannot start an episode: ${s.scheduler.blockedReason}`);
  if (s.runner?.running) L.push(`Episode ${s.runner.current.id} is running (${Math.round((s.now - s.runner.current.startedAt) / 1000)}s).`);
  return L.join('\n');
}
