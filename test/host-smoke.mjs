/**
 * Offline checks for the Host half.
 *
 * Every route is built through an injectable factory, so this file drives them
 * with fake requests instead of a live Host: no process is spawned, no file is
 * written outside a temp directory, and no plugin is recomposed.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  createReloadHandler,
  createRestartHandler,
  createSettingsHandler,
  createSettingsStore,
  createStateHandler,
  desktopSupport,
  normalizeSettings,
  parentIsApp,
  SETTINGS_DEFAULTS,
  utf16leWithBom,
  utf8WithBom,
} from '../index.js'

function makeRequest(method, options = {}) {
  const { headers = {}, body = null } = options
  const chunks = body === null ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    headers: { host: '127.0.0.1:52409', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
  }
}

function json(res) {
  return JSON.parse(res.state.body)
}

async function call(handler, method, options) {
  const res = makeResponse()
  await handler(makeRequest(method, options), res)
  return res
}

let checks = 0
const ok = (condition, message) => {
  checks += 1
  assert.ok(condition, message)
}

// ---------------------------------------------------------------- settings store

{
  const home = await mkdtemp(join(tmpdir(), 'dsh-restart-refresh-'))
  try {
    const file = join(home, 'dsh-restart-refresh.json')
    const store = createSettingsStore({ file })
    assert.deepEqual(await store.read(), SETTINGS_DEFAULTS)

    const patched = await store.patch({ confirmRestart: false, junk: 1, confirmReload: 'yes' })
    ok(patched.confirmRestart === false, 'patch applies a known boolean')
    ok(patched.confirmReload === false, 'a non-boolean leaves the default')
    ok(!('junk' in patched), 'unknown keys are dropped')

    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    ok(onDisk.confirmRestart === false, 'patch is persisted')

    const again = createSettingsStore({ file })
    assert.deepEqual(await again.read(), patched)

    // A broken file is not an error: it is the defaults.
    await rm(file)
    const broken = createSettingsStore({ file })
    assert.deepEqual(await broken.read(), SETTINGS_DEFAULTS)

    assert.deepEqual(normalizeSettings(null), SETTINGS_DEFAULTS)
    assert.deepEqual(normalizeSettings([1, 2]), SETTINGS_DEFAULTS)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- settings route

{
  const home = await mkdtemp(join(tmpdir(), 'dsh-restart-refresh-'))
  try {
    const handler = createSettingsHandler(createSettingsStore({ file: join(home, 's.json') }))

    const read = await call(handler, 'GET')
    ok(read.state.status === 200, 'GET settings answers 200')
    assert.deepEqual(json(read).settings, SETTINGS_DEFAULTS)

    const write = await call(handler, 'POST', {
      body: JSON.stringify({ rebuildAfterReload: false }),
    })
    ok(write.state.status === 200, 'POST settings answers 200')
    ok(json(write).settings.rebuildAfterReload === false, 'POST settings persists')

    const crossSite = await call(handler, 'POST', {
      headers: { 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    ok(crossSite.state.status === 403, 'cross-site settings write is refused')

    const badOrigin = await call(handler, 'POST', {
      headers: { origin: 'https://evil.example' },
      body: '{}',
    })
    ok(badOrigin.state.status === 403, 'foreign origin is refused')

    const badJson = await call(handler, 'POST', { body: '{' })
    ok(badJson.state.status === 400, 'malformed JSON is refused')

    const arrayBody = await call(handler, 'POST', { body: '[1]' })
    ok(arrayBody.state.status === 400, 'a non-object body is refused')

    const wrongMethod = await call(handler, 'PUT')
    ok(wrongMethod.state.status === 405, 'other methods answer 405')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- restart route

{
  const spawned = []
  const written = []
  const handler = createRestartHandler({
    execPath: 'C:\\Program Files\\DSH\\DSH.exe',
    pid: 4321,
    ppid: 1234,
    workDir: 'C:\\Program Files\\DSH',
    scriptPath: 'C:\\Temp\\dsh-restart-refresh-restart.ps1',
    logPath: 'C:\\Temp\\dsh-restart-refresh-restart.log',
    writeScript: async (path, data) => {
      written.push({ path, buffer: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
    },
    spawnProcess: (file, args, options) => {
      spawned.push({ file, args, options })
      return { unref() {} }
    },
  })

  const good = await call(handler, 'POST', { body: '{}' })
  ok(good.state.status === 200, 'restart answers 200')
  ok(json(good).ok === true, 'restart reports ok')
  ok(spawned.length === 1, 'one helper is launched')
  ok(spawned[0].file === 'wscript.exe', 'the launcher is a GUI host, so no console window can appear')
  const args = spawned[0].args
  ok(args.includes('//B'), 'wscript runs in batch mode without a banner')
  ok(args.some((a) => String(a).endsWith('.vbs')), 'wscript runs the generated .vbs launcher')
  ok(spawned[0].options.detached === true, 'the helper is detached')
  ok(spawned[0].options.windowsHide === true, 'no window flag is set')
  ok(written.length === 2, 'the PowerShell script and the VBS launcher are both written')
  const ps1 = written.find((item) => item.path.endsWith('.ps1'))
  const vbs = written.find((item) => item.path.endsWith('.vbs'))
  const ps1Text = ps1.buffer.toString('utf8')
  const vbsText = vbs.buffer.toString('utf16le')
  ok(ps1.buffer[0] === 0xef && ps1.buffer[1] === 0xbb && ps1.buffer[2] === 0xbf, 'the .ps1 starts with a UTF-8 BOM so 5.1 stops reading it as ANSI')
  ok(vbs.buffer[0] === 0xff && vbs.buffer[1] === 0xfe, 'the .vbs starts with a UTF-16LE BOM so WScript decodes it as Unicode')
  ok(ps1Text.includes('taskkill.exe /F /PID $MainPid'), 'the script force-stops the main process')
  ok(!ps1Text.includes('CloseMainWindow'), 'no graceful-close wait: the shell only hides to tray')
  ok(ps1Text.includes('WM_QUERYENDSESSION'), 'the script asks the window to end the session first')
  ok(ps1Text.includes('WM_ENDSESSION'), 'the session-end message makes the shell allow the close')
  ok(ps1Text.includes('WM_CLOSE'), 'the script then closes the window so the shell can quit')
  ok(ps1Text.includes('DshGraceful'), 'the graceful helper is compiled on demand')
  ok(ps1Text.includes('Win32_Process'), 'the script looks the main pid up before touching it')
  ok(ps1Text.includes('runs {1}, not {2}'), 'a recycled pid is refused instead of being closed')
  ok(ps1Text.includes('is not a child of'), 'the host must be a child of the shell it came from')
  ok(ps1Text.includes('graceful shutdown timed out; falling back to a force stop'), 'the force stop stays as the fallback')
  ok(!ps1Text.includes("if ($Mode -eq 'quit') {\n  $graceful"), 'both modes take the graceful road')
  ok(ps1Text.includes('Start-Process -FilePath $Exe'), 'the script relaunches the app')
  ok(ps1Text.includes('Get-Process -Name $name'), 'the script checks the relaunch actually stuck')
  ok(vbsText.includes('shell.Run'), 'the launcher calls shell.Run')
  ok(vbsText.includes(', 0, False'), 'the launcher hides the window and does not wait')
  ok(vbsText.includes('-MainPid 1234'), 'main pid is embedded')
  ok(vbsText.includes('-HostPid 4321'), 'host pid is embedded')
  ok(vbsText.includes('""C:\\Program Files\\DSH\\DSH.exe""'), 'the executable is quoted for cmd parsing')
  ok(vbsText.includes('-Mode restart'), 'restart passes its mode')

  // The quit route is the same helper, minus the relaunch step.
  const quitSpawned = []
  const quitWritten = []
  const quitHandler = createRestartHandler({
    mode: 'quit',
    execPath: 'C:\\Program Files\\DSH\\DSH.exe',
    pid: 4321,
    ppid: 1234,
    workDir: 'C:\\Program Files\\DSH',
    scriptPath: 'C:\\Temp\\dsh-restart-refresh-quit.ps1',
    logPath: 'C:\\Temp\\dsh-restart-refresh-restart.log',
    writeScript: async (path, data) => {
      quitWritten.push({ path, buffer: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
    },
    spawnProcess: (file, argv, options) => {
      quitSpawned.push({ file, argv, options })
      return { unref() {} }
    },
  })
  const quit = await call(quitHandler, 'POST', { body: '{}' })
  ok(quit.state.status === 200, 'quit answers 200')
  ok(json(quit).mode === 'quit', 'quit reports its mode')
  ok(quitSpawned[0].file === 'wscript.exe', 'quit uses the same hidden launcher')
  const quitVbs = quitWritten.find((item) => item.path.endsWith('.vbs'))
  ok(quitVbs.buffer.toString('utf16le').includes('-Mode quit'), 'quit passes its mode to the helper')

  const emptyBody = await call(handler, 'POST')
  ok(emptyBody.state.status === 200, 'an empty body is fine')

  const get = await call(handler, 'GET')
  ok(get.state.status === 405, 'GET restart answers 405')

  const crossSite = await call(handler, 'POST', { headers: { 'sec-fetch-site': 'cross-site' } })
  ok(crossSite.state.status === 403, 'cross-site restart is refused')

  const badOrigin = await call(handler, 'POST', { headers: { origin: 'https://evil.example' } })
  ok(badOrigin.state.status === 403, 'foreign origin restart is refused')

  const big = await call(handler, 'POST', { body: 'x'.repeat(5000) })
  ok(big.state.status === 400, 'an oversized body is refused')

  const notDesktop = createRestartHandler({
    execPath: 'node',
    pid: 1,
    ppid: 0,
    workDir: '/',
    scriptPath: 'x',
    logPath: 'y',
    writeScript: async () => {},
    spawnProcess: () => ({ unref() {} }),
  })
  const refused = await call(notDesktop, 'POST', { body: '{}' })
  ok(refused.state.status === 409, 'no desktop parent answers 409')

  const broken = createRestartHandler({
    execPath: 'node',
    pid: 2,
    ppid: 1,
    workDir: '/',
    scriptPath: 'x',
    logPath: 'y',
    writeScript: async () => {},
    spawnProcess: () => {
      throw new Error('spawn failed')
    },
  })
  const failed = await call(broken, 'POST', { body: '{}' })
  ok(failed.state.status === 500, 'a spawn failure answers 500')
}

// ---------------------------------------------------------------- reload route

{
  const calls = []
  const hmr = {
    runExclusive(operation) {
      calls.push('runExclusive')
      return operation()
    },
    async reconcileProfile(ids) {
      calls.push(['reconcileProfile', ids])
      return { warnings: ['w'], pending: ['p'], restartReason: undefined }
    },
  }
  const handler = createReloadHandler({ getHmr: () => hmr })
  const res = await call(handler, 'POST', { body: '{}' })
  ok(res.state.status === 200, 'reload answers 200')
  const body = json(res)
  ok(body.ok === true, 'reload reports ok')
  assert.deepEqual(body.warnings, ['w'])
  assert.deepEqual(body.pending, ['p'])
  ok(body.restartReason === null, 'no restart reason becomes null')
  assert.deepEqual(calls, ['runExclusive', ['reconcileProfile', []]], 'reload goes through runExclusive')

  const restart = createReloadHandler({
    getHmr: () => ({
      runExclusive: (operation) => operation(),
      reconcileProfile: async () => ({ warnings: [], pending: [], restartReason: 'package-moved' }),
    }),
  })
  const moving = json(await call(restart, 'POST', { body: '{}' }))
  ok(moving.restartReason === 'package-moved', 'a restart reason is passed through')

  const missing = json(
    await call(createReloadHandler({ getHmr: () => undefined }), 'POST', { body: '{}' }),
  )
  ok(missing.ok === false && missing.code === 'no-hmr', 'a host without hmr answers no-hmr')

  const noHmrStatus = await call(createReloadHandler({ getHmr: () => null }), 'POST', { body: '{}' })
  ok(noHmrStatus.state.status === 409, 'a host without hmr answers 409')

  const nested = await call(
    createReloadHandler({
      getHmr: () => ({
        runExclusive: () => Promise.reject(new Error('HMR transactions cannot be nested')),
        reconcileProfile: async () => ({}),
      }),
    }),
    'POST',
    { body: '{}' },
  )
  ok(nested.state.status === 500, 'a failing recomposition answers 500')

  // A press while one recomposition is still running must not queue a second.
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let started = 0
  const serial = createReloadHandler({
    getHmr: () => ({
      runExclusive: (operation) => {
        started += 1
        return gate.then(operation)
      },
      reconcileProfile: async () => ({ warnings: [], pending: [] }),
    }),
    timeoutMs: 200,
  })
  const first = call(serial, 'POST', { body: '{}' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await call(serial, 'POST', { body: '{}' })
  ok(second.state.status === 202, 'a press during a swap answers 202')
  ok(json(second).code === 'busy', 'the second press says busy')
  ok(started === 1, 'the second press does not start a second swap')
  release()
  const firstRes = await first
  ok(firstRes.state.status === 200, 'the first press still lands')

  // A swap that outlives the wait answers 202 instead of hanging the page.
  const slow = createReloadHandler({
    getHmr: () => ({
      runExclusive: (operation) => new Promise((resolve) => setTimeout(() => resolve(operation()), 60)),
      reconcileProfile: async () => ({ warnings: [], pending: [] }),
    }),
    timeoutMs: 20,
  })
  const slowRes = await call(slow, 'POST', { body: '{}' })
  ok(slowRes.state.status === 202, 'a slow swap answers 202')
  ok(json(slowRes).code === 'slow', 'the slow answer says slow')
}

// ---------------------------------------------------------------- state route

{
  const home = await mkdtemp(join(tmpdir(), 'dsh-restart-refresh-'))
  try {
    const store = createSettingsStore({ file: join(home, 's.json') })
    const handler = createStateHandler({
      store,
      pid: 4321,
      ppid: 1234,
      version: '0.3.0',
      logPath: 'C:\\Temp\\log.txt',
      hasHmr: () => true,
    })
    const res = await call(handler, 'GET')
    ok(res.state.status === 200, 'state answers 200')
    const body = json(res)
    ok(body.desktop === true, 'state reports a desktop host')
    ok(body.hmr === true, 'state reports the hmr service')
    ok(body.version === '0.3.0', 'state reports the version')
    assert.deepEqual(body.settings, SETTINGS_DEFAULTS)

    const web = createStateHandler({
      store,
      pid: 7,
      ppid: 0,
      version: '0.3.0',
      logPath: '',
      hasHmr: false,
    })
    const webBody = json(await call(web, 'GET'))
    ok(webBody.desktop === false, 'a dsh web host reports no desktop')
    ok(webBody.hmr === false, 'a dsh web host reports no hmr')
    ok(webBody.desktopReason === 'no-process', 'the refusal carries a reason')

    const foreign = createStateHandler({
      store,
      pid: 7,
      ppid: 8,
      version: '0.5.0',
      logPath: '',
      hasHmr: false,
      support: { ok: false, reason: 'platform' },
    })
    const foreignBody = json(await call(foreign, 'GET'))
    ok(foreignBody.desktop === false, 'a non-Windows host reports no desktop')
    ok(foreignBody.desktopReason === 'platform', 'the platform is named as the reason')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- portability

{
  ok(utf8WithBom('a')[0] === 0xef, 'utf8WithBom prefixes the UTF-8 BOM')
  ok(utf16leWithBom('a').length === 4, 'utf16leWithBom prefixes a BOM and encodes UTF-16LE')
  ok(utf16leWithBom('a').subarray(2).toString('utf16le') === 'a', 'the UTF-16 payload round-trips')

  ok(desktopSupport({ platform: 'linux', versions: { electron: '30' } }).ok === false, 'Linux is not a restartable desktop')
  ok(desktopSupport({ platform: 'win32', versions: {} }).ok === false, 'plain node on win32 is not the desktop shell')
  ok(desktopSupport({ platform: 'win32', versions: { electron: '30' } }).ok === true, 'the desktop Host is restartable')

  ok(await parentIsApp(1, 'C:\\App\\DSH.exe', async () => 'DSH.exe'), 'a parent with the same image name is the app')
  ok(!(await parentIsApp(1, 'C:\\App\\DSH.exe', async () => 'pwsh.exe')), 'a terminal parent is not the app')
  ok(!(await parentIsApp(1, 'C:\\App\\DSH.exe', async () => undefined)), 'an unreadable parent is refused')

  const quiet = []
  const refusedPlatform = createRestartHandler({
    execPath: 'C:\\App\\DSH.exe',
    pid: 2,
    ppid: 1,
    workDir: 'C:\\App',
    scriptPath: 'x.ps1',
    logPath: 'y.log',
    support: { ok: false, reason: 'platform' },
    writeScript: async () => {},
    spawnProcess: (file) => {
      quiet.push(file)
      return { unref() {} }
    },
  })
  const platformAnswer = await call(refusedPlatform, 'POST', { body: '{}' })
  ok(platformAnswer.state.status === 409, 'a non-Windows host refuses to restart')
  ok(json(platformAnswer).code === 'not-desktop', 'the refusal names not-desktop')

  const refusedParent = createRestartHandler({
    execPath: 'C:\\App\\DSH.exe',
    pid: 2,
    ppid: 1,
    workDir: 'C:\\App',
    scriptPath: 'x.ps1',
    logPath: 'y.log',
    parentCheck: async () => false,
    writeScript: async () => {},
    spawnProcess: (file) => {
      quiet.push(file)
      return { unref() {} }
    },
  })
  const parentAnswer = await call(refusedParent, 'POST', { body: '{}' })
  ok(parentAnswer.state.status === 409, 'a terminal parent refuses to restart')
  ok(quiet.length === 0, 'nothing is launched when the parent is wrong')
}

console.log(`all host-half checks passed (${checks} assertions)`)

// Applying the plugin with a stub context catches wiring mistakes a syntax check
// cannot see (a missing import once took the whole Host down at startup).
//
// This runs in a CHILD process with DSH_HOME pointed at a throw-away directory:
// mutating DSH_HOME in this process and then deleting it wiped the real
// ~/.dsh once. Only the directory this file created is ever removed.
{
  const home = await mkdtemp(join(tmpdir(), 'dsh-restart-refresh-apply-'))
  const script = `
    const routes = []
    const ctx = {
      effect(run) { const dispose = run(); return () => dispose?.() },
      webServer: { register(route) { routes.push(route.path); return () => {} } },
      get() { return undefined },
    }
    const plugin = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)})
    plugin.apply(ctx)
    process.stdout.write(JSON.stringify(routes))
  `
  const childEnv = { ...process.env, DSH_HOME: home, TEMP: home, TMP: home }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
  try {
    assert.equal(result.code, 0, `apply failed: ${result.err}`)
    assert.deepEqual(JSON.parse(result.out).sort(), [
      '/dsh-restart-refresh/quit',
      '/dsh-restart-refresh/reload',
      '/dsh-restart-refresh/restart',
      '/dsh-restart-refresh/settings',
      '/dsh-restart-refresh/state',
    ])
    ok(true, 'apply registers every route')
  } finally {
    // The child wrote its settings file inside `home`; remove only that path.
    await rm(home, { recursive: true, force: true })
  }
}

console.log(`apply wiring ok (${checks} assertions total)`)
