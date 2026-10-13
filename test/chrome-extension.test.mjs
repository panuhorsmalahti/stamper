import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stamperCommand } from '../dist/chrome-extension.js';

test('builds a shell-safe stamper command from the URL', () => {
  assert.equal(stamperCommand({ url: 'https://github.com/o/r/pull/1' }), "stamper 'https://github.com/o/r/pull/1'");
  // Quotes and shell metacharacters stay inert inside single quotes.
  assert.equal(stamperCommand({ url: "https://x.dev/a'b$(id)`x`" }), "stamper 'https://x.dev/a'\\''b$(id)%60x%60'");
});

test('rejects anything but http(s) URLs', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url']) {
    assert.throws(() => stamperCommand({ url }));
  }
  assert.throws(() => stamperCommand({}));
  assert.throws(() => stamperCommand(null));
});
