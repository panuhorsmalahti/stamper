#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { App, normalizeUrl } from './app.js';
import { debug } from './debug.js';
import { interactiveLogin } from './browser.js';
import { acquireProfile, baseProfileDir, findChrome, profileLockedBy, which } from './chrome.js';
import type { Transfer } from './kitty.js';
import { isDark, Tty } from './tty.js';

const VERSION = '0.1.0';

const USAGE = `stamper ${VERSION} — review a page with Claude Code side by side

Usage:
  stamper <url> [options] [-- <extra claude args>]
  stamper --login [url]

The page renders in the top of the terminal (kitty graphics protocol) and
Claude Code runs below, told to help review <url>.

Options:
  --login            Open a visible Chrome window on stamper's profile so you can
                     sign in (default: https://github.com/login). Close it when done.
  --split <0.2-0.9>  Share of the screen for the browser (default 0.6)
  --scale <n>        Page device scale factor (default: 2 on HiDPI cells, else 1)
  --theme <t>        dark | light (default light)
  --autodetect-theme Match the terminal: dark page on a dark background (--theme wins)
  --transfer <t>     auto | direct | file: how images reach the terminal
  --chrome <path>    Chrome/Chromium binary (or STAMPER_CHROME)
  -h, --help         Show this help
  -v, --version      Show version

Keys:
  Ctrl+]             Toggle keyboard focus between Claude and the browser
  Click              Focuses the pane you click; clicks/scroll/drag reach the page
  Browser focus:     Ctrl+L go to URL · Alt+←/→ back/forward · Ctrl+R reload
  Claude pane:       Mouse wheel scrolls back through Claude's output
`;

const PROMPT = (url: string) => `Your goal is to assist in the review of this pull request: ${url}`;

function fail(msg: string, code = 1): never {
  process.stderr.write(`stamper: ${msg}\n`);
  process.exit(code);
}

function findClaude(): string | undefined {
  const fallbacks = [path.join(os.homedir(), '.claude', 'local', 'claude'), path.join(os.homedir(), '.local', 'bin', 'claude')];
  return which('claude') ?? fallbacks.find((p) => fs.existsSync(p));
}

/** Env for the child: a plain xterm, so claude doesn't target the outer terminal's extensions. */
function childEnv(url: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(KITTY_|GHOSTTY_|WEZTERM_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|LC_TERMINAL)/.test(k)) delete env[k];
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', STAMPER: '1', STAMPER_URL: url };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: dd >= 0 ? argv.slice(0, dd) : argv,
    allowPositionals: true,
    options: {
      login: { type: 'boolean' },
      split: { type: 'string' },
      scale: { type: 'string' },
      theme: { type: 'string' },
      'autodetect-theme': { type: 'boolean' },
      transfer: { type: 'string' },
      chrome: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const claudeExtra = dd >= 0 ? argv.slice(dd + 1) : [];

  if (values.help) return void process.stdout.write(USAGE);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);

  const chromePath = findChrome(values.chrome);
  if (!chromePath) fail('no Chrome/Chromium found. Install Google Chrome, or pass --chrome <path> / set STAMPER_CHROME.');

  if (values.login) {
    const url = normalizeUrl(positionals[0] ?? 'https://github.com/login');
    if (!url) fail(`not a URL: ${positionals[0]}`, 2);
    const dir = baseProfileDir();
    fs.mkdirSync(dir, { recursive: true });
    if (profileLockedBy(dir) !== undefined) fail('the stamper profile is in use; quit other stamper sessions first.');
    process.stdout.write(`Opening Chrome on stamper's profile (${dir}).\nSign in, then close the window.\n`);
    await interactiveLogin(chromePath, dir, url);
    process.stdout.write('Saved. Future stamper sessions will reuse this login.\n');
    return;
  }

  if (positionals.length !== 1) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const url = normalizeUrl(positionals[0]!);
  if (!url) fail(`not a URL: ${positionals[0]}`, 2);

  const split = values.split === undefined ? 0.6 : Number(values.split);
  if (!(split >= 0.2 && split <= 0.9)) fail('--split must be between 0.2 and 0.9', 2);
  const scale = values.scale === undefined ? undefined : Number(values.scale);
  if (scale !== undefined && !(scale > 0 && scale <= 4)) fail('--scale must be between 0 and 4', 2);
  if (values.theme && !['dark', 'light'].includes(values.theme)) fail('--theme must be dark or light', 2);
  if (values.transfer && !['auto', 'direct', 'file'].includes(values.transfer)) fail('--transfer must be auto, direct or file', 2);

  const claude = findClaude();
  if (!claude) fail('the claude CLI was not found on PATH.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('stamper needs an interactive terminal.');

  const tty = new Tty();
  tty.start();
  const caps = await tty.probe();
  debug('caps', JSON.stringify(caps), `${tty.cols}x${tty.rows}`);
  if (caps.graphics === false) {
    tty.restore();
    const term = process.env.TERM_PROGRAM ?? process.env.TERM ?? 'this terminal';
    fail(
      `${term} doesn't support the kitty graphics protocol. ` +
        'Run stamper directly in kitty, Ghostty, WezTerm or a recent iTerm2 (not inside tmux/screen).',
    );
  }

  const theme =
    values.theme === 'dark' || values.theme === 'light'
      ? values.theme
      : values['autodetect-theme'] && caps.background && isDark(caps.background)
        ? 'dark'
        : 'light';
  const transfer: Transfer =
    values.transfer === 'direct' || values.transfer === 'file' ? values.transfer : caps.fileTransfer ? 'file' : 'direct';

  const profile = acquireProfile();
  const app = new App(tty, caps, {
    url,
    split,
    scale,
    transfer,
    theme,
    chromePath,
    userDataDir: profile.dir,
    claude: {
      file: claude,
      args: ['--append-system-prompt', PROMPT(url), ...claudeExtra],
      env: childEnv(url),
      cwd: process.cwd(),
    },
    initialMessage: profile.isClone
      ? 'Profile in use by another stamper; using a temporary copy (logins here won’t be saved)'
      : undefined,
  });

  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    tty.restore();
    await app.close().catch((e) => debug('close', e));
    profile.cleanup();
    process.exit(code);
  };
  process.on('exit', () => tty.restore());
  process.on('SIGTERM', () => void exit(143));
  process.on('SIGHUP', () => void exit(129));
  process.on('uncaughtException', (e) => {
    tty.restore();
    process.stderr.write(`stamper crashed: ${e.stack ?? e}\n`);
    process.exit(1);
  });
  // Late CDP errors (navigations racing a close, etc.) are not fatal.
  process.on('unhandledRejection', (e) => debug('unhandledRejection', e));

  const code = await app.run();
  await exit(code);
}

main().catch((e: Error) => fail(e.stack ?? String(e)));
