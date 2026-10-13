import fs from 'node:fs';

/** Appends to the file named by STAMPER_DEBUG, if set. */
export function debug(...args: unknown[]): void {
  const file = process.env.STAMPER_DEBUG;
  if (!file) return;
  const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`);
}
