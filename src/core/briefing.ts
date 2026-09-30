// The briefing is the first message of every episode: a compact, factual picture
// of the world built from the independent ledger, so the agent starts from truth
// instead of from its own recollection.

import { fmtDuration, iso } from '../lib/clock.ts';
import type { OuroConfig } from '../lib/config.ts';
import { fmtPct, fmtUsd } from '../lib/money.ts';
import type { BudgetStatus } from './meter.ts';
import type { Metrics, State } from './state.ts';

export type TriggerKind = 'genesis' | 'heartbeat' | 'operator' | 'incident' | 'timer' | 'strategy' | 'selfmod' | 'manual' | 'resume' | 'budget';

export interface Trigger {
  kind: TriggerKind;
  detail?: string;
  ts: number;
}

export interface StrategySummary {
  name: string;
  status: string;
  pid?: number;
  restarts: number;
  startedAt?: number;
  lastExit?: string;
}

export interface BriefingInput {
  now: number;
  episodeId: string;
  episodeNumber: number;
  triggers: Trigger[];
  state: State;
  metrics: Metrics;
  budget: BudgetStatus;
  episodeBudgetUsd: number;
  cfg: OuroConfig;
  strategies: StrategySummary[];
  charterNote?: string;
  release: { sha?: string };
  genesisPath?: string;
  handoff?: string;
  model: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const ago = (now: number, ts: number) => `${fmtDuration(now - ts)} ago`;
const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%/day`);

export function buildBriefing(i: BriefingInput): string {
  const { state, metrics: m, budget: b, now, cfg } = i;
  const L: string[] = [];
  const primary = i.triggers[0];

  L.push(`# Episode ${i.episodeNumber} (${i.episodeId}) — ${primary?.kind ?? 'manual'}`);
  L.push(`Time: ${iso(now)} · operator timezone ${cfg.operator.timezone} · model ${i.model}`);
  const last = state.episodes.at(-1);
  L.push(`Previous episode: ${last ? `${last.outcome ?? 'unknown'}, ended ${last.endedAt ? ago(now, last.endedAt) : 'n/a'}, cost ${fmtUsd(last.costUsd)}` : 'none (this is the first)'}`);
  L.push('');

  L.push('## Why you were woken');
  for (const t of i.triggers.slice(0, 12)) L.push(`- ${t.kind}${t.detail ? `: ${clip(t.detail, 300)}` : ''} (${ago(now, t.ts)})`);
  L.push('');

  L.push('## Money (independent ledger — it outranks your memory)');
  L.push(`NAV ${fmtUsd(m.navUsd)} · contributed ${fmtUsd(m.netContributedUsd)} · P&L ${m.pnlUsd >= 0 ? '+' : ''}${fmtUsd(m.pnlUsd)}${m.pnlPct !== null ? ` (${fmtPct(m.pnlPct)})` : ''} · after operator subsidy ${fmtUsd(m.pnlAfterSubsidyUsd)}`);
  L.push(`Growth (log, flow-adjusted): 1d ${pct(m.growth.d1)} · 7d ${pct(m.growth.d7)} · 30d ${pct(m.growth.d30)} · all ${pct(m.growth.all)}${m.doublingDays ? ` · doubling ≈ ${m.doublingDays.toFixed(1)}d` : ''}`);
  L.push(`Drawdown: now ${fmtPct(m.drawdown)}, max ${fmtPct(m.maxDrawdown)} · burn ≈ ${fmtUsd(m.burnPerDayUsd)}/day${m.runwayDays !== undefined ? ` · runway ${m.runwayDays.toFixed(0)}d` : ''}`);
  const venues = state.liveVenues();
  if (venues.length) {
    L.push('Venues:');
    for (const v of venues.slice(0, 20)) {
      const top = (v.latest?.holdings ?? [])
        .filter((h) => h.valueUsd > 0)
        .sort((a, b2) => b2.valueUsd - a.valueUsd)
        .slice(0, 4)
        .map((h) => `${h.asset} ${fmtUsd(h.valueUsd)}`)
        .join(', ');
      L.push(`- ${v.id}${v.strategy ? ` [strategy ${v.strategy}]` : ''}: ${v.latest ? fmtUsd(v.latest.totalUsd) : 'never reconciled'}${top ? ` (${top})` : ''}${v.latest ? `, ${ago(now, v.latest.ts)}` : ''}${v.lastError ? ` ⚠ last error: ${clip(v.lastError.message, 120)}` : ''}`);
    }
  } else {
    L.push('Venues: none registered yet — you hold no reconciled capital. Register one (venue_register) once funds exist.');
  }
  if (m.unclassifiedUsd > 0) L.push(`⚠ ${fmtUsd(m.unclassifiedUsd)} of inflows are unclassified (excluded from P&L).`);
  if (m.unpricedAssets.length) L.push(`⚠ Unpriced assets excluded from NAV: ${m.unpricedAssets.join(', ')}`);
  L.push('');

