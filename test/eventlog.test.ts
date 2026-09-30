import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventLog } from '../src/core/eventlog.ts';
import { tmpDir, fakeClock } from './helpers.ts';

function mk() {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  const clock = fakeClock();
  return { file, log: new EventLog(file, { clock: clock.fn }), clock };
}

test('append assigns contiguous sequence numbers and a valid hash chain', () => {
  const { log } = mk();
  for (let i = 0; i < 5; i++) log.append('note', { i });
  const all = log.readAll();
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(all[1].prev, all[0].hash);
  const v = log.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 5);
  assert.equal(v.headHash, all[4].hash);
});

test('editing a past event is detected', () => {
  const { log, file } = mk();
  log.append('capital.in', { usd: 1 });
  log.append('capital.in', { usd: 2 });
  log.append('note', { x: 1 });
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = lines[0].replace('"usd":1', '"usd":1000');
  fs.writeFileSync(file, lines.join('\n'));
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.equal(v.error?.seq, 1);
  assert.match(v.error!.reason, /hash mismatch/);
});

test('deleting an event is detected', () => {
  const { log, file } = mk();
  for (let i = 0; i < 4; i++) log.append('note', { i });
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.match(v.error!.reason, /sequence gap/);
});

test('a torn trailing line is repaired on the next append and never fails verification', () => {
  const { log, file } = mk();
  log.append('note', { a: 1 });
  fs.appendFileSync(file, '{"seq":2,"ts":1,"type":"no'); // crash mid-write
  assert.equal(log.verify().ok, true);
  assert.equal(log.readAll().length, 1);
  const ev = log.append('note', { a: 2 });
  assert.equal(ev.seq, 2);
  assert.equal(log.verify().ok, true);
  assert.equal(log.readAll().length, 2);
});

test('readFrom follows appends made after a given offset', () => {
  const { log } = mk();
  log.append('note', { n: 1 });
  const first = log.readFrom(0);
  assert.equal(first.events.length, 1);
  log.append('note', { n: 2 });
  log.append('note', { n: 3 });
  const second = log.readFrom(first.offset);
  assert.deepEqual(second.events.map((e) => e.data.n), [2, 3]);
  assert.equal(log.readFrom(second.offset).events.length, 0);
});

test('concurrent writers in separate processes keep one contiguous verified chain', async () => {
  const { log, file } = mk();
  const modulePath = path.resolve(import.meta.dirname, '../src/core/eventlog.ts');
  const script = `
    import { EventLog } from ${JSON.stringify(modulePath)};
    const log = new EventLog(${JSON.stringify(file)});
    for (let i = 0; i < 40; i++) log.append('note', { pid: process.pid, i });
  `;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited ${c}`))));
      }),
    ),
  );
  const v = log.verify();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.count, 160);
});
