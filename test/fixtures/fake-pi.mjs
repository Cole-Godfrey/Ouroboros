// a stand-in for `pi --mode rpc` that speaks the same JSONL protocol, driven by
// FAKE_PI_SCRIPT (JSON). used to test the runner without a model or network.
//
// script = {
//   events: [ { type, ..., delayMs? } ],   // emitted after a prompt is accepted
//   ignoreAbort: bool,                     // never settle after abort
//   crashAfterMs: number,                  // exit(3) this long after the prompt
//   hang: bool,                            // never emit anything after the prompt
// }
import fs from 'node:fs';
const script = JSON.parse(process.env.FAKE_PI_SCRIPT || '{}');
const log = process.env.FAKE_PI_LOG;
const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let aborted = false;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function play() {
  if (script.hang) return;
  if (script.crashAfterMs !== undefined) setTimeout(() => process.exit(3), script.crashAfterMs);
  write({ type: 'agent_start' });
  for (const ev of script.events ?? []) {
    if (aborted && !script.ignoreAbort) break;
    if (ev.delayMs) await new Promise((r) => setTimeout(r, ev.delayMs));
    if (aborted && !script.ignoreAbort) break;
    const { delayMs, ...rest } = ev;
    write(rest);
  }
  if (script.ignoreAbort && aborted) await new Promise(() => setInterval(() => {}, 1000));
  write({ type: 'agent_end', messages: [], willRetry: false });
  write({ type: 'agent_settled' });
}

function handle(cmd) {
  if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cmd, env: { OURO_EPISODE: process.env.OURO_EPISODE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OURO_LLM_PROXY_URL: process.env.OURO_LLM_PROXY_URL } }) + '\n');
  const ok = (data) => write({ id: cmd.id, type: 'response', command: cmd.type, success: true, data });
  switch (cmd.type) {
    case 'get_state': return ok({ isStreaming: false, messageCount: 0 });
    case 'prompt': ok({ disposition: 'started' }); return void play();
    case 'abort': aborted = true; return ok(undefined);
    case 'get_session_stats': return ok({ cost: script.statsCost ?? 0, tokens: { total: 0 } });
    default: return ok(undefined);
  }
}