  L.push('## Inference budget');
  L.push(`Mode ${b.mode}. Today ${fmtUsd(b.spentTodayUsd)} of ${fmtUsd(b.dailyLimitUsd)}. This episode may spend at most ${fmtUsd(i.episodeBudgetUsd)}. Lifetime ${b.mode} spend ${fmtUsd(b.spentTotalUsd)}${b.totalLimitUsd !== null ? ` of ${fmtUsd(b.totalLimitUsd)}` : ''}.`);
  L.push('Every token you think is paid for by someone. Prefer cheap checks, encode routines as code, and end the episode when there is nothing worth doing.');
  L.push('');

  const incidents = state.openIncidents();
  L.push(`## Open incidents (${incidents.length})`);
  for (const inc of incidents.slice(0, 10)) L.push(`- [${inc.severity}] ${inc.id} ${inc.kind}: ${clip(inc.message, 400)}`);
  if (!incidents.length) L.push('none');
  L.push('');

  const unseen = state.unseenForAgent();
  const openReq = state.openInbox().filter((x) => x.from !== 'operator');
  L.push('## Inbox');
  if (unseen.length) {
    L.push('Unseen messages from your operator (read; they outrank your plans; acknowledge with inbox_ack):');
    for (const it of unseen.slice(0, 8)) {
      const replies = it.replies.filter((r) => r.by === 'operator' && r.ts > (it.ackedAt ?? 0));
      const text = it.from === 'operator' && !it.replies.length ? it.body : replies.map((r) => `${r.text} [via ${r.channel ?? 'cli'}]`).join(' | ');
      L.push(`- #${it.id} ${clip(it.title, 80)}: ${clip(text || it.body, 1500)}`);
    }
  } else L.push('No unseen operator messages.');
  if (openReq.length) {
    L.push('Your open requests to the operator:');
    for (const it of openReq.slice(0, 8)) L.push(`- #${it.id} [${it.status}] ${clip(it.title, 100)} (${ago(now, it.ts)})${it.blocking ? ` — blocking: ${clip(it.blocking, 100)}` : ''}`);
  }
  L.push('');

  L.push(`## Strategies (${i.strategies.length})`);
  for (const s of i.strategies.slice(0, 15)) L.push(`- ${s.name}: ${s.status}${s.pid ? ` pid ${s.pid}` : ''}, restarts ${s.restarts}${s.startedAt ? `, up ${fmtDuration(now - s.startedAt)}` : ''}${s.lastExit ? `, last exit ${s.lastExit}` : ''}`);
  if (!i.strategies.length) L.push('none running');
  L.push('');

  if (i.handoff) {
    L.push('## Handoff from your previous episode');
    L.push(clip(i.handoff, 4000));
    L.push('');
  }

  const wakes = state.pendingWakes();
  if (wakes.length) {
    L.push('## Scheduled wake-ups');
    for (const w of wakes.slice(0, 6)) L.push(`- ${iso(w.at)} (${w.at > now ? `in ${fmtDuration(w.at - now)}` : 'due'}): ${clip(w.reason, 120)}`);
    L.push('');
  }

  const lessons = state.journal.filter((j) => ['lesson', 'mistake', 'decision'].includes(j.kind)).slice(-8);
  if (lessons.length) {
    L.push('## Recent lessons and decisions from your journal');
    for (const j of lessons) L.push(`- [${j.kind}] ${clip(j.text, 300)}`);
    L.push('');
  }

  const sm = state.selfmod;
  L.push('## Harness');
  L.push(`Running release ${i.release.sha?.slice(0, 10) ?? 'unknown'}${sm.probation ? ` — on probation until ${iso(sm.probation.until)} (a crash loop rolls it back)` : ''}. Last known good: ${sm.lkg?.slice(0, 10) ?? 'unknown'}.${sm.bad.length ? ` Rejected releases: ${sm.bad.slice(-3).map((s) => s.slice(0, 10)).join(', ')}.` : ''}`);
  const lastRb = [...sm.history].reverse().find((h) => h.kind === 'rollback' && now - h.ts < 86_400_000);
  if (lastRb) L.push(`⚠ A change was rolled back ${ago(now, lastRb.ts)}: ${clip(lastRb.reason ?? '', 300)}`);
  if (i.charterNote) L.push(`⚠ Charter: ${i.charterNote}`);
  L.push('');

  L.push('## Your task');
  if (primary?.kind === 'genesis') {
    L.push(`This is your first episode. Read ${i.genesisPath ?? 'memory/GENESIS.md'} and carry it out. Take your time to understand your environment, then set yourself up.`);
  } else if (primary?.kind === 'operator') {
    L.push('Your operator wrote to you. Read their message(s) first and respond through the inbox; then continue your work.');
  } else if (primary?.kind === 'incident') {
    L.push('An incident woke you. Diagnose it from the ledger and logs, decide what to do, resolve it (incident_resolve) or escalate it, and record the lesson.');
  } else {
    L.push('Review the situation, decide what has the highest expected value for capital growth right now, do it, and record what you learned.');
  }
  L.push('Work autonomously. When you are finished (or there is nothing worth doing), call `episode_end` with a handoff note for your next self and when you want to be woken.');
  return L.join('\n');
}
