/**
 * Registers the native messaging host used by chrome-extension/ with the
 * user's Chromium-based browsers (macOS).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stamperHome } from './chrome.js';

export const HOST_NAME = 'com.panuhorsmalahti.stamper';
/** Fixed by the "key" in chrome-extension/manifest.json. */
export const EXTENSION_ID = 'fnebffpjpnmphcflnbdoljdeclopgjcj';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = path.join(ROOT, 'chrome-extension');

const BROWSER_DIRS = [
  'Google/Chrome',
  'Google/Chrome Beta',
  'Google/Chrome Canary',
  'Chromium',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
].map((d) => path.join(os.homedir(), 'Library', 'Application Support', d));

function wrapperPath(): string {
  return path.join(stamperHome(), 'chrome-native-host');
}

/** POSIX single-quoting: safe for any string, including quotes and $. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell command the native host types into iTerm2 for a { url } message. */
export function stamperCommand(input: unknown): string {
  const raw = (input as { url?: unknown } | null)?.url;
  if (typeof raw !== 'string') throw new Error('expected { url }');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`refusing ${url.protocol} URL`);
  return `stamper ${shellQuote(url.href)}`;
}

/** Returns the host manifest files written. */
export function installNativeHost(): string[] {
  if (process.platform !== 'darwin') throw new Error('the Chrome extension opens iTerm2, so it is macOS only');
  // Chrome starts hosts with a bare environment, so pin this node binary.
  const wrapper = wrapperPath();
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, 'dist', 'native-host.js'))} "$@"\n`,
    { mode: 0o755 },
  );
  const manifest = {
    name: HOST_NAME,
    description: 'Opens pages in stamper (iTerm2)',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  const written: string[] = [];
  for (const dir of BROWSER_DIRS) {
    if (!fs.existsSync(dir)) continue; // browser not installed
    const file = path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

/** Returns the files removed. */
export function uninstallNativeHost(): string[] {
  const files = [
    ...BROWSER_DIRS.map((d) => path.join(d, 'NativeMessagingHosts', `${HOST_NAME}.json`)),
    wrapperPath(),
  ];
  return files.filter((f) => {
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f);
    return true;
  });
}
