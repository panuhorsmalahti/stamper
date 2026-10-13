/**
 * Screen layout and input routing:
 *
 *   rows 1..B      browser (kitty image of the headless page)
 *   row  B+1       status bar
 *   rows B+2..end  claude (PTY rendered from xterm.js)
 */
import { BrowserPane, type MouseInput, type Viewport } from './browser.js';
import { ClaudePane } from './claude-pane.js';
import { debug } from './debug.js';
import { decodeMouse, type InputEvent } from './input.js';
import { deleteImage, pngSize, transmitPng, type Transfer } from './kitty.js';
import { applyReply, CELL_SIZE_QUERIES, pointerShape, type TermCaps, type Tty } from './tty.js';

export interface AppOptions {
  url: string;
  /** Fraction of the screen given to the browser. */
  split: number;
  /** Device scale factor override. */
  scale?: number;
  transfer: Transfer;
  theme: 'dark' | 'light';
  chromePath: string;
  userDataDir: string;
  claude: { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
  initialMessage?: string;
}

interface Layout {
  rows: number;
  cols: number;
  browserRows: number;
  /** 1-based screen row of the status bar. */
  statusRow: number;
  /** 0-based screen row where the claude pane starts. */
  paneTop: number;
  paneRows: number;
  vp: Viewport;
}

type Focus = 'claude' | 'browser';

const IMAGE_IDS = [0x57a30001, 0x57a30002];
const MOUSE_BUTTONS = ['left', 'middle', 'right', 'none'] as const;
const PANE_FRAME_MS = 16;
const MIN_BROWSER_ROWS = 3;
const MIN_PANE_ROWS = 3;

const BAR = '\x1b[0;38;5;252;48;5;236m';
const DIM = '\x1b[0;38;5;245;48;5;236m';
const BADGE = '\x1b[0;1;38;5;231;48;5;98m';
const TAG_ON = '\x1b[0;1;38;5;231;48;5;33m';
const TAG_OFF = '\x1b[0;38;5;245;48;5;238m';
const WARN = '\x1b[0;38;5;221;48;5;236m';

export class App {
  private layout!: Layout;
  private pane!: ClaudePane;
  private browser!: BrowserPane;
  private focus: Focus = 'claude';
  private urlEdit: string | null = null;
  private imageSlot = 0;
  private shownImage: number | undefined;
  private lastFrame: string | undefined;
  private message: { text: string; until: number } | undefined;
  private capture: 'browser' | 'pane' | 'divider' | null = null;
  /** Browser share of the screen; starts at --split, changed by dragging the status bar. */
  private split = 0.6;
  private browserResizeTimer: NodeJS.Timeout | undefined;
  private paneTimer: NodeJS.Timeout | undefined;
  private lastPaneRender = 0;
  private pendingSince = 0;
  private resizeTimer: NodeJS.Timeout | undefined;
  private tagCols: Record<Focus, [number, number]> = { claude: [0, 0], browser: [0, 0] };
  private dpr = 1;
  private pointer = '';
  private pointerZone: 'browser' | 'status' | 'pane' | undefined;

  constructor(
    private readonly tty: Tty,
    private readonly caps: TermCaps,
    private readonly o: AppOptions,
  ) {}

