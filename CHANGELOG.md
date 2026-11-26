# Changelog

## 0.6.3

- Same content as 0.6.2. Republished under a new version number because the first upload of 0.6.2 was still being processed by the registry (`409 Cannot publish over previously staged version`); both ended up live, `latest` points here.

## 0.6.2

- Wording only: the marketplace entry and the plugin-list description now say the header button "refreshes the page and hot-reloads plugin code", and the quit/restart note reads "a normal close, not a force kill — no system chime and no error dialog".

## 0.6.1

- **Safety fix.** The helper now looks the shell up by PID before doing anything (`Win32_Process`): if that PID turns out to run a different executable — Windows recycles PIDs — it aborts instead of closing somebody else's windows, and it also refuses when the Host is not a child of that process.
- Package renamed from `dsh-refresh` to `dsh-restart-refresh`; routes, module id, log and settings file names follow the new name.

## 0.6.0

- Package renamed to `dsh-restart-refresh` (the npm name `dsh-refresh` was already taken).

## 0.5.0

- Portability: the generated PowerShell script is now written as UTF-8 **with BOM** and the VBS launcher as UTF-16LE with BOM, so non-ASCII paths work on other machines.
- Desktop-only gate: restart/quit are hidden in the browser version (`dsh web`) and the host refuses with `409 not-desktop`; the buttons only appear after `/state` reports `desktop: true`.
- `/state` reports `version` from `package.json` instead of a hardcoded string.
- English fallback for every UI string (`detectZh()` treats anything that is not Chinese as English).

## 0.4.4

- **Graceful quit and restart.** Both buttons now ask the shell to end its session (`WM_QUERYENDSESSION` + `WM_ENDSESSION`) and then close its windows (`WM_CLOSE`), instead of force-killing it. That makes the tray-quit path run, so state is saved, the Host is stopped cleanly and the Windows "ding" is gone.
- 8-second timeout falls back to the old force stop, and the log says which path ran.
- Helper scripts are syntax-checked with `test/dump-helper.mjs` + the PowerShell parser (a bare `{ }` block once made the whole script a no-op).

## 0.4.3

- Fixed "restart only closes, never reopens": the Host runs with `ELECTRON_RUN_AS_NODE=1`, which was inherited by the relaunched app, so it started as plain Node and exited immediately. The helper now clears that variable before launching.
- Orphaned child processes of the old Host are cleaned up before relaunching.
- Startup marker `host ready: plugin applied after Xs of Host uptime` in the log.

## 0.4.1 / 0.4.2

- No console window any more: the helper is launched through `wscript.exe` + a generated VBS, hidden.
- Faster: 250 ms settle instead of a 5 s window-close wait; force stop only when needed.
- Added the `quit` mode (close the app without reopening it).

## 0.4.0

- Two icon buttons next to the `deepseek` logo: restart and quit, each with a red two-step confirm key.
- The reload button in the conversation header became an icon (same glyph as the logo-row restart).
- Black hover tooltips, 600 ms delay, hover highlight.

## 0.3.0

- Settings page **设置 → 刷新与重启** (confirm before restart / before reload / rebuild the page after reload).
- `POST /dsh-restart-refresh/reload` runs `hmr.runExclusive(() => hmr.reconcileProfile([]))` and reports `pending` / `restartReason` instead of pretending success.

## 0.1.0 – 0.2.0

- First version: reload button in the desktop title bar, then a restart helper that kills the shell and the Host and starts the same exe again.
