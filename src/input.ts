/**
 * Splits raw terminal input into logical events: keys, SGR mouse reports,
 * bracketed pastes and replies to queries we sent (CSI t, DA1, OSC, APC...).
 */

export type InputEvent =
  | { type: 'key'; seq: string }
  | { type: 'mouse'; code: number; col: number; row: number; release: boolean }
  | { type: 'paste'; text: string }
  | { type: 'reply'; seq: string };

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class InputParser {
  private buf = '';
  private pasting = false;
  private pasteBuf = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly emit: (e: InputEvent) => void,
    private readonly escTimeoutMs = 25,
  ) {}

  feed(data: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buf += data;
    this.drain(false);
    if (this.buf.length > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain(true);
      }, this.escTimeoutMs);
    }
  }

  private drain(flush: boolean): void {
    while (this.buf.length > 0) {
      if (this.pasting) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible partial terminator at the tail; pastes never time out.
          const keep = partialSuffix(this.buf, PASTE_END);
          this.pasteBuf += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        this.pasteBuf += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + PASTE_END.length);
        this.pasting = false;
        const text = this.pasteBuf;
        this.pasteBuf = '';
        this.emit({ type: 'paste', text });
        continue;
      }
      const used = this.next(flush);
      if (used === 0) return;
      this.buf = this.buf.slice(used);
    }
  }

  /** Consumes one event from the head of the buffer; returns 0 if incomplete. */
  private next(flush: boolean): number {
    const b = this.buf;
    if (b[0] !== ESC) {
      const cp = b.codePointAt(0)!;
      const len = cp > 0xffff ? 2 : 1;
      this.emit({ type: 'key', seq: b.slice(0, len) });
      return len;
    }
    if (b.length === 1) {
      if (!flush) return 0;
      this.emit({ type: 'key', seq: ESC });
      return 1;
    }
    const kind = b[1];
    if (kind === '[') return this.csi(flush);
    if (kind === ']' || kind === '_' || kind === 'P') return this.stringSeq(flush);
    if (kind === 'O') {
      if (b.length < 3) {
        if (!flush) return 0;
        this.emit({ type: 'key', seq: b.slice(0, 2) });
        return 2;
      }
      this.emit({ type: 'key', seq: b.slice(0, 3) });
      return 3;
    }
    if (kind === ESC) {
      this.emit({ type: 'key', seq: ESC });
      return 1;
    }
    // Alt+<char>
    const cp = b.codePointAt(1)!;
    const len = 1 + (cp > 0xffff ? 2 : 1);
    this.emit({ type: 'key', seq: b.slice(0, len) });
    return len;
  }

  private csi(flush: boolean): number {
    const b = this.buf;
    let i = 2;
    while (i < b.length) {
      const c = b.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) break;
      if (c < 0x20 || c > 0x7e) {
        // Malformed; surface what we have as a key and move on.
        this.emit({ type: 'key', seq: b.slice(0, i) });
        return i;
      }
      i++;
    }
    if (i >= b.length) {
      if (!flush) return 0;
      this.emit({ type: 'key', seq: b });
      return b.length;
    }
    const seq = b.slice(0, i + 1);
    const final = b[i];
    const params = b.slice(2, i);

    if (seq === PASTE_START) {
      this.pasting = true;
      return seq.length;
    }
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const [code, col, row] = params.slice(1).split(';').map(Number);
      this.emit({ type: 'mouse', code: code!, col: col!, row: row!, release: final === 'm' });
      return seq.length;
    }
    const isReply =
      (final === 'c' && params.startsWith('?')) || // DA1
      final === 't' || // window ops (pixel sizes)
      (final === 'y' && params.endsWith('$')) || // DECRPM
      (final === 'u' && params.startsWith('?')); // kitty keyboard flags
    this.emit({ type: isReply ? 'reply' : 'key', seq });
    return seq.length;
  }

  /** OSC / APC / DCS: terminated by ST (ESC \) or, for OSC, BEL. */
  private stringSeq(flush: boolean): number {
    const b = this.buf;
    for (let i = 2; i < b.length; i++) {
      if (b[i] === '\x07') {
        this.emit({ type: 'reply', seq: b.slice(0, i + 1) });
        return i + 1;
      }
      if (b[i] === ESC && b[i + 1] === '\\') {
        this.emit({ type: 'reply', seq: b.slice(0, i + 2) });
        return i + 2;
      }
    }
    if (!flush) return 0;
    this.emit({ type: 'reply', seq: b });
    return b.length;
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
function partialSuffix(s: string, token: string): number {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(token.slice(0, n))) return n;
  }
  return 0;
}

/** Decoded SGR mouse button code. */
export function decodeMouse(code: number) {
  return {
    button: code & 3, // 0 left, 1 middle, 2 right, 3 none
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
    motion: (code & 32) !== 0,
    wheel: (code & 64) !== 0,
  };
}
