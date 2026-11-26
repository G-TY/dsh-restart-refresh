# DSH-restart-refresh 实现细节

三个图标，两件不同的事：**重启/退出**换掉整个 App 进程（宿主代码只有换进程才变），**刷新**用 HMR 换掉插件代码再重建页面。

## 一、为什么重启必须自己动手

宿主是壳（`app.asar` 里的 Electron 主进程）的子进程，壳里虽然有 `DesktopBackendController`（start/stop/状态发布）和 `DesktopFatalRecovery`（崩溃时弹「退出 / 重启 / 禁用第三方插件 / 获取诊断报告」），但都不对外开放：

- IPC 清单（`dsh-desktop:*`）里没有 restart / quit；
- `app.relaunch()` 只存在于主进程，两个调用点（更新安装的 `quitAndInstall`、崩溃恢复菜单）都不是页面能触发的；
- 正式版菜单里那条「重启应用与 Host」只在 `!app.isPackaged` 时存在；
- 宿主进程自己退出不会让壳自动重连，只会弹崩溃对话框等用户点。

插件能用的只有进程事实：宿主 `process.pid`、父进程 `process.ppid`（就是 Electron 主进程）、`process.execPath`（桌面端 exe）。所以只能**从外面把这对进程换掉**：

1. `index.js` 收到 `POST /dsh-restart-refresh/restart`（或 `/quit`）；
2. 把 `HELPER` 脚本写到 `%TEMP%\dsh-restart-refresh-restart.ps1`（退出是 `-quit.ps1`），同时写一个同名的 `.vbs` 启动器；
3. 用 `wscript.exe //nologo //B 启动器.vbs` 拉起并 `unref()`；
   - 为什么用 `wscript`：它是 GUI 子系统程序，本身不占控制台；启动器里 `shell.Run "...", 0, False` 用窗口样式 0 起 PowerShell、且不等它，所以**不闪命令框**，`wscript` 立刻退出、PowerShell 留在后台，能活过它要杀掉的父进程。
   - 试过但不行的两条：直接 `spawn('powershell.exe', …, { detached: true })`——没有控制台，PowerShell 静默退出，脚本一行都不跑（实测）；`cmd /c start /b` 能跑但会闪一个命令框。
4. 立刻回 `{ ok, mode, mainPid, hostPid, exe, log }`。

助手脚本：

1. 只等 250ms（够 HTTP 响应发回页面），校验 exe 还在；
2. **先试优雅退出**（0.4.4）：`Add-Type` 编译一个小的 `DshGraceful` 类，用 `EnumWindows` 找出该 pid 的所有顶层窗口，先给全部窗口 `PostMessage(WM_QUERYENDSESSION)` + `WM_ENDSESSION(TRUE)`，再给可见窗口 `WM_CLOSE`。
   - 为什么这样能成：壳的 `window.on("close")` 里有 `if (quitting || shellInstallerOwnsQuit || sessionEnding) return;`，否则就 `preventDefault()` 变成"最小化到托盘"；而 `sessionEnding` 正是 `window.on("session-end")` 置位的。窗口先收到会话结束消息，随后那个 `WM_CLOSE` 就不再被拦，窗口真的关掉 → `window-all-closed` → `app.quit()` → `before-quit` 里 `sessionEnding` 让 `finishQuit()` 直接走完（停 Host、存状态、收托盘），还跳过了「有任务在跑」的二次确认。
   - 附带好处：不走 `TerminateProcess`，**不会有 Windows 那声「叮」**（强杀有窗口的 GUI 进程才会响）。
   - 最多等 8 秒；主进程没退干净就记 `graceful shutdown timed out; falling back to a force stop`，继续走下面的强杀流程。主进程退了但 Host 还在，就单独 `taskkill /F /PID <host>` 补一刀。
3. 强杀兜底：`taskkill /F /PID <host>`、`taskkill /F /PID <main>`（**不带 `/T`**：助手自己是宿主的后代，杀进程树会先杀掉自己）；
4. `Wait-Process` 确认主进程真的没了（最多 4 秒），再按镜像名把**残留的 renderer / GPU / utility 子进程**逐个 `Stop-Process -Force` 清掉（最多 12 轮 × 300ms）；
   - 为什么必须清：这些残留进程拖着 App 的单实例锁，新实例一起来就按"第二个实例"退出（实测：另一个实例在跑时再启动，进程 3 秒内以退出码 0 结束），表现就是"只关闭、打不开"。
