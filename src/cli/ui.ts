import readline from 'node:readline';

// colour only on a real terminal, and never when NO_COLOR is set
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = (s: string) => c(1, s);
export const dim = (s: string) => c(2, s);
export const red = (s: string) => c(31, s);
export const green = (s: string) => c(32, s);
export const yellow = (s: string) => c(33, s);
export const cyan = (s: string) => c(36, s);

export function die(msg: string, code = 1): never {
  process.stderr.write(`${red('error:')} ${msg}\n`);
  process.exit(code);
}

export const ok = (s: string) => `${green('ok')}    ${s}`;
export const warn = (s: string) => `${yellow('warn')}  ${s}`;
export const fail = (s: string) => `${red('FAIL')}  ${s}`;

export function ask(question: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise((resolve) => {
    rl.question(`${question}${def ? dim(` [${def}]`) : ''} `, (a) => {
      rl.close();
      resolve(a.trim() || def || '');
    });
  });
}

export async function confirm(question: string, def = false): Promise<boolean> {
  const a = (await ask(`${question} ${dim(def ? '(Y/n)' : '(y/N)')}`)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
}

/** read a secret without echoing it. from a pipe, reads one line. */
// read a secret without echoing it. from a pipe, read one line.
export function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => resolve(buf.split('\n')[0].trim()));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(`${question} ${dim('(input hidden)')} `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => stripAnsi(r[i] ?? '').length)));
  const line = (r: string[]) => r.map((cell, i) => (cell ?? '') + ' '.repeat(Math.max(0, widths[i] - stripAnsi(cell ?? '').length))).join('  ').trimEnd();
  const out = all.map(line);
  if (headers) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return out.join('\n');
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** minimal flag parser: --name value, --flag, -f. positionals are returned separately. */
// minimal flag parser: --name value, --name=value and --flag (for the names listed as booleans)
export function parseArgs(argv: string[], booleans: string[] = []): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (booleans.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('-')) flags[k] = true;
      else flags[k] = argv[++i];
    } else if (a.startsWith('-') && a.length === 2 && !/^-\d/.test(a)) {
      flags[a.slice(1)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
