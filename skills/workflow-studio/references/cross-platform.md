# Cross-platform (macOS / Windows / Linux)

Electron runs on all three; this app has no native modules, every path goes through `os.homedir()` /
`path.join`, shortcuts test `metaKey || ctrlKey`, and `window-all-closed` already branches on `darwin` — so the
same source runs on Windows and Linux.

## One exit point: `platform.js` at the repo root

- `hermesBin({platform, home, exists})` → `{ cmd, shell }`
  - macOS/Linux: `~/.hermes/hermes-agent/.hermes/bin/hermes`;
  - Windows: try `hermes.cmd` / `.exe` / `.bat` in that order, then fall back to the bare name `hermes.cmd`;
  - **on Windows `.cmd`/`.bat` need `shell: true`** (`execFile` and `spawn` do not run batch files); other
    platforms keep `false`.
- `hermesMissing()` only calls `existsSync` when `cmd` contains a path separator; a bare command name is left
  to `PATH` — otherwise "hermes is on PATH" would be misreported as "executable missing".
- `sqliteBin()`: `/usr/bin/sqlite3` on macOS/Linux when present; on Windows it checks
  `C:\Program Files\sqlite3\sqlite3.exe`, `C:\sqlite3\sqlite3.exe` and the home directory, then falls back to
  `sqlite3.exe` (the caller handles "not found").
- `modKey(platform)`: `darwin → '⌘'`, everything else `'Ctrl+'`.

## Renderer labels

- Source keeps writing `⌘Z`; `app.js` and `live.js` each carry `IS_MAC / KEYMOD / localizeKeys()`, which on
  non-mac platforms rewrites `⇧⌘` and `⌘` inside `[title*="⌘"]` to `Shift+Ctrl+` and `Ctrl+` at startup.
- New toasts and hints build their text from `KEYMOD` instead of hard-coding `⌘`.

## Launchers and protocol

- macOS: `open-workflow-studio.command`; Windows: `open-workflow-studio.bat` (`cd /d "%~dp0"`, installs
  dependencies only when `node_modules` is missing, hints Node 18+ on failure, `chcp 65001`); Linux: `npm start`.
- `workflow-studio://` registers on macOS/Windows. On Linux there is no `.desktop` entry in development, so
  `registerProtocol()` skips it with one log line instead of spamming failures.
- To get a debugging port in development you still need the launcher script; a bare Electron has no 9222.

## Tests and smoke check

- `node tools/test-platform.js` (or `npm run test:platform`): plain Node assertions for the macOS, Linux and
  Windows resolutions, no Electron.
- **Fixtures use neutral paths** (`/home/demo`, `C:\demo`): `tools/scan-public.js` treats a home-directory path
  with a user name, and department/role words, as hits. Never put a real user directory in a fixture (not even
  as an example) or the public scan raises false alarms. Examples here always use `/home/…` and `C:\…`.
- After a change, restart the user's instance once as a smoke test on macOS: the agent list loads (proves the
  hermes bridge still works), the split edit view and the live view open, the console is clean, and
  `[title*=⌘]` still reads `⌘`.
- There is no real Windows or Linux machine here, so only the unit tests cover them; when claiming "runs on all
  three", say that plainly, and verify on a real machine (or with an electron-builder package) when it matters.
