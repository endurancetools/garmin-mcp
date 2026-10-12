import readline from 'node:readline/promises';

export const out = (s = ''): void => void process.stdout.write(`${s}\n`);
export const err = (s = ''): void => void process.stderr.write(`${s}\n`);

export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a line without echoing it (passwords). Falls back to plain input when stdin is not a TTY. */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return prompt(question);
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/** Plain text table for terminal previews. */
export function table(rows: readonly Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '(no rows)';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const widths = cols.map((c) => Math.min(40, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const fmt = (vals: string[]) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [fmt(cols), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => fmt(cols.map((c) => cell(r[c]))))].join('\n');
}
