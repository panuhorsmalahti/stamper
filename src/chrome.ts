/**
 * Locating a Chromium-based browser and managing stamper's browser profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
];

const PATH_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

export function findChrome(explicit?: string): string | undefined {
  const fromUser = explicit ?? process.env.STAMPER_CHROME;
  if (fromUser) return fromUser;
  if (process.platform === 'darwin') {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const app of MAC_APPS) {
        const p = path.join(dir, app);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return PATH_NAMES.map(which).find(Boolean);
}

export function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function stamperHome(): string {
  return process.env.STAMPER_HOME ?? path.join(os.homedir(), '.stamper');
}

export function baseProfileDir(): string {
  return path.join(stamperHome(), 'profile');
}

/** Chrome holds SingletonLock -> "<host>-<pid>" while a profile is open. */
export function profileLockedBy(dir: string): number | undefined {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return undefined;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined;
  }
}

const SKIP_ON_CLONE = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker',
  'Crashpad',
]);

export interface Profile {
  dir: string;
  /** True when this is a throwaway copy (another stamper owns the real profile). */
  isClone: boolean;
  cleanup(): void;
}

/**
 * Use the persistent profile so logins stick. If another stamper session has it
 * open, run on a temporary copy instead (logins still work, changes are discarded).
 */
export function acquireProfile(): Profile {
  const base = baseProfileDir();
  fs.mkdirSync(base, { recursive: true });
  if (profileLockedBy(base) === undefined) {
    return { dir: base, isClone: false, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamper-profile-'));
  fs.cpSync(base, dir, {
    recursive: true,
    filter: (src) => !SKIP_ON_CLONE.has(path.basename(src)),
  });
  return {
    dir,
    isClone: true,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