  /** Resolves with claude's exit code. */
  run(): Promise<number> {
    // Use the scale the terminal reports (iTerm2); otherwise guess from cell size, since
    // terminals like kitty report device pixels and HiDPI cells are ~2x taller.
    // Fixed for the session.
    this.dpr = this.o.scale ?? this.caps.scale ?? ((this.caps.cellH ?? 16) >= 24 ? 2 : 1);
    this.split = this.o.split;
    this.layout = this.computeLayout();
    const L = this.layout;
    this.tty.enter();

    this.pane = new ClaudePane({ ...this.o.claude, cols: L.cols, rows: L.paneRows, top: L.paneTop });
    this.pane.on('update', () => this.schedulePane());
    this.pane.on('passthrough', (s) => this.tty.write(s));

    this.browser = new BrowserPane({
      executablePath: this.o.chromePath,
      userDataDir: this.o.userDataDir,
      theme: this.o.theme,
      dpr: this.dpr,
      // Temp-file transfer is nearly free; inline base64 goes through the pty.
      maxFps: this.o.transfer === 'file' ? 24 : 10,
    });
    this.browser.state = { url: this.o.url, title: '', loading: true };
    this.browser.on('frame', (b64) => this.drawFrame(b64));
    this.browser.on('state', () => this.paintStatus());
    this.browser.on('message', (m) => this.flash(m));
    this.browser.on('exit', () => this.flash('Browser process exited'));
    this.browser.on('cursor', (shape) => {
      if (this.pointerZone === 'browser') this.setPointer(shape);
    });

    if (this.o.initialMessage) this.flash(this.o.initialMessage);
    this.paint(this.statusBar());
    this.browser
      .start(this.o.url, L.vp)
      .then(() => debug('browser started', L.vp))
      .catch((e: Error) => this.flash(`Browser failed to start: ${e.message}`));

    this.tty.on((e) => this.onInput(e));
    process.stdout.on('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.tty.write(CELL_SIZE_QUERIES); // font size may have changed too
        this.relayout();
      }, 50);
    });

    return new Promise((resolve) => this.pane.on('exit', resolve));
  }

  async close(): Promise<void> {
    this.pane?.kill();
    await this.browser?.close();
  }

  // ---------------------------------------------------------------- layout

  private computeLayout(): Layout {
    const rows = this.tty.rows;
    const cols = this.tty.cols;
    const browserRows = clamp(Math.round(rows * this.split), 1, Math.max(1, rows - 3));
    const paneTop = browserRows + 1;
    const cellW = this.caps.cellW ?? 8;
    const cellH = this.caps.cellH ?? 16;
    const dpr = this.dpr;
    const pxW = Math.round(cols * cellW);
    const pxH = Math.round(browserRows * cellH);
    return {
      rows,
      cols,
      browserRows,
      statusRow: browserRows + 1,
      paneTop,
      paneRows: Math.max(1, rows - paneTop),
      vp: { pxW, pxH, dpr, cssW: Math.max(200, Math.round(pxW / dpr)), cssH: Math.max(100, Math.round(pxH / dpr)) },
    };
  }

  private relayout(): void {
    this.layout = this.computeLayout();
    const L = this.layout;
    this.pane.resize(L.cols, L.paneRows, L.paneTop);
    const content = this.lastFrame ? this.frame(this.lastFrame) : '';
    this.paint('\x1b[0m\x1b[2J' + content + this.statusBar() + this.pane.render());
    // While the divider is being dragged, re-render the page only once it settles.
    clearTimeout(this.browserResizeTimer);
    if (this.capture === 'divider') this.browserResizeTimer = setTimeout(() => this.resizeBrowser(), 150);
    else this.resizeBrowser();
  }

  private resizeBrowser(): void {
    clearTimeout(this.browserResizeTimer);
    this.browserResizeTimer = undefined;
    this.browser.resize(this.layout.vp).catch(() => {});
  }

  /** Divider drag: the status bar follows the pointer, keeping both panes usable. */
  private dragDivider(row: number): void {
    const { rows, browserRows } = this.layout;
    const next = clamp(row - 1, MIN_BROWSER_ROWS, rows - 1 - MIN_PANE_ROWS);
    if (next === browserRows || next < 1) return;
    this.split = next / rows;
    this.relayout();
  }

  // --------------------------------------------------------------- drawing

  private drawFrame(b64: string): void {
    if (!this.lastFrame) debug('first frame', b64.length);
    // Inline (base64) frames can be large; keep them out of synchronized-update buffering.
    if (this.o.transfer === 'file') this.paint(this.frame(b64));
    else this.tty.write('\x1b[?25l' + this.frame(b64) + this.cursor());
  }

  private frame(b64: string): string {
    this.lastFrame = b64;
    const { cols, browserRows, vp } = this.layout;
    // A frame rendered for another pane height (mid-drag, before Chrome catches up)
    // is shown unscaled: cropped when the pane shrank, shorter when it grew.
    let rows = browserRows;
    let crop: number | undefined;
    const size = pngSize(b64);
    if (size && Math.abs(size[0] - vp.pxW) <= 4 && Math.abs(size[1] - vp.pxH) > 4) {
      crop = Math.min(size[1], vp.pxH);
      rows = clamp(Math.round((crop / vp.pxH) * browserRows), 1, browserRows);
    }
    this.imageSlot ^= 1;
    const id = IMAGE_IDS[this.imageSlot]!;
    // Place the new image first, then drop the old one: no blank frame in between.
    let s = '\x1b[1;1H' + transmitPng(id, b64, cols, rows, this.o.transfer, crop);
    if (this.shownImage !== undefined && this.shownImage !== id) s += deleteImage(this.shownImage);
    this.shownImage = id;
    return s;
  }

  /** One synchronized update that leaves the cursor where it belongs. */
  private paint(s: string): void {
    this.tty.write(`\x1b[?2026h\x1b[?25l${s}${this.cursor()}\x1b[?2026l`);
  }

  private paintStatus(): void {
    this.paint(this.statusBar());
  }

  private statusBar(): string {
    const { cols, statusRow } = this.layout;
    let left = `${BADGE} stamper ${BAR} `;
    let leftW = 10;
    let right: string;
    let rightW: number;

    if (this.urlEdit !== null) {
      const hint = ' ⏎ open · esc cancel ';
      right = DIM + hint;
      rightW = hint.length;
      const room = Math.max(4, cols - leftW - rightW - 8);
      const shown = this.urlEdit.length > room ? '…' + this.urlEdit.slice(-room + 1) : this.urlEdit;
      left += `Go to: \x1b[1m${shown}`;
      leftW += 7 + shown.length;
      this.urlCursorCol = leftW + 1;
    } else {
      const hint = this.focus === 'browser' ? ' ^L url · ⌥←/→ back/fwd · ^R reload · ^] claude ' : ' ^] browser ';
      const tags = (['claude', 'browser'] as const).map((f) => ({ f, text: ` ${f.toUpperCase()} ` }));
      rightW = hint.length + tags.reduce((n, t) => n + t.text.length, 0) + 1;
      right = DIM + hint;
      let col = cols - rightW + hint.length + 1;
      for (const t of tags) {
        right += (this.focus === t.f ? TAG_ON : TAG_OFF) + t.text;
        this.tagCols[t.f] = [col, col + t.text.length - 1];
        col += t.text.length;
      }
      right += BAR + ' ';

      const st = this.browser.state;
      const dot = st.loading ? '\x1b[38;5;221m◌' : (st.httpStatus ?? 200) >= 400 ? '\x1b[38;5;203m●' : '\x1b[38;5;114m●';
      left += dot + BAR + ' ';
      leftW += 2;
      const room = Math.max(0, cols - leftW - rightW - 1);
      const msg = this.currentMessage();
      if (msg) {
        left += WARN + truncate(msg, room);
      } else {
        const where = displayUrl(st.url);
        const text = st.title ? `${st.title} · ${where}` : where;
        left += truncate(text, room);
      }
    }
    return (
      `\x1b[${statusRow};1H${BAR}\x1b[2K${left}` + `\x1b[${Math.max(1, cols - rightW + 1)}G${right}\x1b[0m`
    );
  }

  private urlCursorCol = 1;

  private currentMessage(): string | undefined {
    if (this.message && Date.now() < this.message.until) return this.message.text;
    const st = this.browser.state;
    if (st.httpStatus === 404 && /^https:\/\/github\.com\//.test(st.url)) {
      return 'GitHub 404: private repo? Sign in once with: stamper --login';
    }
    return undefined;
  }

  private flash(text: string, ms = 6000): void {
    debug('flash', text);
    this.message = { text, until: Date.now() + ms };
    if (!this.layout) return;
    this.paintStatus();
    setTimeout(() => this.paintStatus(), ms + 50).unref();
  }

  private cursor(): string {
    if (!this.pane) return '';
    if (this.urlEdit !== null) return `\x1b[${this.layout.statusRow};${this.urlCursorCol}H\x1b[?25h`;
    return this.pane.cursor(this.focus === 'claude');
  }

  private schedulePane(): void {
    if (this.paneTimer) return;
    const wait = Math.max(0, PANE_FRAME_MS - (Date.now() - this.lastPaneRender));
    this.paneTimer = setTimeout(() => {
      this.paneTimer = undefined;
      this.flushPane();
    }, wait);
  }

  private flushPane(): void {
    // Hold off while the child is mid synchronized update (DEC 2026), up to 200ms.
    if (this.pane.pending) {
      const now = Date.now();
      if (!this.pendingSince) this.pendingSince = now;
      if (now - this.pendingSince < 200) {
        this.paneTimer ??= setTimeout(() => {
          this.paneTimer = undefined;
          this.flushPane();
        }, 10);
        return;
      }
    }
    this.pendingSince = 0;
    this.lastPaneRender = Date.now();
    this.paint(this.pane.render());
  }

  // ----------------------------------------------------------------- input

  private onInput(e: InputEvent): void {
    switch (e.type) {
      case 'reply':
        return this.onReply(e.seq);
      case 'mouse':
        return this.onMouse(e.code, e.col, e.row, e.release);
      case 'paste':
        if (this.urlEdit !== null) {
          this.urlEdit += e.text.replace(/\s+/g, '');
          this.paintStatus();
        } else if (this.focus === 'browser') {
          this.browser.paste(e.text);
        } else {
          this.pane.paste(e.text);
        }
        return;
      case 'key':
        return this.onKey(e.seq);
    }
  }

  private onReply(seq: string): void {
    const before = `${this.caps.cellW}x${this.caps.cellH}`;
    if (applyReply(this.caps, seq) === 'cell' && `${this.caps.cellW}x${this.caps.cellH}` !== before) this.relayout();
  }

  private onKey(seq: string): void {
    if (this.urlEdit !== null) return this.onUrlKey(seq);
    if (seq === '\x1d') return this.setFocus(this.focus === 'claude' ? 'browser' : 'claude'); // Ctrl+]
    if (this.focus === 'claude') return this.pane.input(seq);
    switch (seq) {
      case '\x0c': // Ctrl+L
        this.urlEdit = this.browser.state.url;
        this.paintStatus();
        return;
      case '\x12': // Ctrl+R
        return this.browser.reload();
      case '\x1b[1;3D':
      case '\x1bb':
        return this.browser.back();
      case '\x1b[1;3C':
      case '\x1bf':
        return this.browser.forward();
    }
    this.browser.key(seq);
  }

  private onUrlKey(seq: string): void {
    const text = this.urlEdit ?? '';
    switch (seq) {
      case '\r': {
        const url = normalizeUrl(text);
        this.urlEdit = null;
        if (url) this.browser.navigate(url);
        else if (text.trim()) this.flash(`Not a URL: ${text}`);
        break;
      }
      case '\x1b':
      case '\x03':
      case '\x1d':
        this.urlEdit = null;
        break;
      case '\x7f':
      case '\b':
        this.urlEdit = [...text].slice(0, -1).join('');
        break;
      case '\x15': // Ctrl+U
        this.urlEdit = '';
        break;
      case '\x17': // Ctrl+W
        this.urlEdit = text.replace(/[^/.?=&:#-]*[/.?=&:#-]?$/, '');
        break;
      default:
        if (seq[0] !== '\x1b' && seq.charCodeAt(0) >= 0x20) this.urlEdit = text + seq;
    }
    this.paintStatus();
  }

  private setFocus(f: Focus): void {
    if (this.focus === f) return;
    this.focus = f;
    this.pane.focus(f === 'claude');
    this.paintStatus();
  }

  private tagAt(col: number): Focus | undefined {
    return (['claude', 'browser'] as const).find((f) => col >= this.tagCols[f][0] && col <= this.tagCols[f][1]);
  }

  /** Mouse pointer shape via OSC 22 (kitty, Ghostty, iTerm2 3.7+). */
  private setPointer(shape: string): void {
    if (shape === this.pointer) return;
    this.pointer = shape;
    this.tty.write(pointerShape(shape));
  }

  private onMouse(code: number, col: number, row: number, release: boolean): void {
    const L = this.layout;
    const m = decodeMouse(code);
    const isPress = !m.wheel && !m.motion && !release;

    if (this.capture === 'divider') {
      if (m.motion) this.dragDivider(row);
      if (release) {
        this.capture = null;
        if (this.browserResizeTimer) this.resizeBrowser();
      }
      return;
    }

    let target: 'browser' | 'status' | 'pane' =
      row <= L.browserRows ? 'browser' : row === L.statusRow ? 'status' : 'pane';
    // Drags and releases go to wherever the press happened.
    if (this.capture && (m.motion || release)) target = this.capture;
    if (isPress) this.capture = target === 'status' ? null : target;
    if (release) this.capture = null;

    const tag = target === 'status' ? this.tagAt(col) : undefined;
    this.pointerZone = target;
    this.setPointer(
      target === 'browser' ? this.browser.cursorShape : target === 'pane' ? 'text' : tag ? 'pointer' : 'row-resize',
    );

    if (target === 'status') {
      if (isPress && m.button === 0) {
        if (tag) this.setFocus(tag);
        else this.capture = 'divider'; // the status bar is the split handle
      }
      return;
    }

    if (target === 'pane') {
      if (isPress) this.setFocus('claude');
      this.pane.mouse(code, col, clamp(row - L.paneTop, 1, L.paneRows), release);
      return;
    }

    if (isPress) this.setFocus('browser');
    const { cssW, cssH } = L.vp;
    const x = clamp(((col - 0.5) * cssW) / L.cols, 0, cssW - 1);
    const y = clamp(((row - 0.5) * cssH) / L.browserRows, 0, cssH - 1);
    const modifiers = (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.shift ? 8 : 0);
    const base = { x, y, modifiers };
    let ev: MouseInput;
    if (m.wheel) {
      const step = (3 * cssH) / L.browserRows; // ~3 terminal rows per notch
      const dir = m.button === 0 || m.button === 2 ? -step : step;
      const horizontal = m.button >= 2 || m.shift;
      ev = { ...base, kind: 'wheel', button: 'none', deltaX: horizontal ? dir : 0, deltaY: horizontal ? 0 : dir };
    } else {
      const button = MOUSE_BUTTONS[m.button]!;
      ev = { ...base, kind: m.motion ? 'move' : release ? 'release' : 'press', button };
    }
    this.browser.mouse(ev);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...s];
  const widths = chars.map((ch) => charWidth(ch.codePointAt(0)!));
  if (widths.reduce((a, b) => a + b, 0) <= width) return s;
  let out = '';
  let w = 0;
  for (let i = 0; i < chars.length && w + widths[i]! <= width - 1; i++) {
    out += chars[i];
    w += widths[i]!;
  }
  return out + '…';
}

/** Rough East Asian Wide / emoji detection; good enough for a status line. */
function charWidth(cp: number): number {
  if (cp < 0x1100) return 1;
  if (
    cp <= 0x115f ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function normalizeUrl(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return undefined;
  }
}
