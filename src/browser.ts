/**
 * Headless Chromium driven over CDP. Streams the viewport as PNG frames
 * (Page.startScreencast) and accepts synthesized mouse/keyboard input.
 */
import { EventEmitter } from 'node:events';
import { debug } from './debug.js';
import { pngSize } from './kitty.js';
import puppeteer, { type Browser, type CDPSession, type KeyInput, type Page, type Target } from 'puppeteer-core';

export interface Viewport {
  /** CSS pixels. */
  cssW: number;
  cssH: number;
  dpr: number;
  /** Device pixels (what the terminal will display). */
  pxW: number;
  pxH: number;
}

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
  httpStatus?: number;
}

export interface MouseInput {
  kind: 'press' | 'release' | 'move' | 'wheel';
  x: number;
  y: number;
  button: 'left' | 'middle' | 'right' | 'none';
  deltaX?: number;
  deltaY?: number;
  /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers: number;
}

export interface BrowserEvents {
  frame: [pngBase64: string];
  state: [PageState];
  message: [string];
  exit: [];
  /** CSS cursor name the page shows under the mouse. */
  cursor: [shape: string];
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4, none: 0 } as const;

const LAUNCH_DEFAULTS = {
  pipe: true,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  // navigator.webdriver + the automation infobar make some sites unhappy.
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-first-run', '--no-default-browser-check'],
} as const;

export class BrowserPane extends EventEmitter<BrowserEvents> {
  private browser?: Browser;
  private page?: Page;
  private cdp?: CDPSession;
  private vp?: Viewport;
  private frameSeq = 0;
  private buttons = 0;
  private lastClick = { t: 0, x: -1, y: -1, count: 0 };
  private keyChain: Promise<void> = Promise.resolve();
  private closing = false;
  private misfitSince = 0;
  private cursorQuery: { x: number; y: number } | undefined;
  private cursorBusy = false;
  cursorShape = 'default';
  state: PageState = { url: '', title: '', loading: true };

  constructor(
    private readonly opts: {
      executablePath: string;
      userDataDir: string;
      theme: 'dark' | 'light';
      /** Fixed for the browser's lifetime: screencast only delivers device-pixel frames via the launch flag. */
      dpr: number;
      maxFps: number;
    },
  ) {
    super();
  }

