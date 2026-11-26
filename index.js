/**
 * Host half of DSH-restart-refresh.
 *
 * Two different kinds of staleness live behind the two buttons:
 *
 * - Client-side plugin code is fetched by the page on load, so reloading the
 *   renderer is enough — and the renderer can do that itself.
 * - Host-side plugin code lives in the long-lived Host process. Nothing in the
 *   page can replace it, and the desktop shell exposes no API for asking:
 *   `app.relaunch()` is only reachable from the Electron main process, the
 *   renderer has no `ipcRenderer` to reach it, and the shipped menu only has a
 *   "restart app" entry in unpackaged builds.
 *
 * So a plugin can only restart the application by doing it itself: this module
 * drops a small helper onto disk, launches it detached, answers the request,
 * and the helper closes the app and starts it again. The Host process dies with
 * it, which is exactly the point.
 *
 * Host-side plugins can also be replaced without a restart through the `hmr`
 * service: `runExclusive(() => reconcileProfile([]))` recomposes the profile
 * from disk and stops/starts the entries whose files changed. That is the same
 * move dsh-unlag makes, and it is what the reload route here exposes.
 *
 * Nothing here runs in a browser (`dsh web`): the client half stays on the
 * plain reload, and the restart route answers 409 because a `dsh web` host has
 * no desktop process to replace.
 */
import { execFile, spawn } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The version reported by `/state` always matches the package manifest. */
function pluginVersion() {
  try {
    return String(createRequire(import.meta.url)('../package.json').version ?? '0.0.0')
  } catch (error) {
    return '0.0.0'
  }
}

export const inject = ['webServer']

/** Route prefix; every route below lives under it. */
export const PREFIX = '/dsh-restart-refresh'

const MAX_BODY = 4096
const RELOAD_TIMEOUT_MS = 8000

/** Settings a fresh install starts with. */
export const SETTINGS_DEFAULTS = Object.freeze({
  /** Ask before the power button closes and reopens the app. */
  confirmRestart: true,
  /** Ask before replacing running plugin code. */
  confirmReload: false,
  /** Rebuild the page once plugin code has been replaced. */
  rebuildAfterReload: true,
})

const BOOLEAN_KEYS = Object.keys(SETTINGS_DEFAULTS)

/**
 * The helper runs after the HTTP response, outside the Host process, so it
 * survives the shutdown it performs. It waits for the toast to reach the page,
 * asks the window to close (the shell then saves state and stops the Host
 * cleanly), falls back to a hard stop, and starts the same executable again.
 */
