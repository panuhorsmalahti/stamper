/**
 * The outer terminal: raw mode, screen setup/teardown and capability probing.
 */
import { InputParser, type InputEvent } from './input.js';
import { deleteAllImages, probeQueries, PROBE_DIRECT_ID, PROBE_FILE_ID } from './kitty.js';

export interface TermCaps {
  /** Cell size in device pixels, if the terminal reported it. */
  cellW?: number;
  cellH?: number;
  /** undefined = the terminal didn't answer at all. */
  graphics?: boolean;
  fileTransfer: boolean;
  /** Background color, 0-255 per channel. */
  background?: [number, number, number];
}

const ENTER =
  '\x1b[?1049h' + // alternate screen
  '\x1b[?25l' + // hide cursor
  '\x1b[?7l' + // no autowrap: a stray write must never scroll the image away
  '\x1b[?1003h\x1b[?1006h' + // any-motion mouse tracking, SGR encoding
  '\x1b[?2004h' + // bracketed paste
  '\x1b[2J';

/**
 * iTerm2's OSC 22 only knows X11 cursor names and falls back to its default
 * pointer for anything else; kitty and Ghostty take CSS names.
 */
const ITERM2 = process.env.TERM_PROGRAM === 'iTerm.app' || process.env.LC_TERMINAL === 'iTerm2';

const X11_POINTERS: Record<string, string> = {
  default: 'left_ptr',
  pointer: 'hand2',
  text: 'xterm',
  'vertical-text': 'xterm',
  crosshair: 'crosshair',
  cell: 'crosshair',
  'not-allowed': 'X_cursor',
  'no-drop': 'X_cursor',
  grab: 'fleur',
  grabbing: 'fleur',
  move: 'fleur',
  'all-scroll': 'fleur',
  'row-resize': 'sb_v_double_arrow',
  'ns-resize': 'sb_v_double_arrow',
  'n-resize': 'sb_up_arrow',
  's-resize': 'based_arrow_down',
  'col-resize': 'sb_h_double_arrow',
  'ew-resize': 'sb_h_double_arrow',
  'e-resize': 'right_side',
  'w-resize': 'left_side',
  'zoom-in': 'plus',
  'zoom-out': 'minus',
  wait: 'watch',
  progress: 'watch',
};

/** OSC 22 for a CSS cursor name, translated for terminals that need it. */
export function pointerShape(css: string): string {
  return `\x1b]22;${ITERM2 ? (X11_POINTERS[css] ?? 'left_ptr') : css}\x1b\\`;
}

// kitty and iTerm2 reset the pointer on an empty OSC 22; Ghostty needs a name.
const POINTER_RESET = process.env.KITTY_WINDOW_ID || ITERM2 ? '\x1b]22;\x1b\\' : pointerShape('text');

const LEAVE =
  POINTER_RESET +
  deleteAllImages() +
  '\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l' +
  '\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l';

export class Tty {
  readonly parser: InputParser;
  private handlers = new Set<(e: InputEvent) => void>();
  private entered = false;

  constructor() {
    this.parser = new InputParser((e) => this.handlers.forEach((h) => h(e)));
  }

  get cols(): number {
    return process.stdout.columns || 80;
  }

  get rows(): number {
    return process.stdout.rows || 24;
  }

  start(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => this.parser.feed(d));
    process.stdin.resume();
  }

  on(handler: (e: InputEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  write(s: string): void {
    if (s) process.stdout.write(s);
  }

  enter(): void {
    this.entered = true;
    this.write(ENTER);
  }

  /** Synchronous so it is safe to call from process 'exit'. */
  restore(): void {
    if (this.entered) {
      this.entered = false;
      try {
        process.stdout.write(LEAVE);
      } catch {
        // stdout is gone
      }
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    process.stdin.pause();
  }

  /**
   * Ask for cell size, background color and kitty graphics support. DA1 is sent
   * last; every terminal answers it, so its reply marks the end of the probe.
   */
  probe(timeoutMs = 1500): Promise<TermCaps> {
    const caps: TermCaps = { fileTransfer: false };
    let winPx: [number, number] | undefined;
    const queries = probeQueries();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        off();
        queries.cleanup();
        if (!caps.cellW && winPx) {
          caps.cellH = winPx[0] / this.rows;
          caps.cellW = winPx[1] / this.cols;
        }
        resolve(caps);
      };
      const timer = setTimeout(finish, timeoutMs);
      const off = this.on((e) => {
        if (e.type !== 'reply') return;
        const updated = applyReply(caps, e.seq);
        if (updated === 'window') winPx = parseWindowPx(e.seq);
        if (updated === 'da1') {
          if (caps.graphics === undefined) caps.graphics = false;
          finish();
        }
      });
      this.write('\x1b[16t' + '\x1b[14t' + '\x1b]11;?\x1b\\' + queries.seq + '\x1b[c');
    });
  }
}

/** Updates caps from one reply; returns what kind of reply it was. */
export function applyReply(caps: TermCaps, seq: string): 'cell' | 'window' | 'graphics' | 'bg' | 'da1' | undefined {
  let m: RegExpMatchArray | null;
  if ((m = seq.match(/^\x1b\[6;(\d+);(\d+)t$/))) {
    const h = Number(m[1]);
    const w = Number(m[2]);
    if (h > 0 && w > 0) {
      caps.cellH = h;
      caps.cellW = w;
    }
    return 'cell';
  }
  if (/^\x1b\[4;\d+;\d+t$/.test(seq)) return 'window';
  if ((m = seq.match(/^\x1b_Gi=(\d+)[^;]*;(.*)\x1b\\$/))) {
    const id = Number(m[1]);
    if (id === PROBE_DIRECT_ID) caps.graphics = true;
    if (id === PROBE_FILE_ID) caps.fileTransfer = m[2] === 'OK';
    return 'graphics';
  }
  if ((m = seq.match(/^\x1b\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i))) {
    const ch = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
    caps.background = [ch(m[1]!), ch(m[2]!), ch(m[3]!)];
    return 'bg';
  }
  if (/^\x1b\[\?[\d;]*c$/.test(seq)) return 'da1';
  return undefined;
}

function parseWindowPx(seq: string): [number, number] | undefined {
  const m = seq.match(/^\x1b\[4;(\d+);(\d+)t$/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const w = Number(m[2]);
  return h > 0 && w > 0 ? [h, w] : undefined;
}

export function isDark([r, g, b]: [number, number, number]): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