  async start(url: string, vp: Viewport): Promise<void> {
    this.vp = vp;
    this.browser = await puppeteer.launch({
      ...LAUNCH_DEFAULTS,
      ignoreDefaultArgs: [...LAUNCH_DEFAULTS.ignoreDefaultArgs],
      args: [...LAUNCH_DEFAULTS.args, `--force-device-scale-factor=${this.opts.dpr}`],
      executablePath: this.opts.executablePath,
      userDataDir: this.opts.userDataDir,
      headless: true,
      defaultViewport: null,
      protocolTimeout: 60_000,
    });
    this.browser.on('disconnected', () => {
      if (!this.closing) this.emit('exit');
    });
    this.browser.on('targetcreated', (t: Target) => void this.adoptPopup(t));

    const page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
    this.page = page;
    const ua = (await this.browser.userAgent()).replace(/HeadlessChrome/g, 'Chrome');
    await page.setUserAgent({ userAgent: ua });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: this.opts.theme }]);

    const cdp = await page.createCDPSession();
    this.cdp = cdp;
    // Headless pages are never "focused" otherwise: no caret, no :focus styles.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Show only the newest frame, at most maxFps. Chrome keeps up to two frames in
    // flight and waits for acks, so deferring acks also stops it encoding frames we'd drop.
    const minGap = 1000 / this.opts.maxFps;
    let lastEmit = 0;
    let latest: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (latest === undefined) return;
      const data = latest;
      latest = undefined;
      lastEmit = Date.now();
      this.emit('frame', data);
    };
    cdp.on('Page.screencastFrame', (f) => {
      const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (!this.fits(f.data)) {
        ack(); // rendered for a previous viewport size
        return;
      }
      this.frameSeq++;
      latest = f.data;
      const wait = Math.max(0, lastEmit + minGap - Date.now());
      timer ??= setTimeout(flush, wait);
      setTimeout(ack, wait);
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.setState({ url: frame.url() });
      setTimeout(() => void this.refreshTitle(), 300);
    });
    page.on('request', (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) this.setState({ loading: true });
    });
    page.on('requestfailed', (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) this.setState({ loading: false });
    });
    page.on('response', (res) => {
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        this.setState({ httpStatus: res.status() });
      }
    });
    page.on('load', () => {
      this.setState({ loading: false });
      void this.refreshTitle();
      void this.kick();
    });
    page.on('dialog', (d) => {
      this.emit('message', `${d.type()}: ${d.message()}`);
      d.accept().catch(() => {});
    });

    // The terminal may have been resized while Chrome was starting.
    await this.resize(this.vp);
    this.navigate(url);
  }

  async resize(vp: Viewport): Promise<void> {
    this.vp = vp;
    if (!this.page || !this.cdp) return;
    await this.page.setViewport({ width: vp.cssW, height: vp.cssH, deviceScaleFactor: vp.dpr });
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.cdp.send('Page.startScreencast', {
      format: 'png',
      maxWidth: vp.pxW,
      maxHeight: vp.pxH,
      everyNthFrame: 1,
    });
    void this.kick();
  }

  /**
   * Screencast only emits frames when something changes. If nothing arrives
   * shortly after a resize/load, grab a screenshot so the pane isn't stale.
   */
  private async kick(delayMs = 350, attempts = 3): Promise<void> {
    const seq = this.frameSeq;
    await new Promise((r) => setTimeout(r, delayMs));
    if (seq !== this.frameSeq || !this.cdp) return;
    try {
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
      if (seq !== this.frameSeq) return;
      if (this.fits(data)) this.emit('frame', data);
      else if (attempts > 1) void this.kick(delayMs, attempts - 1); // viewport change still settling
    } catch {
      // page navigating or closed
    }
  }

  /**
   * Frames captured mid-resize come out at the old size; drop them, unless that's
   * all we've been getting for a while (then our expectation is what's wrong).
   */
  private fits(pngBase64: string): boolean {
    const size = pngSize(pngBase64);
    if (!this.vp || !size) return true;
    const ok = Math.abs(size[0] - this.vp.pxW) <= 4 && Math.abs(size[1] - this.vp.pxH) <= 4;
    if (ok) {
      this.misfitSince = 0;
      return true;
    }
    const now = Date.now();
    debug('misfit frame', size, 'expected', [this.vp.pxW, this.vp.pxH]);
    if (!this.misfitSince) this.misfitSince = now;
    return now - this.misfitSince > 1500;
  }

  navigate(url: string): void {
    this.setState({ url, loading: true, httpStatus: undefined });
    this.page?.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 }).catch((e: Error) => {
      if (!this.closing) this.emit('message', e.message.split('\n')[0]!);
    });
  }

  back(): void {
    this.page?.goBack({ timeout: 0 }).catch(() => {});
  }

  forward(): void {
    this.page?.goForward({ timeout: 0 }).catch(() => {});
  }

  reload(): void {
    this.page?.reload({ timeout: 0 }).catch(() => {});
  }

  mouse(e: MouseInput): void {
    const cdp = this.cdp;
    if (!cdp) return;
    const base = { x: e.x, y: e.y, modifiers: e.modifiers };
    const send = (params: Parameters<CDPSession['send']>[1]) =>
      cdp.send('Input.dispatchMouseEvent', params as never).catch(() => {});
    switch (e.kind) {
      case 'wheel':
        send({ ...base, type: 'mouseWheel', deltaX: e.deltaX ?? 0, deltaY: e.deltaY ?? 0 });
        // Content moves under the pointer; look again once the scroll has happened.
        setTimeout(() => this.trackCursor(e.x, e.y), 120);
        return;
      case 'move':
        send({ ...base, type: 'mouseMoved', button: e.button, buttons: this.buttons });
        this.trackCursor(e.x, e.y);
        return;
      case 'press': {
        const now = Date.now();
        const c = this.lastClick;
        const same = now - c.t < 450 && Math.abs(c.x - e.x) < 6 && Math.abs(c.y - e.y) < 6;
        this.lastClick = { t: now, x: e.x, y: e.y, count: same ? c.count + 1 : 1 };
        this.buttons |= BUTTON_BITS[e.button];
        send({ ...base, type: 'mousePressed', button: e.button, buttons: this.buttons, clickCount: this.lastClick.count });
        return;
      }
      case 'release':
        this.buttons &= ~BUTTON_BITS[e.button];
        send({ ...base, type: 'mouseReleased', button: e.button, buttons: this.buttons, clickCount: this.lastClick.count });
        this.trackCursor(e.x, e.y);
        return;
    }
  }

  /** Headless Chrome has no cursor to report, so ask the page what it would show. */
  private trackCursor(x: number, y: number): void {
    this.cursorQuery = { x, y };
    if (!this.cursorBusy) void this.runCursorQueries();
  }

  /** One query in flight at a time; only the latest pointer position matters. */
  private async runCursorQueries(): Promise<void> {
    this.cursorBusy = true;
    while (this.cursorQuery && this.page) {
      const { x, y } = this.cursorQuery;
      this.cursorQuery = undefined;
      const shape = await this.page.evaluate(pageCursorAt, x, y).catch(() => this.cursorShape);
      if (shape !== this.cursorShape) {
        this.cursorShape = shape;
        this.emit('cursor', shape);
      }
    }
    this.cursorBusy = false;
  }

  /** A raw terminal key sequence (legacy encoding). */
  key(seq: string): void {
    const spec = parseKey(seq);
    const page = this.page;
    if (!spec || !page) return;
    this.keyChain = this.keyChain
      .then(async () => {
        const kb = page.keyboard;
        for (const m of spec.mods) await kb.down(m);
        try {
          if (spec.key) {
            await kb.press(spec.key);
          } else if (spec.text) {
            try {
              await kb.press(spec.text as KeyInput);
            } catch {
              await kb.sendCharacter(spec.text); // not on a US layout (é, emoji, ...)
            }
          }
        } finally {
          for (const m of [...spec.mods].reverse()) await kb.up(m);
        }
      })
      .catch(() => {});
  }

  paste(text: string): void {
    this.cdp?.send('Input.insertText', { text }).catch(() => {});
  }

  private async refreshTitle(): Promise<void> {
    try {
      const title = await this.page?.title();
      if (title !== undefined) this.setState({ title });
    } catch {
      // mid-navigation
    }
  }

  private setState(patch: Partial<PageState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Keep everything in one tab: new windows/tabs are redirected into the main page. */
  private async adoptPopup(t: Target): Promise<void> {
    if (!this.page || t.type() !== 'page' || t === this.page.target()) return;
    const popup = await t.page().catch(() => null);
    if (!popup) return;
    let url = t.url();
    if (!url || url === 'about:blank') {
      await popup.waitForNavigation({ timeout: 5000 }).catch(() => {});
      url = popup.url();
    }
    await popup.close().catch(() => {});
    if (url && url !== 'about:blank') this.navigate(url);
  }

  async close(): Promise<void> {
    this.closing = true;
    const b = this.browser;
    if (!b) return;
    // A graceful close flushes cookies to disk; fall back to killing it.
    await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    b.process()?.kill('SIGKILL');
  }
}

