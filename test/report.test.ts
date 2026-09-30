// utc cutoffs, restarts, redaction and offline output use the real ledger and filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DailyReports, buildReport, utcDayStart } from '../src/core/report.ts';
import { EventLog } from '../src/core/eventlog.ts';
import { StateStore } from '../src/core/state.ts';
import { globalRedactor } from '../src/lib/redact.ts';
import { DAY } from '../src/lib/clock.ts';
import { ROOT_DIR } from '../src/lib/paths.ts';
import { fakeClock, tmpEnv } from './helpers.ts';

function setup() {
  const e = tmpEnv();
  const clock = fakeClock(Date.UTC(2026, 0, 1, 23, 59, 59));
  const store = new StateStore(new EventLog(e.paths.events, { clock: clock.fn }));
  store.append('genesis', { version: 'test' });
  store.append('model.set', { provider: 'openrouter', model: 'openrouter/free' });
  return { ...e, clock, store, reports: new DailyReports(e.paths, store, clock.fn) };
}

test('midnight UTC archives the closing day once and excludes events at the next day boundary', () => {
  const t = setup();
  t.store.append('capital.in', { usd: 1 });
  t.store.append('nav', { usd: 1.25 });
  t.store.append('llm.usage', { costUsd: 0.03, funding: 'capital', model: 'test' });
  t.store.append('trade', { venue: 'paper', market: 'test', side: 'buy', qty: 1, price: 1 });
  assert.equal(t.reports.generateDue(), undefined);
  assert.equal(t.reports.latest().complete, false);
  t.clock.advance(1000);
  t.store.append('nav', { usd: 99 });
  t.store.append('model.set', { provider: 'other', model: 'tomorrow' });
  const report = t.reports.generateDue()!;
  assert.equal(report.date, '2026-01-01');
  assert.equal(report.asOf, Date.UTC(2026, 0, 2));
  assert.match(report.text, /NAV: \$1\.25/);
  assert.match(report.text, /Lifetime P&L: \$0\.25/);
  assert.match(report.text, /Inference cost: \$0\.03\. Trades: 1/);
  assert.doesNotMatch(report.text, /tomorrow|\$99/);
  assert.ok(report.short.length <= 280);
  const archive = path.join(t.paths.home, 'reports', '2026-01-01.json');
  const before = fs.statSync(archive).mtimeMs;
  t.clock.advance(3_600_000);
  assert.deepEqual(new DailyReports(t.paths, t.store, t.clock.fn).latest(), report);
  assert.equal(fs.statSync(archive).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(t.paths.home, 'reports', 'latest.txt'), 'utf8'), report.text + '\n');
});

test('sleep recovery reports the last complete UTC day and never invents activity for missed days', () => {
  const t = setup();
  t.store.append('nav', { usd: 1 });
  t.clock.advance(3 * DAY);
  t.store.append('nav', { usd: 50 });
  const report = t.reports.latest();
  assert.equal(report.date, '2026-01-03');
  assert.match(report.text, /NAV: \$1\.00/);
  assert.match(report.text, /No new developments recorded/);
  assert.equal(t.reports.latest(true).date, '2026-01-04');
  // an event stamped exactly at the current cutoff belongs to the next snapshot.
  t.clock.advance(1);
  assert.match(t.reports.latest(true).text, /NAV: \$50\.00/);
});

test('reports retain failed episodes, model changes and journal updates while redacting secrets', () => {
  const t = setup();
  globalRedactor.add('REPORT_TEST_SECRET', 'private-report-test-key');
  try {
    t.store.append('episode.start', { id: 'ep', reason: 'heartbeat' });
    t.store.append('episode.end', { id: 'ep', outcome: 'error', handoff: 'Retry tomorrow. private-report-test-key' });
    t.store.append('journal', { text: 'Measured fees before trading.' });
    t.store.append('inbox.item', { id: 'private', title: 'private inbox content', body: 'do not publish this', from: 'operator' });
    t.store.append('selfmod.promote', { sha: 'abc' });
    t.clock.advance(1000);
    const report = t.reports.latest();
    assert.match(report.text, /1 \(1 failed\)/);
    assert.match(report.text, /Measured fees before trading/);
    assert.match(report.text, /Harness releases promoted: 1/);
    assert.doesNotMatch(JSON.stringify(report), /private-report-test-key|private inbox content|do not publish/);
    assert.match(report.text, /REPORT_TEST_SECRET/);
  } finally {
    globalRedactor.setSecrets([]);
  }
});

test('daily counts use the full ledger even when in-memory episode history is capped', () => {
  const t = setup();
  for (let i = 0; i < 510; i++) t.store.append('episode.end', { id: String(i), outcome: 'completed' });
  t.clock.advance(1000);
  assert.match(t.reports.latest().text, /Episodes finished: 510/);
});

test('a first-day report distinguishes missing valuations from a zero-dollar balance', () => {
  const t = setup();
  t.clock.advance(1);
  const report = t.reports.latest();
  assert.equal(report.complete, false);
  assert.match(report.text, /NAV: not yet valued/);
  assert.match(report.text, /Lifetime P&L: unavailable/);
});

test('report command works offline as plain text, compact text and JSON', () => {
  const t = setup();
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT_DIR, 'src/cli/main.ts'), 'report', ...args], { env: t.env, encoding: 'utf8', timeout: 10_000 });
  const full = run();
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /Ouroboros \|/);
  const short = run('--short');
  assert.equal(short.status, 0, short.stderr);
  assert.ok(short.stdout.trim().length <= 280);
  const json = run('--json', '--now');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).complete, false);
});

test('utc boundaries stay fixed across daylight saving changes', () => {
  assert.equal(utcDayStart(Date.parse('2026-11-01T01:30:00-07:00')), Date.UTC(2026, 10, 1));
  assert.equal(utcDayStart(Date.parse('2026-11-01T01:30:00-08:00')), Date.UTC(2026, 10, 1));
  assert.equal(buildReport([], 0, DAY, DAY, true).asOf, DAY);
});

test('the background timer generates at midnight even while the agent is paused', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup();
  t.store.append('control', { action: 'pause' });
  const errors: unknown[] = [];
  t.reports.start((e) => errors.push(e));
  try {
    t.clock.advance(1000);
    context.mock.timers.tick(1000);
    assert.ok(fs.existsSync(path.join(t.paths.home, 'reports', '2026-01-01.json')));
    assert.match(t.reports.latest().text, /Status at cutoff: paused/);
    assert.deepEqual(errors, []);
  } finally {
    t.reports.close();
  }
});
