/**
 * A child program in a PTY, emulated by xterm.js (headless) and re-rendered into
 * a rectangular region of the outer terminal.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import * as pty from 'node-pty';
import type { IBufferCell } from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

export interface PaneEvents {
  update: [];
  exit: [code: number];
  /** Sequences the outer terminal should see verbatim (bell, OSC 52 clipboard). */
  passthrough: [string];
}

export interface PaneOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** 0-based screen row of the pane's first line. */
  top: number;
}

export class ClaudePane extends EventEmitter<PaneEvents> {
  readonly term: Terminal;
  private readonly proc: pty.IPty;
  private cols: number;
  private rows: number;
  private top: number;
  private prev: string[] = [];
  private cursorHidden = false;
  private sgrMouse = false;

  constructor(o: PaneOptions) {
    super();
    this.cols = o.cols;
    this.rows = o.rows;
    this.top = o.top;
    this.term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: 10_000, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
    this.trackModes();
    this.term.onData((d) => this.proc.write(d)); // replies to the child's queries
    this.term.onBell(() => this.emit('passthrough', '\x07'));
    this.term.parser.registerOscHandler(52, (data) => {
      this.emit('passthrough', `\x1b]52;${data}\x07`);
      return true;
    });

    ensureSpawnHelperExecutable();
    this.proc = pty.spawn(o.file, o.args, {
      name: 'xterm-256color',
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: o.env as Record<string, string>,
    });
    this.proc.onData((d) => this.term.write(d, () => this.emit('update')));
    this.proc.onExit(({ exitCode }) => this.emit('exit', exitCode));
  }

  /** Mode changes xterm.js doesn't expose publicly. Returning false keeps default handling. */
  private trackModes(): void {
    const decset = (on: boolean) => (params: (number | number[])[]) => {
      for (const p of params) {
        if (p === 25) this.cursorHidden = !on;
        if (p === 1006) this.sgrMouse = on;
      }
      return false;
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));
  }

  resize(cols: number, rows: number, top: number): void {
    this.cols = cols;
    this.rows = rows;
    this.top = top;
    this.term.resize(cols, rows);
    try {
      this.proc.resize(cols, rows);
    } catch {
      // child already exited
    }
    this.invalidate();
  }

  invalidate(): void {
    this.prev = [];
  }

  get pending(): boolean {
    return this.term.modes.synchronizedOutputMode;
  }

  get scrolledBack(): boolean {
    const b = this.term.buffer.active;
    return b.viewportY < b.baseY;
  }

  /** Keyboard input from the user. */
  input(seq: string): void {
    if (this.scrolledBack) {
      this.term.scrollToBottom();
      this.emit('update');
    }
    // Our outer terminal is in normal cursor-key mode; translate if the child wants SS3.
    if (this.term.modes.applicationCursorKeysMode) seq = seq.replace(/^\x1b\[([A-DHF])$/, '\x1bO$1');
    this.proc.write(seq);
  }

  paste(text: string): void {
    this.input(this.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
  }

  focus(focused: boolean): void {
    if (this.term.modes.sendFocusMode) this.proc.write(focused ? '\x1b[I' : '\x1b[O');
  }

  scroll(lines: number): void {
    this.term.scrollLines(lines);
    this.emit('update');
  }

  /**
   * Mouse event in pane-relative 1-based cells. Forwarded if the child asked for
   * mouse reporting; otherwise the wheel scrolls our scrollback.
   */
  mouse(code: number, col: number, row: number, release: boolean): void {
    const mode = this.term.modes.mouseTrackingMode;
    const wheel = (code & 64) !== 0;
    const motion = (code & 32) !== 0;
    if (mode === 'none') {
      if (wheel && (code & 3) < 2) this.scroll((code & 1) === 0 ? -3 : 3);
      return;
    }
    if (motion && mode !== 'any' && !(mode === 'drag' && (code & 3) !== 3)) return;
    if (this.sgrMouse) {
      this.proc.write(`\x1b[<${code};${col};${row}${release ? 'm' : 'M'}`);
    } else if (col < 223 && row < 223) {
      const b = release ? 3 | (code & ~3) : code;
      this.proc.write(`\x1b[M${String.fromCharCode(32 + b, 32 + col, 32 + row)}`);
    }
  }

  /** Escape sequences that bring the screen region up to date. */
  render(): string {
    const buf = this.term.buffer.active;
    const cell: IBufferCell = buf.getNullCell();
    let out = '';
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      let s = '';
      let attrs = '';
      if (line) {
        for (let x = 0; x < this.cols; x++) {
          const c = line.getCell(x, cell);
          if (!c) break;
          const w = c.getWidth();
          if (w === 0) continue; // trailing half of a wide char
          const a = c.isAttributeDefault() ? '' : sgr(c);
          if (a !== attrs) {
            s += `\x1b[0${a}m`;
            attrs = a;
          }
          const ch = c.getChars() || ' ';
          s += ch;
          // Re-sync the column after anything non-ASCII so a width disagreement
          // between xterm.js and the outer terminal can't shift the rest of the row.
          if ((w > 1 || ch.charCodeAt(0) > 0x7e) && x + w < this.cols) s += `\x1b[${x + w + 1}G`;
        }
      }
      if (s !== this.prev[y]) {
        this.prev[y] = s;
        out += `\x1b[${this.top + y + 1};1H\x1b[0m\x1b[2K${s}\x1b[0m`;
      }
    }
    return out;
  }

  /** Cursor placement for when this pane has keyboard focus. */
  cursor(focused: boolean): string {
    const b = this.term.buffer.active;
    if (!focused || this.cursorHidden || b.viewportY !== b.baseY) return '\x1b[?25l';
    return `\x1b[${this.top + b.cursorY + 1};${b.cursorX + 1}H\x1b[?25h`;
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

function sgr(c: IBufferCell): string {
  let s = '';
  if (c.isBold()) s += ';1';
  if (c.isDim()) s += ';2';
  if (c.isItalic()) s += ';3';
  if (c.isUnderline()) s += ';4';
  if (c.isBlink()) s += ';5';
  if (c.isInverse()) s += ';7';
  if (c.isInvisible()) s += ';8';
  if (c.isStrikethrough()) s += ';9';
  if (c.isOverline()) s += ';53';
  s += color(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30, 90, 38);
  s += color(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40, 100, 48);
  return s;
}

function color(rgb: boolean, palette: boolean, v: number, base: number, bright: number, ext: number): string {
  if (rgb) return `;${ext};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
  if (!palette) return '';
  // Keep the 16 ANSI colors symbolic so the user's terminal theme applies.
  if (v < 8) return `;${base + v}`;
  if (v < 16) return `;${bright + v - 8}`;
  return `;${ext};5;${v}`;
}

/** Some package managers drop the exec bit on node-pty's prebuilt spawn-helper. */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return;
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const { mode } = fs.statSync(p);
      if ((mode & 0o111) === 0) fs.chmodSync(p, mode | 0o755);
    }
  } catch {
    // best effort
  }
}