/** Runs in the page: the cursor a browser would show at (x, y), as a CSS cursor name. */
function pageCursorAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'default';
  const css = getComputedStyle(el).cursor.split(',').pop()!.trim();
  if (css && css !== 'auto') return css;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return 'text';
  if (el instanceof HTMLInputElement && !/^(button|submit|reset|checkbox|radio|image|range|color|file)$/.test(el.type)) {
    return 'text';
  }
  // 'auto' over actual text is an I-beam.
  const caret = document.caretRangeFromPoint(x, y);
  if (caret?.startContainer.nodeType === Node.TEXT_NODE) {
    const range = document.createRange();
    range.selectNodeContents(caret.startContainer);
    for (const r of range.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 'text';
    }
  }
  return 'default';
}

export interface KeySpec {
  key?: KeyInput;
  text?: string;
  mods: KeyInput[];
}

const CURSOR: Record<string, KeyInput> = {
  A: 'ArrowUp',
  B: 'ArrowDown',
  C: 'ArrowRight',
  D: 'ArrowLeft',
  H: 'Home',
  F: 'End',
  P: 'F1',
  Q: 'F2',
  R: 'F3',
  S: 'F4',
};

const TILDE: Record<string, KeyInput> = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8',
  20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12',
};

/** xterm modifier parameter (1 + bits) -> modifier keys. */
function mods(param: string | undefined): KeyInput[] {
  const bits = Math.max(0, Number(param ?? 1) - 1);
  const out: KeyInput[] = [];
  if (bits & 1) out.push('Shift');
  if (bits & 2) out.push('Alt');
  if (bits & 4) out.push('Control');
  if (bits & 8) out.push('Meta');
  return out;
}

