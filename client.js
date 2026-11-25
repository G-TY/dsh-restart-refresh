/**
 * Client half of DSH-refresh.
 *
 * Three controls, two kinds of staleness:
 *
 * - Two icon buttons sit right of the sidebar brand: a refresh glyph that
 *   restarts the whole desktop app (the only way Host-side plugin code is
 *   replaced) and a power glyph that quits it. Both open a red confirmation
 *   card under the button, so a single slip cannot kill a running turn.
 * - One refresh glyph sits in the conversation header's utility row — the same
 *   seat dsh-unlag uses. It asks the Host to recompose the profile through the
 *   `hmr` service and then rebuilds the page; running turns, queued messages and
 *   drafts survive, but plugins that need a real restart do not.
 *
 * Every hover shows a black tooltip instead of the browser's own pale one.
 * The shell offers no slot in the brand row (`sidebar.brand.mark` and
 * `sidebar.brand.name` are taken by the official lockup), so those two buttons
 * are appended to `[class*="logoRow"]` and re-attached when React repaints it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-refresh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-refresh'

    // The DSH client paints `<html lang="zh-CN">`; anything that is not Chinese
    // falls back to English rather than to Chinese, so a ja/ko/fr user gets a
    // readable UI instead of the wrong language.
    const detectZh = () => {
      const tag = typeof document !== 'undefined' ? String(document.documentElement?.lang ?? '') : ''
      if (/^zh(-|$)/i.test(tag)) return true
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false
      const first = Array.isArray(navigator?.languages) ? navigator.languages[0] : navigator?.language
      return typeof first === 'string' && /^zh(-|$)/i.test(first)
    }

    const COPY = detectZh()
      ? {
          restart: '重启 DSH',
          restartConfirmTitle: '重启 DSH？',
          restartConfirmText: '正在进行的对话会中断，重开后可从侧栏继续。',
          restartConfirmOk: '重启',
          quit: '退出 DSH',
          quitConfirmTitle: '退出 DSH？',
          quitConfirmText: '整个应用会关闭，正在进行的对话会中断。',
          quitConfirmOk: '退出',
          cancel: '取消',
          working: '处理中…',
          actionFailed: '操作失败',
          notDesktop: '这个按钮只在桌面端可用，这里是浏览器里的网页版',
          reload: '刷新插件与界面',
          reloadHint: '对需要重启的插件无效',
          reloading: '正在换代码…',
          reloaded: '已换上新代码，页面即将重建',
          restartNeeded: '这次改动要重新打开应用才生效',
          slow: '换代码还没结束，稍等再点一次',
          reloadFailed: '换代码失败',
          settings: '刷新与重启',
          settingsIntro: '左上角的 DSH 标志右侧两个图标：重启、退出；对话界面右上角：刷新界面和插件代码。',
          confirmDangerLabel: '重启 / 退出先点两下',
          confirmDangerHint: '第一下只弹出小红键，再点它才真的执行，避免误触。',
          confirmReloadLabel: '换代码前先确认',
          confirmReloadHint: '替换正在运行的插件代码前弹一次确认。',
          rebuildLabel: '换完代码后重建页面',
          rebuildHint: '关掉的话，插件代码会被替换，但页面停在旧的，需要自己刷新。',
          logLabel: '重启日志',
        }
      : {
          restart: 'Restart DSH',
          restartConfirmTitle: 'Restart DSH?',
          restartConfirmText: 'The running turn is interrupted; reopen and continue from the sidebar.',
          restartConfirmOk: 'Restart',
          quit: 'Quit DSH',
          quitConfirmTitle: 'Quit DSH?',
          quitConfirmText: 'The whole app closes and the running turn is interrupted.',
          quitConfirmOk: 'Quit',
          cancel: 'Cancel',
          working: 'Working…',
          actionFailed: 'Action failed',
          notDesktop: 'This button only works in the desktop app; this is the browser version',
          reload: 'Reload plugins and UI',
          reloadHint: 'Does not help plugins that need a restart',
          reloading: 'Replacing…',
          reloaded: 'New code is in place; the page is about to rebuild',
          restartNeeded: 'This change needs the app reopened before it can apply',
          slow: 'The swap is still running; press again shortly',
          reloadFailed: 'Replacing the plugin code failed',
          settings: 'Refresh & restart',
          settingsIntro: 'Top left, right of the DSH mark: restart and quit. Top right of the conversation: reload the UI and the plugin code.',
          confirmDangerLabel: 'Two taps to restart or quit',
          confirmDangerHint: 'The first tap only pops a small red key; press that to act.',
          confirmReloadLabel: 'Ask before swapping code',
          confirmReloadHint: 'One confirmation before replacing the running plugin code.',
          rebuildLabel: 'Rebuild the page after the swap',
          rebuildHint: 'When off, the code is replaced but the page stays old until you reload it yourself.',
          logLabel: 'Restart log',
        }

    const t = (key) => (COPY[key] === undefined ? key : COPY[key])

    // ---------------------------------------------------------------- shared state

    const store = {
      settings: { confirmRestart: true, confirmReload: false, rebuildAfterReload: true },
      desktop: false,
      hmr: false,
      loaded: false,
      error: null,
      listeners: new Set(),
    }

    const emit = () => {
      for (const listener of [...store.listeners]) {
        try {
          listener()
        } catch {
          // A throwing view must not stop the others.
        }
      }
    }

    const request = async (path, init) => {
      const response = await fetch(`${API}${path}`, init)
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { response, body }
    }

    const refreshState = async () => {
      try {
        const { body } = await request('/state')
        if (body !== null && body.ok === true) {
          store.settings = { ...store.settings, ...(body.settings ?? {}) }
          store.desktop = Boolean(body.desktop)
          store.hmr = Boolean(body.hmr)
          store.error = null
        } else {
          store.error = body?.message ?? 'state'
        }
      } catch (error) {
        store.error = String(error?.message ?? error)
      }
      store.loaded = true
      emit()
    }

    const saveSettings = async (patch) => {
      const { body } = await request('/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (body === null || body.ok !== true) throw new Error(body?.message ?? 'settings')
      store.settings = { ...store.settings, ...(body.settings ?? {}) }
      emit()
      return store.settings
    }

    const post = async (path) => {
      const { body } = await request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      return body
    }

    // ---------------------------------------------------------------- visuals

    // Both glyphs share one circle: centre (12,12), r = 8, same stroke. The open
    // ring with a tangential arrowhead reads as "refresh"; the ring with a stem
    // reads as "power".
    const ICON_REFRESH =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>' +
      '<path d="M21 4.4V8h-3.6"/></svg>'

    const ICON_POWER =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 2.8v8.2"/>' +
      '<path d="M16.5 4.21A9 9 0 1 1 7.5 4.21"/></svg>'

    const BUTTON_STYLE = [
      'flex:0 0 auto',
      'width:26px',
      'height:26px',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'padding:0',
      'border:0',
      'border-radius:7px',
      'background:transparent',
      'color:inherit',
      'opacity:.7',
      'cursor:pointer',
      'line-height:1',
      'transition:opacity .12s ease, background-color .12s ease',
    ].join(';')

    const TOOLTIP_STYLE = [
      'position:fixed',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'gap:1px',
      'max-width:240px',
      'padding:5px 9px',
      'border-radius:7px',
      'background:#1f2328',
      'color:#fff',
      'font-size:11.5px',
      'line-height:1.35',
      'white-space:nowrap',
      'box-shadow:0 6px 18px rgba(0,0,0,.28)',
      'pointer-events:none',
    ].join(';')

    const CONFIRM_STYLE = [
      'position:fixed',
      'z-index:2147483001',
      'transform:translateX(-50%)',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'padding:5px 14px',
      'border-radius:7px',
      'border:1px solid #b91c1c',
      'background:#dc2626',
      'color:#fff',
      'font-size:11.5px',
      'font-weight:600',
      'line-height:1.35',
      'white-space:nowrap',
      'cursor:pointer',
      'box-shadow:0 8px 20px rgba(185,28,28,.32)',
    ].join(';')

    /** Same lag the shell's title bar uses before showing a plate. */
    const TIP_DELAY_MS = 600

    /** The brand row clips its children, so overlays live on `document.body`. */
    const rectOf = (element) => {
      if (typeof element.getBoundingClientRect !== 'function') {
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
      }
      return element.getBoundingClientRect()
    }

    // ---------------------------------------------------------------- brand buttons

    /**
     * One icon button plus its black tooltip and its red confirmation card.
     * Built with plain DOM because it lives outside every slot the shell offers.
     *
     * @param spec - `{ icon, label, hint, confirmTitle, confirmText, confirmOk,
     *   onRun, align }`, where `onRun` does the actual Host call.
     */
    function createIconButton(spec) {
      const wrap = document.createElement('span')
      wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center'

      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'button')
      button.setAttribute('aria-label', spec.label)
      button.style.cssText = BUTTON_STYLE
      button.innerHTML = spec.icon
      if (spec.id) button.dataset[spec.id] = 'true'

      const tooltip = document.createElement('span')
      let tipTimer = null
      tooltip.style.cssText = `${TOOLTIP_STYLE};transform:translateX(-50%)`
      tooltip.style.display = 'none'
      const tipRight = spec.tipAlign === 'right'
      if (tipRight) tooltip.style.transform = 'translateX(-100%)'
      const tipMain = document.createElement('span')
      tipMain.textContent = spec.label
      tooltip.appendChild(tipMain)
      if (spec.hint) {
        const tipHint = document.createElement('span')
        tipHint.style.cssText = 'opacity:.62;font-size:10.5px'
        tipHint.textContent = spec.hint
        tooltip.appendChild(tipHint)
      }

      const showTipNow = () => {
        const rect = rectOf(button)
        const parent = document.body ?? wrap
        if (parent !== tooltip && typeof parent.appendChild === 'function') parent.appendChild(tooltip)
        const center = tipRight ? rect.right : rect.left + rect.width / 2
        tooltip.style.left = `${Math.round(center)}px`
        tooltip.style.top = `${Math.round(rect.bottom + 6)}px`
        tooltip.style.display = 'flex'
        // Keep the plate on screen when the button sits near an edge.
        const viewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
        if (viewport > 0 && typeof tooltip.getBoundingClientRect === 'function') {
          const box = tooltip.getBoundingClientRect()
          if (box.width > 0) {
            let shift = 0
            if (box.right > viewport - 8) shift = box.right - (viewport - 8)
            else if (box.left < 8) shift = box.left - 8
            if (shift !== 0) tooltip.style.left = `${Math.round(center - shift)}px`
          }
        }
      }
      // Like the shell's own title bar buttons: the plate only appears after the
      // pointer has settled, so brushing past the row does not flash a tip.
      const showTip = () => {
        if (tipTimer !== null) clearTimeout(tipTimer)
        tipTimer = setTimeout(() => {
          tipTimer = null
          showTipNow()
        }, TIP_DELAY_MS)
      }
      const hideTip = () => {
        if (tipTimer !== null) {
          clearTimeout(tipTimer)
          tipTimer = null
        }
        tooltip.style.display = 'none'
        if (tooltip.parentElement !== null) tooltip.remove()
      }
      const setHover = (on) => {
        button.style.background = on ? 'rgba(0,0,0,.05)' : 'transparent'
        button.style.opacity = on ? '1' : '.7'
      }
      button.addEventListener('pointerenter', () => {
        setHover(true)
        showTip()
      })
      button.addEventListener('pointerleave', () => {
        setHover(false)
        hideTip()
      })
      button.addEventListener('focus', showTip)
      button.addEventListener('blur', hideTip)

      wrap.appendChild(button)

      let card = null
      let running = false
      let zone = null
      let cardTimer = null

      const outside = (event) => {
        if (card === null) return
        if (card.contains?.(event.target) === true) return
        if (event.target === button || button.contains?.(event.target) === true) return
        closeCard()
      }
      const onKey = (event) => {
        if (event.key === 'Escape') closeCard()
      }
      // Walk away from the button and the key quietly folds away: no need to
      // aim at a specific spot to dismiss it.
      const onMove = (event) => {
        if (card === null || zone === null) return
        const x = event.clientX
        const y = event.clientY
        if (typeof x !== 'number' || typeof y !== 'number') return
        if (x < zone.left || x > zone.right || y < zone.top || y > zone.bottom) closeCard()
      }

      const closeCard = () => {
        if (card !== null) {
          if (card.parentElement !== null) card.remove()
          card = null
        }
        zone = null
        if (cardTimer !== null) {
          clearTimeout(cardTimer)
          cardTimer = null
        }
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('pointerdown', outside, true)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointermove', onMove, true)
        }
      }

      const run = async (okButton) => {
        if (running) return
        running = true
        closeCard()
        if (okButton) okButton.disabled = true
        try {
          await spec.onRun()
          // On success the helper closes the app in a moment; keep it busy so a
          // second press cannot queue another shutdown in the remaining window.
        } catch (error) {
          running = false
          if (typeof window !== 'undefined') {
            window.alert(`${t('actionFailed')}：${String(error?.message ?? error)}`)
          }
        }
      }

      const openCard = () => {
        if (card !== null) {
          closeCard()
          return
        }
        hideTip()
        const rect = rectOf(button)
        // One small red key, about the size of the tooltip plate above: press it
        // to go through, press anywhere else (or Esc) to back out.
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.setAttribute('data-dsh-refresh-confirm', spec.id ?? 'true')
        confirm.textContent = spec.confirmOk
        confirm.style.cssText = `${CONFIRM_STYLE};left:${Math.round(rect.left + rect.width / 2)}px;top:${Math.round(rect.bottom + 6)}px`
        confirm.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          void run(confirm)
        })
        // The brand row sits in the window drag region; keep clicks inside.
        for (const type of ['pointerdown', 'mousedown']) {
          confirm.addEventListener(type, (event) => event.stopPropagation())
        }
        const parent = document.body ?? wrap
        if (typeof parent.appendChild === 'function') parent.appendChild(confirm)
        // Nudge the key back inside the window when it would hang off an edge.
        const viewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
        if (viewport > 0 && typeof confirm.getBoundingClientRect === 'function') {
          const box = confirm.getBoundingClientRect()
          if (box.width > 0) {
            let shift = 0
            if (box.right > viewport - 8) shift = box.right - (viewport - 8)
            else if (box.left < 8) shift = box.left - 8
            if (shift !== 0) {
              confirm.style.left = `${Math.round(rect.left + rect.width / 2 - shift)}px`
            }
          }
        }
        card = confirm
        // Stay-open zone: the button, the key, and a little slack around both.
        const key = rectOf(confirm)
        zone = {
          left: Math.min(rect.left, key.left) - 28,
          right: Math.max(rect.right, key.right) + 28,
          top: Math.min(rect.top, key.top) - 18,
          bottom: Math.max(rect.bottom, key.bottom) + 22,
        }
        // Safety net: even if the pointer never moves, it folds away by itself.
        cardTimer = setTimeout(() => closeCard(), 5000)
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', outside, true)
          document.addEventListener('keydown', onKey, true)
          document.addEventListener('pointermove', onMove, true)
        }
      }

      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        hideTip()
        if (store.settings.confirmRestart === false) {
          void run(null)
          return
        }
        openCard()
      })
      // Keep the press off the drag region.
      button.addEventListener('pointerdown', (event) => event.stopPropagation())
      button.addEventListener('mousedown', (event) => event.stopPropagation())

      return {
        wrap,
        dispose() {
          hideTip()
          closeCard()
        },
      }
    }

    const callLifecycle = async (path) => {
      const body = await post(path)
      if (body === null || body.ok !== true) {
        // The Host answers in Chinese; a non-Chinese UI shows the localized text.
        const message = body?.code === 'not-desktop' ? t('notDesktop') : body?.message
        throw new Error(message ?? t('actionFailed'))
      }
      return body
    }

    const restartAction = () => callLifecycle('/restart')
    const quitAction = () => callLifecycle('/quit')

    const findBrandRow = () => {
      if (typeof document === 'undefined') return null
      const row = document.querySelector('[class*="logoRow"]')
      // Duck-typed on purpose: the shell's DOM may be a fake in tests, and a
      // shadow-DOM host would fail an `instanceof HTMLElement` check here.
      return row !== null && typeof row === 'object' && typeof row.appendChild === 'function' ? row : null
    }

    /**
     * The shell paints the brand row from React, so appended nodes survive only
     * until the next render. Re-attach on a slow interval instead of a subtree
     * observer: the row is cheap to find and the page repaints often.
     */
    const mountBrandButtons = () => {
      if (typeof document === 'undefined') return () => {}
      let host = null
      let timer = null

      const create = () => {
        const host = document.createElement('span')
        // Nudged down a hair so the glyphs sit on the wordmark's optical centre.
        host.style.cssText =
          'display:inline-flex;align-items:center;gap:2px;margin-left:8px;transform:translateY(3px)'
        host.dataset.dshRefreshBrand = 'true'

        const restart = createIconButton({
          icon: ICON_REFRESH,
          label: t('restart'),
          confirmTitle: t('restartConfirmTitle'),
          confirmText: t('restartConfirmText'),
          confirmOk: t('restartConfirmOk'),
          onRun: restartAction,
          id: 'dshRefreshRestart',
          align: 'left',
        })
        const quit = createIconButton({
          icon: ICON_POWER,
          label: t('quit'),
          confirmTitle: t('quitConfirmTitle'),
          confirmText: t('quitConfirmText'),
          confirmOk: t('quitConfirmOk'),
          onRun: quitAction,
          id: 'dshRefreshQuit',
          align: 'right',
        })
        host.appendChild(restart.wrap)
        host.appendChild(quit.wrap)
        host.disposeChildren = () => {
          restart.dispose()
          quit.dispose()
        }
        return host
      }

      const attach = () => {
        // Two gates before anything is drawn: the state must have been read, and
        // it must say this is the desktop app. In `dsh web` the parent process is
        // the terminal, so "restart" could not work there — and pretending it
        // could is worse than not offering the buttons at all.
        if (!store.loaded) return false
        if (!store.desktop) {
          if (host !== null) {
            if (typeof host.disposeChildren === 'function') host.disposeChildren()
            if (host.parentElement !== null) host.remove()
            host = null
          }
          return false
        }
        const row = findBrandRow()
        if (row === null) return false
        if (host === null) host = create()
        if (host.parentElement !== row) row.appendChild(host)
        return true
      }

      attach()
      // The first `/state` answer arrives after `apply`; mounting on that change
      // means the buttons appear at once instead of on the next interval tick.
      store.listeners.add(attach)
      timer = setInterval(attach, 1500)
      return () => {
        store.listeners.delete(attach)
        if (timer !== null) clearInterval(timer)
        timer = null
        if (host !== null) {
          if (typeof host.disposeChildren === 'function') host.disposeChildren()
          if (host.parentElement !== null) host.remove()
        }
        host = null
      }
    }

    // ---------------------------------------------------------------- header button

    // Ink calibrated against the shell's own header buttons: at .55 the strokes
    // read as the same grey as `⋯` / the panel toggle (measured on screen).
    const HEADER_OPACITY = 0.55

    const HEADER_BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      padding: 0,
      border: 0,
      borderRadius: '7px',
      background: 'transparent',
      color: 'inherit',
      opacity: HEADER_OPACITY,
      cursor: 'pointer',
      lineHeight: 1,
      // Nudged up a hair so the glyph centre sits on the same line as the
      // shell's own header buttons (`⋯` and the panel toggle).
      transform: 'translateY(-0.5px)',
      transition: 'opacity .12s ease, background-color .12s ease',
    }

    function ReloadButton() {
      const [phase, setPhase] = React.useState('idle')
      const [hover, setHover] = React.useState(false)
      const [tipShown, setTipShown] = React.useState(false)
      const tipTimer = React.useRef ? React.useRef(null) : { current: null }

      React.useEffect(() => {
        const listener = () => setPhase((current) => (current === 'busy' ? current : 'idle'))
        store.listeners.add(listener)
        if (!store.loaded) void refreshState()
        return () => {
          store.listeners.delete(listener)
        }
      }, [])

      // Plate appears only after the pointer has rested, like the shell's own
      // title bar buttons.
      React.useEffect(() => {
        if (tipTimer.current !== null) {
          clearTimeout(tipTimer.current)
          tipTimer.current = null
        }
        if (!hover) {
          setTipShown(false)
          return
        }
        tipTimer.current = setTimeout(() => {
          tipTimer.current = null
          setTipShown(true)
        }, TIP_DELAY_MS)
        return () => {
          if (tipTimer.current !== null) {
            clearTimeout(tipTimer.current)
            tipTimer.current = null
          }
        }
      }, [hover])

      const press = async () => {
        if (phase === 'busy') return
        setPhase('busy')
        try {
          const body = await post('/reload')
          if (body !== null && (body.code === 'busy' || body.code === 'slow')) {
            if (typeof window !== 'undefined') window.alert(t('slow'))
            return
          }
          if (body === null || body.ok !== true) throw new Error(body?.message ?? 'reload')
          if (body.restartReason) {
            if (typeof window !== 'undefined') window.alert(t('restartNeeded'))
            return
          }
          if (store.settings.rebuildAfterReload) {
            window.setTimeout(() => window.location.reload(), 350)
          }
        } catch (error) {
          if (typeof window !== 'undefined') {
            window.alert(`${t('reloadFailed')}：${String(error?.message ?? error)}`)
          }
        } finally {
          setPhase('idle')
        }
      }

      const tooltip =
        tipShown && phase !== 'busy'
          ? h(
              'span',
              { style: { ...styleObject(TOOLTIP_STYLE), position: 'absolute', left: 'auto', right: 0, top: 'calc(100% + 6px)', transform: 'none', display: 'flex' } },
              h('span', null, t('reload')),
              h('span', { style: { opacity: 0.62, fontSize: '10.5px' } }, t('reloadHint')),
            )
          : null

      return h(
        'span',
        {
          style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
          onPointerEnter: () => setHover(true),
          onPointerLeave: () => setHover(false),
        },
        h(
          'button',
          {
            type: 'button',
            style: {
              ...HEADER_BUTTON_STYLE,
              background: hover ? 'rgba(0,0,0,.05)' : 'transparent',
              opacity: hover ? 1 : HEADER_OPACITY,
            },
            'aria-label': t('reload'),
            disabled: phase === 'busy',
            'aria-busy': phase === 'busy' ? 'true' : undefined,
            onClick: press,
            dangerouslySetInnerHTML: { __html: ICON_REFRESH },
          },
        ),
        tooltip,
      )
    }

    /** `a:b;c:d` → object, so the DOM and React paths share one style string. */
    function styleObject(cssText) {
      const result = {}
      for (const part of String(cssText).split(';')) {
        const index = part.indexOf(':')
        if (index <= 0) continue
        const key = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        if (key === '' || value === '') continue
        result[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      }
      return result
    }

    // ---------------------------------------------------------------- settings page

    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '12px 0',
      borderBottom: '1px solid rgba(127,127,127,.18)',
    }

    function SettingsRow({ label, hint, checked, onChange }) {
      return h(
        'label',
        { style: ROW_STYLE },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
          style: { marginTop: '2px' },
        }),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { style: { fontSize: '13px' } }, label),
          h('span', { style: { fontSize: '12px', opacity: 0.7 } }, hint),
        ),
      )
    }

    function SettingsPanel() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      const [status, setStatus] = React.useState('')

      React.useEffect(() => {
        store.listeners.add(force)
        if (!store.loaded) void refreshState()
        return () => {
          store.listeners.delete(force)
        }
      }, [])

      const change = async (key) => {
        const next = { ...store.settings, [key]: !store.settings[key] }
        store.settings = next
        force()
        try {
          await saveSettings({ [key]: next[key] })
          setStatus(t('saved'))
        } catch (error) {
          setStatus(`${t('saveFailed')}：${String(error?.message ?? error)}`)
        }
      }

      return h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h3', { style: { margin: '0 0 4px', fontSize: '14px', fontWeight: 600 } }, t('settings')),
        h('p', { style: { margin: '0 0 8px', fontSize: '12px', opacity: 0.7 } }, t('settingsIntro')),
        h(SettingsRow, {
          label: t('confirmDangerLabel'),
          hint: t('confirmDangerHint'),
          checked: store.settings.confirmRestart !== false,
          onChange: () => change('confirmRestart'),
        }),
        h(SettingsRow, {
          label: t('confirmReloadLabel'),
          hint: t('confirmReloadHint'),
          checked: store.settings.confirmReload === true,
          onChange: () => change('confirmReload'),
        }),
        h(SettingsRow, {
          label: t('rebuildLabel'),
          hint: t('rebuildHint'),
          checked: store.settings.rebuildAfterReload !== false,
          onChange: () => change('rebuildAfterReload'),
        }),
        h(
          'p',
          { style: { margin: '10px 0 0', fontSize: '12px', opacity: 0.7 } },
          `${t('logLabel')}：%TEMP%\\dsh-refresh-restart.log`,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Ask the Host what it is before drawing anything: `/state` decides whether
        // the power buttons exist at all (they only make sense in the desktop app).
        refreshState().catch(() => {})
        // Mount the brand buttons first and on their own: they need no slot, and
        // a slot that refuses registration must not take them down with it.
        try {
          ctx.effect(() => mountBrandButtons(), 'dsh-refresh: brand buttons')
        } catch (error) {
          console.warn('[dsh-refresh] brand buttons not mounted:', error)
        }
        // Conversation header utility row: same seat dsh-unlag uses.
        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'dsh-refresh',
                order: 29,
                label: () => t('reload'),
              },
              ReloadButton,
            ),
          )
        } catch (error) {
          console.warn('[dsh-refresh] reload button not registered:', error)
        }
        // Settings → 「刷新与重启」.
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-refresh',
                order: 100,
                label: () => t('settings'),
              },
              SettingsPanel,
            ),
          )
        } catch (error) {
          console.warn('[dsh-refresh] settings page not registered:', error)
        }
      },
    }
  },
})
