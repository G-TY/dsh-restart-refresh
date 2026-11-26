# DSH-restart-refresh

Restart, quit and hot-reload DSH without leaving the app. Two icon buttons sit next to the `deepseek` logo (restart · quit) and a third one sits at the right of the conversation header (reload the plugin code). Restart and quit are two-step: the first click shows a small red key, and only the second click acts. Restart is **graceful** — it asks the shell to end its session and close its windows, so state is saved, the Host stops cleanly and Windows does not play its force-kill sound; an 8-second timeout falls back to a hard stop. The reload button runs the harness's own HMR `reconcileProfile` and then rebuilds the page, keeping the running turn, the queued messages and the draft.

Desktop app only for restart/quit (Windows); the reload button also works in `dsh web`.

---

三个图标，管两种「代码不生效」和一种「把它关掉」：

| 图标 | 在哪 | 做什么 | 什么时候用 |
| --- | --- | --- | --- |
| 刷新（循环箭头） | 侧栏左上角 deepseek 字样右边，左边第一个 | 关掉再打开整个 App（宿主进程换新的） | 改了宿主端代码（`index.js`、`cordis.patch.yml`）、装了新 bundle、宿主插件的新路由没生效 |
| 电源 | 紧挨着它右边 | 直接退出 DSH，不重开 | 要彻底关掉应用 |
| 刷新（循环箭头） | 对话头部右上角那一排（dsh-unlag 的位置） | 让宿主用 HMR 重新编排插件、再重建页面 | 改的是浏览器端代码或插件源码；页面开久了变卡 |

左右两个危险动作都**不会一点就执行**：点一下图标，它下面会弹出一个小红键（就是「重启」/「退出」两个字，大小和悬浮提示差不多），**再点这个红键才真的执行**；点别处、按 Esc、再点一次图标、或者把鼠标移开一段距离都会让它消失，5 秒不动它也会自己收起。这个防误触在设置里也能关掉。

鼠标悬停时图标先**变灰**（和标题栏那些按钮一样，表示可以点），停住约 0.6 秒才浮出黑底提示；移开立刻收起，快速划过不会闪一下。

设置页在 **设置 → 刷新与重启**：重启/退出前先确认、换代码前先确认、换完代码后自动重建页面。

**只在 Windows 桌面端有效。** 网页版（`dsh web`）里没有 App 可重启：宿主会核对「是不是 Electron + 父进程是不是这个 exe 自己」，不满足就拒绝（`409 not-desktop`），页面也不会画那两个电源键——只剩头部的「刷新」。界面文字跟随 DSH 客户端语言，非中文一律回退英文。

## 为什么要「重启」，也要「刷新」

DSH 的插件分两半：

- **宿主半身**跑在宿主进程里（Node，只有一个，长期活着）。Node 不会因为页面重载就丢掉已加载的 ESM 模块，所以宿主代码只有换掉进程才会变。
- **浏览器半身**每次页面加载都重新拉一遍，重建页面就够。

头部刷新键走的是宿主 `hmr` 服务的 `runExclusive(() => reconcileProfile([]))`：它按磁盘上的插件重新编排 profile，停掉并重启文件变过的那些条目，再把页面重建。正在跑的对话、排队消息、草稿都在，因为只有插件代码和渲染层被换掉。这也是 dsh-unlag 的做法。

有些改动它换不了：包的映射变了（`restartReason`）、有模块必须重启才会被加载（`pending`）、插件清单读不到。遇到这些它不假装成功，会直接说「这次改动要重新打开应用才生效」——那时候用左边的重启键。

## 重启 / 退出为什么只能自己动手

壳（`app.asar` 里的 Electron 主进程）没有给页面留任何「帮我重启」的接口：`app.relaunch()` 只存在于主进程，页面侧连 `ipcRenderer` 都没有，正式版菜单里那条「重启应用与 Host」也只在未打包的构建里才存在。

所以宿主半身写了这么一手（重启和退出共用，只差最后一步）：