const HELPER = `param(
  [Parameter(Mandatory=$true)][int]$MainPid,
  [Parameter(Mandatory=$true)][int]$HostPid,
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$Cwd,
  [Parameter(Mandatory=$true)][string]$Log,
  [Parameter(Mandatory=$true)][ValidateSet('restart','quit')][string]$Mode
)
$ErrorActionPreference = 'Continue'
function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format o), $Message
  try { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 } catch { }
}
function Test-Alive([int]$Id) {
  try { return [bool](Get-Process -Id $Id -ErrorAction Stop) } catch { return $false }
}
$started = Get-Date
Write-Log ("{0} requested: main={1} host={2} exe={3}" -f $Mode, $MainPid, $HostPid, $Exe)
# The Host runs with ELECTRON_RUN_AS_NODE=1; children inherit it, and an app
# started with that variable becomes a Node process instead of a window: it
# exits with code 0 straight away. That is why every launch looked like it
# silently died. Strip it (and the console opt-out) before starting anything.
if ($env:ELECTRON_RUN_AS_NODE) { Write-Log 'cleared ELECTRON_RUN_AS_NODE for the child' }
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
# Just long enough for the reply to reach the page before the window goes away.
Start-Sleep -Milliseconds 250
if (-not (Test-Path -LiteralPath $Exe)) { Write-Log 'abort: executable is missing'; exit 1 }
$name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
# PIDs are recycled by Windows. Before this script touches anything, prove that
# $MainPid really is the shell we are about to replace — otherwise a stale pid
# would make us close (and kill) whatever app inherited the number. $HostPid is
# the Host the caller was running in, so it must be a child of $MainPid.
$mainInfo = $null
try { $mainInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $MainPid) -ErrorAction Stop } catch { }
if (-not $mainInfo) { Write-Log ("abort: main process {0} is gone" -f $MainPid); exit 1 }
$mainPath = $null
try { $mainPath = [string]$mainInfo.ExecutablePath } catch { }
if (-not $mainPath) { Write-Log ("abort: cannot read the image path of {0}" -f $MainPid); exit 1 }
$same = [string]::Equals([System.IO.Path]::GetFullPath($mainPath), [System.IO.Path]::GetFullPath($Exe), [System.StringComparison]::OrdinalIgnoreCase)
if (-not $same) {
  Write-Log ("abort: pid {0} runs {1}, not {2}" -f $MainPid, $mainPath, $Exe)
  exit 1
}
$hostInfo = $null
try { $hostInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $HostPid) -ErrorAction Stop } catch { }
if ($hostInfo -and ([int]$hostInfo.ParentProcessId -ne $MainPid)) {
  Write-Log ("abort: host {0} is not a child of {1}" -f $HostPid, $MainPid)
  exit 1
}
# Quit and restart both try the graceful road first: let the shell run its own
# shutdown (stop the Host, save state, dispose the tray). A bare close does not
# work — the shell turns it into "hide to tray" — but once the window has seen
# the session-end messages it lets the close through, and then
# window-all-closed reaches app.quit() with the quit prompt skipped. That path
# also avoids the Windows "ding" that a force kill rings on a GUI process.
$graceful = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshGraceful
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const uint WM_QUERYENDSESSION = 0x0011;
    private const uint WM_ENDSESSION = 0x0016;
    private const uint WM_CLOSE = 0x0010;

    public static int Shutdown(int processId)
    {
        var all = new List<IntPtr>();
        var visible = new List<IntPtr>();
        EnumWindows((handle, state) =>
        {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId)
            {
                all.Add(handle);
                if (IsWindowVisible(handle)) visible.Add(handle);
            }
            return true;
        }, IntPtr.Zero);

        foreach (var handle in all)
        {
            PostMessage(handle, WM_QUERYENDSESSION, IntPtr.Zero, (IntPtr)1);
            PostMessage(handle, WM_ENDSESSION, (IntPtr)1, (IntPtr)1);
        }
        foreach (var handle in visible) PostMessage(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return all.Count;
    }
}
'@
  $asked = 0
  try {
    Add-Type -TypeDefinition $graceful -ErrorAction Stop
    $asked = [DshGraceful]::Shutdown($MainPid)
    Write-Log ("{0}: asked {1} window(s) of main {2} to end the session" -f $Mode, $asked, $MainPid)
  } catch {
    Write-Log ("{0}: graceful shutdown unavailable: {1}" -f $Mode, $_.Exception.Message)
  }
  if ($asked -gt 0) {
    for ($tick = 0; $tick -lt 20; $tick++) {
      Start-Sleep -Milliseconds 400
      if (-not (Test-Alive $MainPid)) { break }
    }
    if (-not (Test-Alive $MainPid)) {
      Start-Sleep -Milliseconds 400
      if (Test-Alive $HostPid) {
        & taskkill.exe /F /PID $HostPid 2>&1 | Out-Null
        Write-Log ("{0}: the Host outlived the shell; stopped it" -f $Mode)
      }
      if ($Mode -eq 'quit') {
        Write-Log ("done: quit gracefully in {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
        exit 0
      }
      Write-Log ("{0}: shell exited gracefully in {1:N1}s; relaunching" -f $Mode, ((Get-Date) - $started).TotalSeconds)
    } else {
      Write-Log ("{0}: graceful shutdown timed out; falling back to a force stop" -f $Mode)
    }
  }
# Asking the window to close is not worth the wait: the shell treats it as
# minimise-to-tray, so we would sit out the timeout and force-stop anyway.
if (Test-Alive $HostPid) { & taskkill.exe /F /PID $HostPid 2>&1 | Out-Null }
if (Test-Alive $MainPid) {
  & taskkill.exe /F /PID $MainPid 2>&1 | Out-Null
  Write-Log 'stopped main'
}
try { Wait-Process -Id $MainPid -Timeout 4 -ErrorAction Stop } catch { }
# The shell's own children (MCP servers, speech worker, …) outlive a force kill
# and would still be around for the next instance; this helper is reached
# through wscript, which is skipped below, so the sweep cannot hit itself.
function Stop-Children([int]$RootId) {
  $skip = @('powershell.exe', 'wscript.exe', 'conhost.exe')
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootId" -ErrorAction SilentlyContinue)) {
    if ($skip -contains $child.Name) { continue }
    # The billion-context proxy is a long-lived daemon shared across restarts:
    # killing it would stall the next instance while it boots its own.
    if ($child.CommandLine -and $child.CommandLine.Contains('billion-context')) { continue }
    Stop-Children $child.ProcessId
    try { Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop } catch { }
    Write-Log ("stopped leftover {0} ({1})" -f $child.Name, $child.ProcessId)
  }
}
try { Stop-Children $HostPid } catch { }
try { Stop-Children $MainPid } catch { }
# The renderer/GPU/utility children of the killed shell keep the app's
# single-instance mutex alive, and a fresh launch would then see "already
# running" and exit immediately (that is why the window never came back). Sweep
# them as well — this helper is a PowerShell process, so it is not matched here.
for ($round = 0; $round -lt 12; $round++) {
  $left = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  if ($left.Count -eq 0) { break }
  foreach ($item in $left) { try { Stop-Process -Id $item.Id -Force -ErrorAction Stop } catch { } }
  Write-Log ("swept {0} leftover process(es)" -f $left.Count)
  Start-Sleep -Milliseconds 300
}
if ($Mode -ne 'restart') {
  Write-Log ("done: quit in {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)
  exit 0
}
# Let the single-instance lock go before the next launch asks for it.
Start-Sleep -Milliseconds 400
# A second instance exits at once (exit code 0) while another copy is still
# registered, so keep trying for a while: a slow lock release used to look like
# "the app just closed".
$ok = $false
for ($round = 1; $round -le 10 -and -not $ok; $round++) {
  $proc = $null
  try {
    $proc = Start-Process -FilePath $Exe -WorkingDirectory $Cwd -PassThru
  } catch {
    Write-Log ("round {0}: start threw {1}" -f $round, $_.Exception.Message)
  }
  if ($proc) {
    for ($tick = 0; $tick -lt 6; $tick++) {
      Start-Sleep -Milliseconds 400
      $live = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
      if ($live.Count -gt 0) {
        $ids = ($live | ForEach-Object { $_.Id }) -join ','
        Write-Log ("relaunched on round {0} in {1:N1}s pids={2}" -f $round, ((Get-Date) - $started).TotalSeconds, $ids)
        $ok = $true
        break
      }
      if ($proc.HasExited) {
        Write-Log ("round {0}: pid {1} exited with {2}" -f $round, $proc.Id, $proc.ExitCode)
        break
      }
    }
  }
  if (-not $ok) {
    # Sweep anything the failed attempt left behind, then wait for the lock.
    foreach ($item in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $item.Id -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Milliseconds 900
  }
}
if ($ok) { exit 0 }
# Last resort: let the shell start it the way a double-click on the icon would.
Write-Log 'fallback: launching through explorer'
try { & explorer.exe $Exe } catch { Write-Log ("explorer throw: {0}" -f $_.Exception.Message) }
for ($tick = 0; $tick -lt 20; $tick++) {
  Start-Sleep -Milliseconds 500
  $live = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  if ($live.Count -gt 0) {
    $ids = ($live | ForEach-Object { $_.Id }) -join ','
    Write-Log ("relaunched via explorer in {0:N1}s pids={1}" -f ((Get-Date) - $started).TotalSeconds, $ids)
    exit 0
  }
}
# Nothing is running: record why, so the log explains itself next time.
try {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $started } -ErrorAction Stop |
    Where-Object { $_.LevelDisplayName -in @('Error', 'Critical') } |
    Select-Object -First 5 |
    ForEach-Object { Write-Log ("event: {0} {1}" -f $_.ProviderName, ($_.Message -split [Environment]::NewLine)[0]) }
} catch { }
Write-Log 'abort: could not relaunch'
exit 1
`