4. `-Mode restart` 时先停 400ms，再 `Start-Process -FilePath <exe> -WorkingDirectory <exe 目录> -PassThru`；每轮起完轮询 `Get-Process -Name <exe 名>` 约 2.4 秒，没起来就清残留、等 900ms 再试，最多 10 轮（约 25 秒）；日志会记下新实例的退出码（`round N: pid X exited with 0` 就是又撞上单实例锁）。全失败后兜底用 `explorer.exe <exe>` 走一次双击式启动；`-Mode quit` 在第 3 步之后就结束；
   - **关键坑（0.4.3 修）**：宿主进程的环境里有 `ELECTRON_RUN_AS_NODE=1`，wscript → powershell → `Start-Process` 一路继承；App 拿到这个变量后按 Node 运行，秒退、退出码 0、不建窗口。helper 一开始就 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`（顺带清 `ELECTRON_NO_ATTACH_CONSOLE`），并在清掉时记一行日志。`explorer.exe` 那条兜底之所以能成，是因为它用的是 shell 自己的干净环境。
   - 每轮失败后还会清掉旧宿主的直系子进程（`Stop-Children`，按 `ParentProcessId` 递归；跳过 powershell/wscript/conhost，也跳过命令行含 `billion-context` 的常驻代理）。
5. 全程追加到 `%TEMP%\dsh-restart-refresh-restart.log`，成功那行带总耗时（实测：优雅退出 1.2s、重启 2.2s）。

> 助手脚本是 PowerShell，`node --check` 管不到。改完用 `node test/dump-helper.mjs` 把生成的 `.ps1` 落到 `%TEMP%\dsh-restart-refresh-check-{restart,quit}.ps1`，再用 `[System.Management.Automation.Language.Parser]::ParseFile()` 过一遍语法（踩过坑：早版本把整段包在一个裸的 `{ }` 里，PowerShell 把它当成 ScriptBlock 字面量**静默输出**而不执行，结果优雅退出根本没跑起来，还照样强杀）。

## 二、刷新键做了什么

`POST /dsh-restart-refresh/reload`：

```js
const hmr = ctx.get('hmr')
const result = await hmr.runExclusive(() => hmr.reconcileProfile([]))
// result = { warnings, pending, restartReason }
```

- `reconcileProfile` **必须**在 `runExclusive` 里调，否则抛 `HMR profile reconciliation must run inside runExclusive`；`runExclusive` 自己是串行队列，所以连点不会并行重排。
- 它按磁盘重新编排整个 profile：停掉并重启文件变过的条目、加载新插件。
- `restartReason` 非空（包映射变更）、`pending` 非空（有模块必须重启才会被加载）时不假装成功，客户端把「这次改动要重新打开应用才生效」显示出来。
- 我们不做 dsh-unlag 那套页面换代的握手机制：换完直接 `location.reload()`（设置里可关）。好处是实现只有几十行、没有第二份状态机；代价是新代码把页面写崩时自动重建会连崩。
- 服务端还有两道保护：同时只跑一次（第二次直接 202 `busy`）；超过 8 秒没结束就回 202 `slow`，不让页面干等。

## 三、路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dsh-restart-refresh/restart` | 关掉并重新打开 App |
| POST | `/dsh-restart-refresh/quit` | 只关掉 App，不重开 |
| POST | `/dsh-restart-refresh/reload` | HMR 重新编排插件 + 重建页面 |
| GET | `/dsh-restart-refresh/state` | `{ desktop, hmr, version, logPath, settings }` |
| GET/POST | `/dsh-restart-refresh/settings` | 读写三个开关 |

所有路由：非 POST（除 GET 两条）405；`sec-fetch-site: cross-site` 或 Origin 与 Host 不同源 403；body 上限 4 KB；`pid`/`ppid` 非正整数 409 `not-desktop`；写脚本或 spawn 失败 500 `spawn`。

设置落在 `$DSH_HOME/dsh-restart-refresh.json`（默认 `~/.dsh/dsh-restart-refresh.json`）：

```json
{ "confirmRestart": true, "confirmReload": false, "rebuildAfterReload": true }
```