1. 往临时目录写两个文件：PowerShell 助手（`%TEMP%\dsh-restart-refresh-restart.ps1` / `-quit.ps1`）和一个同名的 `.vbs` 启动器；
2. 用 `wscript.exe //B 启动器.vbs` 拉起助手——`wscript` 是 GUI 程序，`shell.Run(..., 0, False)` 又是隐藏窗口，所以**全程不会闪命令框**；它立刻返回，助手继续活着；
3. 先走**正常关闭**（不是强杀）：给主窗口发 `WM_QUERYENDSESSION` + `WM_ENDSESSION`（壳看到会话结束就把随后的关窗放行，而不是「最小化到托盘」），再发 `WM_CLOSE`。于是壳自己走正常退出流程——停 Host、存状态、收托盘，还跳过了「有任务在跑」的二次确认。**这条路不会响 Windows 那声「叮」，也不会弹「操作失败」的报错框**（强杀 GUI 进程才会）；
4. 最多等 8 秒；没退干净就回落到 `taskkill /F`，日志里会写 `graceful shutdown timed out; falling back to a force stop`；
5. **把同名的残留子进程（renderer / GPU / utility）一起扫掉**，再清掉旧宿主的直系子进程（MCP 服务、语音服务等；bili 代理那个常驻守护会被保留）——它们会拖住 App 的单实例锁，也会让新实例启动时多一点负担；
6. **启动前清掉 `ELECTRON_RUN_AS_NODE`**：宿主是 `ELECTRON_RUN_AS_NODE=1` 跑起来的，这个变量会一路继承到我们拉起的进程，App 收到它就变成纯 Node 进程——秒退、退码 0、没有窗口（这就是之前“只关闭、打不开”的真正原因）；
7. `-Mode restart` 用同一个可执行文件重新启动 App，并**轮询确认进程真的起来了**；没起来就清干净再试，最多约 25 秒，最后再用 `explorer` 走一次双击式的启动；`-Mode quit` 在正常关闭成功时就到此为止。

实测：正常关闭约 1.2 秒关干净；重启从点下到 App 重新起来约 2.2 秒（记事本端到端演练：`restart: shell exited gracefully in 1.2s; relaunching` → `relaunched on round 1 in 2.2s`）。旧版本是先等 1.2 秒、再等 5 秒、最后强杀，合计 6～7 秒、会闪命令框、还会响系统音。

日志写在 `%TEMP%\dsh-restart-refresh-restart.log`（每步带耗时；失败时会记下新实例的退出码，以及系统事件日志里的错误），没成功时先看它。

## 会丢什么

**头部刷新**：输入框里的文字、引用、`@` 都还在；只有还没发出去的附件会丢（附件只活在页面内存里）。对需要真重启的插件无效——它只换插件代码，不换宿主进程。

**重启 / 退出**：正在跑的对话会被打断（宿主进程没了），重开后重新打开那个会话可以继续；没发出去的草稿、排队消息可能来不及存。所以才有那张红色确认卡。

## 位置说明

- 两个按钮挂在侧栏品牌行（`[class*="logoRow"]`）里，因为壳没有给「品牌行尾部动作」留 slot，而 `sidebar.brand.mark` / `sidebar.brand.name` 已经被官方 lockup 占着。整组下移 3px，与 `deepseek` 字样的光学中心对齐。
- 头部刷新键注册在 `conversation.session.header.utilities`（order 29），和 dsh-unlag 同一个座位。
- 设置页注册在 `settings.section`（id `dsh-restart-refresh`，order 100）。

`dsh web` 在浏览器里打开时，侧栏没有那个品牌行，两个品牌按钮不出现；头部刷新键仍可用，但宿主会回答「这台机器没有可用的热替换服务」。

## 安装

在 DSH 的插件页安装本目录，或者用 `plugin_manager` 装 bundle。装完**手动重启一次 App**：宿主半身的 `/state`、`/reload`、`/settings`、`/quit` 路由要等宿主重新加载才注册；在那之前按钮仍在，但刷新键会报「没有可用的热替换服务」，重启/退出用的是旧宿主里的路由。之后就都用按钮了。

## 卸载

插件页卸载即可，或者删掉 `profiles/desktop/node_modules/dsh-restart-refresh` 与 profile `package.json` 里对应的 bundle 记录。

## 测试

```sh
node test/client-smoke.mjs   # 浏览器半身：注册位置、两个品牌按钮、黑底提示、红色确认卡、取消/确认、失败提示、dispose
node test/host-smoke.mjs     # 宿主半身：五个路由的方法/来源/体积校验、quit 与 restart 的模式、hmr 串行、设置落盘、state 形状
```

都不需要浏览器和桌面端：客户端脚本跑在伪造的 DOM 与假的 `react` 上，宿主路由用假的进程参数与假的 spawn。

## 目录

- `index.js` 宿主半身：`/dsh-restart-refresh/{restart,quit,reload,settings,state}`
- `client.js` 浏览器半身：品牌行重启/退出 + 头部刷新 + 设置页
- `cordis.patch.yml` 把插件插进 profile
- `locale/*.json` 插件页里的名字与说明
- `docs/DETAIL.md` 实现细节与边界