/**
 * `wscript.exe` runs the helper with window style 0, so nothing flashes on
 * screen: a console host (`cmd`/`powershell`) would always paint a window for a
 * moment, and PowerShell spawned detached from the Host never runs at all.
 */
export function buildLauncher(scriptPath, params) {
  const line = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${scriptPath}"`,
    '-MainPid',
    String(params.mainPid),
    '-HostPid',
    String(params.hostPid),
    '-Exe',
    `"${params.exe}"`,
    '-Cwd',
    `"${params.cwd}"`,
    '-Log',
    `"${params.log}"`,
    '-Mode',
    params.mode,
  ].join(' ')
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${line.replace(/"/g, '""')}", 0, False\r\n`
}

/**
 * Windows PowerShell 5.1 decodes a BOM-less `.ps1` as ANSI, so any path with a
 * non-ASCII user name or install directory turns into a different path and the
 * helper dies with `DirectoryNotFoundException`. A UTF-8 BOM pins the decoding.
 */
export function utf8WithBom(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
}

/**
 * WScript reads a BOM-less `.vbs` as ANSI as well, and the launcher embeds the
 * executable path — a profile named `张三` would launch a path that does not
 * exist. UTF-16LE with a BOM makes WScript decode it as Unicode.
 */
export function utf16leWithBom(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** Image name (no directory) used to compare the parent process with ours. */
function imageName(path) {
  const value = String(path ?? '')
  const cut = value.lastIndexOf('\\')
  return (cut === -1 ? value : value.slice(cut + 1)).toLowerCase()
}

/**
 * Whether this process is the desktop app's Host: only then does a "restart"
 * mean "close the app and open it again". In `dsh web` the parent is the
 * terminal that started the server — killing it would be destructive and could
 * not be undone from the page.
 *
 * The cheap part (platform + an Electron binary) runs every request; the
 * decisive part (the parent's image is our own executable) reads `tasklist`
 * once, when someone actually presses the button.
 */
export function desktopSupport(env = process) {
  const platform = env.platform ?? process.platform
  if (platform !== 'win32') return { ok: false, reason: 'platform' }
  const versions = env.versions ?? {}
  if (typeof versions.electron !== 'string') return { ok: false, reason: 'not-electron' }
  return { ok: true, reason: '' }
}

/**
 * @param parentImageOf - Resolves the parent process image name (`run` seam for
 *   tests); returns `undefined` when it cannot be read.
 */
export async function parentIsApp(ppid, execPath, parentImageOf) {
  const expected = imageName(execPath)
  const actual = await parentImageOf(ppid)
  if (typeof actual !== 'string' || actual.length === 0) return false
  return imageName(actual) === expected
}

/** Reads a process image name through `tasklist`, or `undefined` if it cannot. */
export function parentImageOf(pid, execFileAsync) {
  return execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    .then(({ stdout }) => {
      const line = String(stdout ?? '').trim()
      if (line === '') return undefined
      const field = line.slice(line.indexOf('"') + 1, line.indexOf('"', line.indexOf('"') + 1))
      return field === '' ? undefined : field
    })
    .catch(() => undefined)
}


function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Same-origin check for a state-changing request from the page. */
function trusted(req) {
  const headers = req.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== headers.host) return false
    } catch {
      return false
    }
  }
  return true
}

async function drain(req) {
  if (req === null || typeof req !== 'object' || typeof req[Symbol.asyncIterator] !== 'function') return ''
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Keep only known booleans; unknown keys and wrong types fall back to the default. */
export function normalizeSettings(value) {
  const settings = { ...SETTINGS_DEFAULTS }
  if (value === null || typeof value !== 'object') return settings
  for (const key of BOOLEAN_KEYS) {
    const given = value[key]
    if (typeof given === 'boolean') settings[key] = given
  }
  return settings
}

/**
 * Settings live in one JSON file next to the other DSH state, so they survive
 * restarts; a broken or missing file is not an error, it is the defaults.
 */
export function createSettingsStore(deps) {
  const { file, readText = readFile, writeText = writeFile } = deps
  let cache = null
  return {
    async read() {
      if (cache !== null) return cache
      try {
        cache = normalizeSettings(JSON.parse(await readText(file, 'utf8')))
      } catch {
        cache = { ...SETTINGS_DEFAULTS }
      }
      return cache
    },
    async patch(given) {
      const current = await this.read()
      cache = normalizeSettings({ ...current, ...(given ?? {}) })
      try {
        await writeText(file, JSON.stringify(cache, null, 2), 'utf8')
      } catch {
        // Keep the in-memory copy: a read-only home is not worth failing the press.
      }
      return cache
    },
  }
}

/**
 * @param deps - The process facts a restart needs, injectable so the route can
 *   be checked offline: `execPath` (the desktop executable), `pid` (Host),
 *   `ppid` (Electron main), `workDir`, `scriptPath`, `logPath`, `support`
 *   (see `desktopSupport`), `parentCheck` (async parent-image check), and
 *   `spawnProcess`/`writeScript` seams. The scripts are written with the byte
 *   order marks Windows needs (`utf8WithBom`, `utf16leWithBom`).
 */
export function createRestartHandler(deps) {
  const {
    execPath,
    pid,
    ppid,
    workDir,
    scriptPath,
    logPath,
    mode = 'restart',
    support = { ok: true, reason: '' },
    parentCheck = null,
    spawnProcess = spawn,
    writeScript = writeFile,
  } = deps

  return async function handleRestart(req, res) {
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, code: 'method', message: '只接受 POST' })
      return
    }
    if (!trusted(req)) {
      reply(res, 403, { ok: false, code: 'origin', message: '请求来源不被信任' })
      return
    }
    try {
      await drain(req)
    } catch (error) {
      reply(res, 400, { ok: false, code: 'body', message: error.message })
      return
    }
    if (!Number.isInteger(ppid) || ppid <= 0 || !Number.isInteger(pid) || pid <= 0) {
      reply(res, 409, { ok: false, code: 'not-desktop', message: '找不到桌面端进程，无法自动重启' })
      return
    }
    if (!support.ok) {
      reply(res, 409, {
        ok: false,
        code: 'not-desktop',
        message: support.reason === 'platform' ? '只有 Windows 桌面端能重启应用' : '只有桌面端能重启应用',
      })
      return
    }
    // The decisive check: the parent must be this very executable. In `dsh web`
    // the parent is the terminal that started the server.
    if (typeof parentCheck === 'function' && !(await parentCheck())) {
      reply(res, 409, {
        ok: false,
        code: 'not-desktop',
        message: '当前不是桌面端进程，无法重启应用',
      })
      return
    }
    try {
      await writeScript(scriptPath, utf8WithBom(HELPER))
      const launcherPath = scriptPath.replace(/\.ps1$/i, '.vbs')
      await writeScript(
        launcherPath,
        utf16leWithBom(
          buildLauncher(scriptPath, {
            mainPid: ppid,
            hostPid: pid,
            exe: execPath,
            cwd: workDir,
            log: logPath,
            mode,
          }),
        ),
      )
      // `wscript` is a GUI executable, so the helper never flashes a console;
      // it returns at once and PowerShell outlives the Host it stops.
      const helper = spawnProcess('wscript.exe', ['//nologo', '//B', launcherPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      if (helper && typeof helper.unref === 'function') helper.unref()
      reply(res, 200, { ok: true, mode, mainPid: ppid, hostPid: pid, exe: execPath, log: logPath })
    } catch (error) {
      reply(res, 500, { ok: false, code: 'spawn', message: error.message })
    }
  }
}

/**
 * Replaces the running plugin code with what is on disk, without a restart.
 * `reconcileProfile` must run inside `runExclusive`, and the call is serialized
 * with every other HMR transaction, so a second press waits rather than races.
 *
 * @param deps - `getHmr` returns the `hmr` service (or undefined off-desktop and
 *   in plain `dsh web`, where nothing can be recomposed).
 */
export function createReloadHandler(deps) {
  const { getHmr, timeoutMs = RELOAD_TIMEOUT_MS, reconciliation = null } = deps
  let running = null

  return async function handleReload(req, res) {
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, code: 'method', message: '只接受 POST' })
      return
    }
    if (!trusted(req)) {
      reply(res, 403, { ok: false, code: 'origin', message: '请求来源不被信任' })
      return
    }
    try {
      await drain(req)
    } catch (error) {
      reply(res, 400, { ok: false, code: 'body', message: error.message })
      return
    }
    const hmr = getHmr()
    if (
      hmr === undefined ||
      hmr === null ||
      typeof hmr.runExclusive !== 'function' ||
      typeof hmr.reconcileProfile !== 'function'
    ) {
      reply(res, 409, {
        ok: false,
        code: 'no-hmr',
        message: '这台机器没有可用的热替换服务，改动插件代码后请重启应用',
      })
      return
    }
    if (running !== null) {
      reply(res, 202, { ok: true, code: 'busy', message: '上一次换代码还在进行，稍后再试' })
      return
    }

    const job =
      reconciliation !== null
        ? Promise.resolve(reconciliation)
        : hmr.runExclusive(() => hmr.reconcileProfile([]))
    running = job
    job.then(
      () => {
        if (running === job) running = null
      },
      () => {
        if (running === job) running = null
      },
    )

    let timer = null
    try {
      const settled = await Promise.race([
        job.then((value) => ({ done: true, value })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ done: false }), timeoutMs)
        }),
      ])
      if (!settled.done) {
        reply(res, 202, { ok: true, code: 'slow', message: '换代码还没结束，稍后再刷新页面看看' })
        return
      }
      const result = settled.value ?? {}
      reply(res, 200, {
        ok: true,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        pending: Array.isArray(result.pending) ? result.pending : [],
        restartReason: result.restartReason ?? null,
      })
    } catch (error) {
      reply(res, 500, { ok: false, code: 'reload', message: String(error?.message ?? error) })
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/** Settings read (GET) and write (POST) for the settings page. */
export function createSettingsHandler(store) {
  return async function handleSettings(req, res) {
    if (req.method === 'GET') {
      reply(res, 200, { ok: true, settings: await store.read() })
      return
    }
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, code: 'method', message: '只接受 GET 或 POST' })
      return
    }
    if (!trusted(req)) {
      reply(res, 403, { ok: false, code: 'origin', message: '请求来源不被信任' })
      return
    }
    let body
    try {
      const text = await drain(req)
      body = text.trim() === '' ? {} : JSON.parse(text)
    } catch (error) {
      reply(res, 400, { ok: false, code: 'body', message: error.message })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      reply(res, 400, { ok: false, code: 'body', message: '请求体必须是对象' })
      return
    }
    reply(res, 200, { ok: true, settings: await store.patch(body) })
  }
}

/** Everything the client half needs to draw its buttons. */
export function createStateHandler(deps) {
  const { store, pid, ppid, version, logPath, hasHmr, support = { ok: true, reason: '' } } = deps
  return async function handleState(req, res) {
    if (req.method !== 'GET') {
      reply(res, 405, { ok: false, code: 'method', message: '只接受 GET' })
      return
    }
    const alive = Number.isInteger(ppid) && ppid > 0 && Number.isInteger(pid) && pid > 0
    // Asked per request: the `hmr` service may be applied after this plugin.
    const hmr = typeof hasHmr === 'function' ? hasHmr() : hasHmr
    reply(res, 200, {
      ok: true,
      version,
      desktop: Boolean(alive && support.ok),
      desktopReason: alive ? support.reason : 'no-process',
      hmr: Boolean(hmr),
      settings: await store.read(),
      log: logPath,
    })
  }
}

export function apply(ctx) {
  const execPath = process.execPath
  const pid = process.pid
  const ppid = process.ppid
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logPath = join(tmpdir(), 'dsh-restart-refresh.log')
  const store = createSettingsStore({ file: join(home, 'dsh-restart-refresh.json') })
  const support = desktopSupport(process)
  const checkParent = () => parentIsApp(ppid, execPath, (target) => parentImageOf(target, execFileAsync))
  const getHmr = () => (typeof ctx.get === 'function' ? ctx.get('hmr') : undefined)
  const hasHmr = () => {
    const hmr = getHmr()
    return hmr !== undefined && hmr !== null && typeof hmr.reconcileProfile === 'function'
  }

  /** @param path - Absolute route path, registered once and disposed with the plugin. */
  const route = (path, handler) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `dsh-restart-refresh: ${path}`,
    )

  const lifecycle = (mode) =>
    createRestartHandler({
      mode,
      execPath,
      pid,
      ppid,
      workDir: dirname(execPath),
      scriptPath: join(tmpdir(), `dsh-restart-refresh-${mode}.ps1`),
      logPath,
      support,
      parentCheck: checkParent,
    })

  route(`${PREFIX}/restart`, lifecycle('restart'))
  route(`${PREFIX}/quit`, lifecycle('quit'))
  route(`${PREFIX}/reload`, createReloadHandler({ getHmr }))
  route(`${PREFIX}/settings`, createSettingsHandler(store))
  route(
    `${PREFIX}/state`,
    createStateHandler({
      store,
      pid,
      ppid,
      version: pluginVersion(),
      logPath,
      hasHmr,
      support,
    }),
  )
  // A marker per start, so "it feels slow" can be measured instead of guessed:
  // this line lands as soon as the Host has this plugin loaded.
  const uptime = typeof process.uptime === 'function' ? process.uptime() : null
  const readyAt = new Date().toISOString()
  appendFile(
    logPath,
    `${readyAt} host ready: plugin applied after ${uptime === null ? '?' : uptime.toFixed(2)}s of Host uptime\n`,
  ).catch(() => {})
}