## 四、按钮怎么进到界面里

**品牌行两个图标**：壳没给「品牌行尾部动作」留 slot，`sidebar.brand.mark` / `sidebar.brand.name` 又已经被官方 lockup 占着（抢了会顶掉官方标识），所以直接往 DOM 里塞：

1. `document.querySelector('[class*="logoRow"]')`（编译后形如 `wtg9ga_logoRow`）；
2. 在里面追加一个 `span[data-dsh-restart-refresh-brand]`，`display:inline-flex; align-items:center; gap:2px; margin-left:8px; transform:translateY(3px)`——3px 是让它与 `deepseek` 字样的光学中心对齐；
3. 里面两个 26×26 的图标按钮：`data-dsh-restart-refresh-restart`（循环箭头）在前、`data-dsh-restart-refresh-quit`（电源）在后；
4. 每 1.5 秒复查并补挂（侧栏是 React 画的，重渲染会把节点摘掉），不用 subtree observer——页面重绘太频繁；
5. `ctx.effect` 的 disposer 里摘掉节点、停掉定时器、关掉可能开着的浮层。

**头部刷新键**：`ctx.slots.inject('conversation.session.header.utilities', …)`，注册 `{ id: 'dsh-restart-refresh', order: 29, label }`——和 dsh-unlag 同一座位，两个插件并存时紧挨着。

**设置页**：`ctx.slots.inject('settings.section', …)`，注册 `{ id: 'dsh-restart-refresh', order: 100, label }`，组件拿 `{ close }`。

## 五、提示与确认卡

浏览器原生的 `title` 太慢、太丑，所以自己画：

- 黑底提示：`#1f2328` 背景、11.5px、第二行 `opacity:.62` 的小字说明；头部刷新是「刷新插件与界面 / 对需要重启的插件无效」，品牌行两个是「重启 DSH」「退出 DSH」。**出现有延迟**（`TIP_DELAY_MS = 600`）：指针进入只先给按钮上灰底，停住 600ms 才 append 提示；离开或 dispose 会清掉未触发的定时器，所以快速划过不会闪。
- 防误触是**两级**的：第一次点图标只弹出一个小红键（`background:#dc2626`、`border-radius:7px`、11.5px、和提示条差不多大，就是「重启」/「退出」两个字），**再点这个红键才发请求**。撤掉的方式有四种：点别处、按 Esc、再点一次图标、**鼠标离开「图标 + 红键」这块区域外扩 28px 的范围**；另外 5 秒没动静也会自动收起（定时器在关闭时清掉）。没有「取消」按钮——不点就不执行。
- 两个浮层都挂在 `document.body` 上、用 `position:fixed` 定位：品牌行会裁掉溢出的子元素，挂在自己旁边会被裁掉（第一版的坑）。坐标取 `getBoundingClientRect()`（CSS px），并做视口收边：右侧超出往左挪、左侧超出往右挪。
- 三个图标统一规格：26×26、`border-radius:7px`、`color:inherit`、hover 时 `background:rgba(0,0,0,.05)` 且 `opacity:1`（品牌行是 `pointerenter/leave` 手写，头部按钮是 React state）。头部那个的颜色按整屏取墨量校准过：`HEADER_OPACITY = 0.55` 时笔画的灰度均值 151，和同一排 `⋯`(149.5)、面板图标(147.9) 基本一致（注意 React 那边还要在 style 里显式引用这个常量，否则会被内联 `opacity` 覆盖掉）；圆心用 `transform:translateY(-0.5px)` 抬到和它们同一行（截屏量：`⋯` 245.5、面板 246、刷新 246）。两个品牌图标的 SVG 共用同一个圆心与半径（`viewBox 0 0 24 24`，圆心 (12,12)、r=9、`stroke-width:1.8`）：循环箭头的圆环与电源的圆弧直径严格相等、圆心同高（截图量过：两个图标都是 y 243–261、圆心行 252），看着是一对。刷新那个的尾巴是短直角（3.6 个单位，不是常见的 5），箭头贴在圆环的端点上是切向的，不会显得歪。
- 防误触开关就是设置里的 `confirmRestart`：关掉后一点即执行。
- 品牌行在窗口拖动区里，所以图标与卡片都 `stopPropagation`，避免点按钮变成拖窗口。

