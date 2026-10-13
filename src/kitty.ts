/**
 * Minimal kitty graphics protocol helpers.
 * Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Transfer = 'direct' | 'file';

const CHUNK = 4096;
let tmpCounter = 0;

export function gfx(control: string, payload = ''): string {
  return `\x1b_G${control}${payload ? ';' + payload : ''}\x1b\\`;
}

/**
 * Temp file the terminal reads (and deletes) itself. Kitty only deletes files in
 * a temp dir whose name contains "tty-graphics-protocol".
 */
export function tempImagePath(): string {
  return path.join(os.tmpdir(), `stamper-tty-graphics-protocol-${process.pid}-${tmpCounter++}.png`);
}

/**
 * Transmit a PNG (base64) and place it at the cursor, scaled to cols x rows cells,
 * without moving the cursor. `cropHeight` shows only the top that many pixels.
 */
export function transmitPng(
  id: number,
  pngBase64: string,
  cols: number,
  rows: number,
  transfer: Transfer,
  cropHeight?: number,
): string {
  const crop = cropHeight ? `,h=${cropHeight}` : '';
  const ctrl = `a=T,f=100,i=${id},c=${cols},r=${rows}${crop},C=1,q=2`;
  if (transfer === 'file') {
    const file = tempImagePath();
    fs.writeFileSync(file, Buffer.from(pngBase64, 'base64'));
    // The terminal normally deletes it; this is a backstop.
    setTimeout(() => fs.rm(file, { force: true }, () => {}), 10_000).unref();
    return gfx(`${ctrl},t=t`, Buffer.from(file).toString('base64'));
  }
  if (pngBase64.length <= CHUNK) return gfx(ctrl, pngBase64);
  let out = '';
  for (let i = 0; i < pngBase64.length; i += CHUNK) {
    const chunk = pngBase64.slice(i, i + CHUNK);
    const more = i + CHUNK < pngBase64.length ? 1 : 0;
    out += i === 0 ? gfx(`${ctrl},m=1`, chunk) : gfx(`m=${more},q=2`, chunk);
  }
  return out;
}

/** Width/height from a base64 PNG's IHDR chunk. */
export function pngSize(b64: string): [number, number] | undefined {
  const b = Buffer.from(b64.slice(0, 32), 'base64');
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return undefined; // "IHDR"
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** Delete an image's placements and free its data. */
export function deleteImage(id: number): string {
  return gfx(`a=d,d=I,i=${id},q=2`);
}

export function deleteAllImages(): string {
  return gfx('a=d,d=A,q=2');
}

/** Queries used to detect protocol support (direct) and temp-file support. */
export const PROBE_DIRECT_ID = 31337;
export const PROBE_FILE_ID = 31338;

export function probeQueries(): { seq: string; cleanup: () => void } {
  const direct = gfx(`a=q,i=${PROBE_DIRECT_ID},s=1,v=1,t=d,f=24`, 'AAAA');
  const file = path.join(os.tmpdir(), `stamper-tty-graphics-protocol-probe-${process.pid}.rgb`);
  let fileQuery = '';
  try {
    fs.writeFileSync(file, Buffer.from([0, 0, 0]));
    fileQuery = gfx(`a=q,i=${PROBE_FILE_ID},s=1,v=1,t=t,f=24`, Buffer.from(file).toString('base64'));
  } catch {
    // no temp dir; direct transfer only
  }
  return { seq: direct + fileQuery, cleanup: () => fs.rm(file, { force: true }, () => {}) };
}