export function parseKey(seq: string): KeySpec | undefined {
  switch (seq) {
    case '\r':
    case '\n':
      return { key: 'Enter', mods: [] };
    case '\t':
      return { key: 'Tab', mods: [] };
    case '\x7f':
    case '\b':
      return { key: 'Backspace', mods: [] };
    case '\x1b':
      return { key: 'Escape', mods: [] };
    case '\x1b[Z':
      return { key: 'Tab', mods: ['Shift'] };
  }
  if (seq[0] !== '\x1b') {
    const c = seq.charCodeAt(0);
    if (seq.length === 1 && c >= 1 && c <= 26) return { key: String.fromCharCode(96 + c) as KeyInput, mods: ['Control'] };
    if (c < 0x20) return undefined;
    return { text: seq, mods: [] };
  }
  let m = seq.match(/^\x1b\[(?:1;(\d+))?([A-DHF])$/) ?? seq.match(/^\x1bO(\d*)([A-DHFPQRS])$/);
  if (m) return { key: CURSOR[m[2]!], mods: mods(m[1] || undefined) };
  m = seq.match(/^\x1b\[(\d+)(?:;(\d+))?~$/);
  if (m) {
    const key = TILDE[m[1]!];
    return key ? { key, mods: mods(m[2]) } : undefined;
  }
  // Alt+<key>
  const inner = parseKey(seq.slice(1));
  if (inner && seq.length <= 3) return { ...inner, mods: [...inner.mods, 'Alt'] };
  return undefined;
}

/**
 * Opens a visible Chrome window on stamper's profile so the user can sign in to
 * sites (GitHub, SSO...). Resolves once every window has been closed.
 */
export async function interactiveLogin(executablePath: string, userDataDir: string, url: string): Promise<void> {
  const browser = await puppeteer.launch({
    ...LAUNCH_DEFAULTS,
    ignoreDefaultArgs: [...LAUNCH_DEFAULTS.ignoreDefaultArgs],
    args: [...LAUNCH_DEFAULTS.args],
    executablePath,
    userDataDir,
    headless: false,
    defaultViewport: null,
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto(url).catch(() => {});

  let closing = false;
  const closeGracefully = () => {
    if (closing) return;
    closing = true;
    void browser.close();
  };
  process.once('SIGINT', closeGracefully);
  // On macOS closing the last window doesn't quit Chrome; do it for the user.
  browser.on('targetdestroyed', async () => {
    const pages = await browser.pages().catch(() => []);
    if (pages.length === 0) closeGracefully();
  });
  await new Promise<void>((resolve) => browser.once('disconnected', () => resolve()));
}