## 六、边界

- `dsh web` 在浏览器里打开时侧栏没有品牌行，两个品牌按钮不出现；头部刷新键仍在，但宿主会回答「这台机器没有可用的热替换服务」。
- 插件是新装的（宿主还没重启过）时，宿主加载的是旧代码：`/state`、`/reload`、`/settings`、`/quit` 都还不存在，只有旧版的 `/restart` 可用。手动重启一次 App 之后全齐。
- 退出/重启会打断正在跑的回合；草稿、排队消息可能来不及存盘。所以默认要过一道红色确认。
- 助手脚本依赖 `wscript.exe`（GUI 宿主，不闪窗）、`powershell.exe`、`taskkill`，都是 Windows 自带。

### 换一台机器会不会挂

三个真实踩过的坑，现在都写死了：

1. **脚本编码**：`.ps1` 用 UTF-8 **带 BOM**（`utf8WithBom`），否则 Windows PowerShell 5.1 按 ANSI 解码，中文路径会变成乱码并抛 `DirectoryNotFoundException`；`.vbs` 用 UTF-16LE **带 BOM**（`utf16leWithBom`），WScript 默认也按 ANSI 读，普通 UTF-8 会报「路径未找到」。两处都有测试断言 BOM 字节。
2. **桌面端门禁**：`desktopSupport(process)` 要求 `platform === 'win32'` 且 `process.versions.electron` 存在；`parentIsApp()` 再用 `tasklist /FI "PID eq <ppid>"` 核对父进程镜像名等于自己的 exe 名。任一不满足，`/restart`、`/quit` 在**写脚本和拉起进程之前**就 409 `not-desktop`（`dsh web` 下父进程是用户终端，放过去会杀掉终端）。`/state` 同时返回 `desktop` 与 `desktopReason`。
3. **浏览器版不显示电源键**：客户端启动就 `GET /state`，`desktop !== true` 时品牌行一个子节点都不挂（`test/web-gate.mjs` 专门验证这条），头部刷新键与设置页照旧——网页版只剩「刷新」是有意义的。

路径全部来自 `process.env.DSH_HOME || ~/.dsh`、`os.tmpdir()`、`process.execPath`，没有硬编码盘符；exe 与工作目录作为参数传给助手并自行加引号（测试用带空格的 `C:\Program Files\DSH\DSH.exe` 跑过）。

### 语言

React 那部分（头部刷新键、设置页）用 `locale` 服务的 zh/en 两套词条；品牌行那两个图标是手写 DOM，`detectZh()` 只看 `documentElement.lang` 与 `navigator.languages`，**非中文一律回退英文**，不会出现半中半英。

### 版本

`/state` 的 `version` 来自 `package.json`（`createRequire(import.meta.url)('../package.json').version`），避免代码里散落硬编码版本号。

## 七、自测

```sh
node test/client-smoke.mjs
node test/host-smoke.mjs
node test/web-gate.mjs
```

都不需要浏览器和桌面端：客户端脚本跑在伪造的 DOM 与假的 `react` 上（`http://` 请求、`window.confirm`、`setInterval` 都是假的），宿主路由用假的进程参数与假的 `spawn`。

`web-gate.mjs` 是独立进程：让 `/state` 回答 `desktop: false`，断言品牌行一个子节点都不加、只发一次 `GET /state`、不发任何 POST，而头部与设置页两个 slot 仍然注册。

客户端覆盖：两个品牌按钮挂在品牌行、整组下移、黑底提示 hover 出现/离开消失、红色卡片文案、取消不发请求、确认分别 POST 到 `/restart`、`/quit`、失败 alert、`confirmRestart:false` 时一点即执行、无品牌行时不注入、dispose 摘干净。

宿主覆盖：五条路由的方法/来源/体积校验、`-Mode restart` 与 `-Mode quit` 的助手参数、日志路径、设置读写与默认值合并、`state` 的 `hasHmr` 是每次请求求值（hmr 服务可能比本插件晚 apply）；以及可移植性那一组——`utf8WithBom`/`utf16leWithBom` 的字节前缀、`desktopSupport` 三种环境、`parentIsApp` 三种父进程、非桌面环境 409 且**没有拉起任何进程**。
