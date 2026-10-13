/**
 * Chrome native messaging host for the "Open in stamper" extension.
 *
 * Chrome starts this per message and talks over stdio: a 4-byte little-endian
 * length followed by JSON. We get { url } and open a new iTerm2 tab running
 * `stamper '<url>'` in the user's shell, so their PATH and environment apply.
 */
import { execFile } from 'node:child_process';
import { stamperCommand } from './chrome-extension.js';

const ITERM_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  tell application id "com.googlecode.iterm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text cmd
  end tell
end run`;

function readMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    process.stdin.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      try {
        resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on('end', () => reject(new Error('no message')));
  });
}

function send(message: object): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function main(): Promise<void> {
  try {
    const cmd = stamperCommand(await readMessage());
    if (process.env.STAMPER_HOST_DRY_RUN) {
      send({ ok: true, dryRun: true, command: cmd });
      return;
    }
    await new Promise<void>((resolve, reject) =>
      execFile('osascript', ['-e', ITERM_SCRIPT, cmd], (err, _out, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
      ),
    );
    send({ ok: true });
  } catch (e) {
    send({ ok: false, error: (e as Error).message });
  }
}

void main();
