# stamper

A split-screen terminal app for reviewing pull requests with Claude Code.

```
stamper https://github.com/owner/repo/pull/123
```

![stamper reviewing a GitHub pull request: the PR page on top, Claude Code below](stamper.png?v=e6c3f9b)

The top pane is a headless Chrome rendering the URL, streamed into the terminal with the
[kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). You can click,
scroll, drag and type into it. The bottom pane runs `claude` in a PTY, launched as:

```
claude --append-system-prompt "Your goal is to assist in the review of this pull request: <url>"
```

`--append-system-prompt` adds to Claude Code's default system prompt; it does not replace it.

## Requirements

- A terminal with the kitty graphics protocol: **kitty**, **Ghostty**, **WezTerm** or a recent **iTerm2**.
  Terminal.app and tmux/screen won't work; stamper checks on startup and says so.
- Google Chrome, Chromium, Edge or Brave (found automatically; override with `--chrome` or `STAMPER_CHROME`).
- The `claude` CLI on your `PATH`.
- Node.js 20+.

## Install

```
cd stamper
npm install      # also builds via the prepare script
npm link         # puts `stamper` on your PATH
```

## Signing in (private repos)

The browser uses its own profile in `~/.stamper/profile` (override with `STAMPER_HOME`), so on a
private repo GitHub will show a 404 until you sign in once:

```
stamper --login            # opens a normal Chrome window on github.com/login
stamper --login <url>      # or any other site (SSO, Jira, ...)
```

Sign in, close the window, and later stamper sessions reuse the cookies. If you run two
stamper sessions at the same time, the second one uses a temporary copy of the profile.

## Open pages from Chrome

An "Open in stamper" extension for your everyday Chrome (macOS + iTerm2): click its toolbar
button, press `Alt+Shift+S`, or right-click a link → "Open link in stamper", and a new iTerm2
tab runs `stamper '<url>'`.

```
stamper --install-chrome-extension
```

This registers a small [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
helper (extensions can't start programs themselves) that only this extension may call. Then, once:

1. open `chrome://extensions` and turn on **Developer mode**
2. click **Load unpacked** and pick the `chrome-extension` folder of this repo

The first time you use it, macOS asks whether Chrome may control iTerm2; allow it. The command
runs in your normal shell, in the new tab's directory. If something's wrong, the button shows a
red `!` and its tooltip says why. `stamper --uninstall-chrome-extension` removes the helper.

## Keys

| Where | Key | Action |
|---|---|---|
| anywhere | `Ctrl+]` | toggle keyboard focus between Claude and the browser |
| anywhere | click | focus the pane you clicked |
| status bar | drag up/down | resize the split between the browser and Claude |
| browser | click / drag / wheel | passed to the page |
| browser focus | typing, paste | goes to the page |
| browser focus | `Ctrl+L` | go to URL (Enter opens, Esc cancels) |
| browser focus | `Alt+←` / `Alt+→` | back / forward |
| browser focus | `Ctrl+R` | reload |
| Claude pane | wheel | scroll back through Claude's output |

Quit by exiting Claude (`/exit`, or `Ctrl+C` twice). stamper captures the mouse, so to select
text with the terminal's own selection, hold **Shift** while dragging (kitty, Ghostty and WezTerm).

## Options

```
--split <0.2-0.9>   initial share of the screen for the browser (default 0.6; drag the status bar to change it)
--scale <n>         page device scale factor (default: 2 when cells look HiDPI, else 1)
--theme <t>         dark | light (default light)
--autodetect-theme  match the terminal: dark page on a dark background (--theme wins)
--transfer <t>      auto | direct | file  (how frames reach the terminal, see below)
--chrome <path>     browser binary
-- <args>           extra arguments for claude, e.g. `stamper <url> -- --model opus`
```

## How it works

- **Browser**: puppeteer-core drives headless Chrome. `Page.startScreencast` emits PNG frames
  only when the page changes; stamper keeps the newest one and draws at most 24 fps (10 fps for
  inline transfer). Chrome is launched with `--force-device-scale-factor` so frames arrive at
  full device resolution and stay sharp on Retina screens.
- **Graphics**: each frame is placed at the top-left, scaled to exactly the pane's cells, using
  two alternating image ids (place new, then delete old) so it never flickers. When the terminal
  can read temp files (local kitty/Ghostty), frames go through a temp file; otherwise (e.g. over
  SSH) they're sent inline as base64.
- **Claude pane**: `claude` runs in a PTY (node-pty), its output is emulated by xterm.js
  (headless, the same engine as VS Code's terminal) and the changed rows are redrawn into the
  bottom of the screen.
- **Input**: stamper reads raw stdin and splits it into keys, SGR mouse reports, bracketed pastes
  and terminal replies, then routes each one by focus and pointer position. Keys for the page are
  turned into CDP key events.

`STAMPER_DEBUG=/tmp/stamper.log stamper <url>` writes a debug log.

## Development

```
npm run build   # tsc → dist/
npm run dev     # tsc --watch
npm test        # input parser / key mapping tests
```
