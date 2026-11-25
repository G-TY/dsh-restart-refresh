/**
 * Offline checks for the Client half.
 *
 * The module is loaded through the same `window.__ModuleLoader__` entry the app
 * uses, with a fake DOM, a fake `react`, and a fake `fetch`: nothing here needs
 * a browser, a Host, or a running plugin.
 */
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- fake DOM

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.innerHTML = ''
    this.textContent = ''
    this.disabled = false
    this.isConnected = false
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event })
    }
  }

  appendChild(child) {
    if (child.parentElement !== null) child.remove()
    child.parentElement = this
    child.isConnected = true
    this.children.push(child)
    return child
  }

  remove() {
    if (this.parentElement !== null) {
      const siblings = this.parentElement.children
      siblings.splice(siblings.indexOf(this), 1)
    }
    this.parentElement = null
    this.isConnected = false
  }
}

const descendants = (node) => {
  const out = []
  const walk = (current) => {
    for (const child of current.children ?? []) {
      out.push(child)
      walk(child)
    }
    return out
  }
  walk(node)
  return out
}

const byDataset = (root, key, value = 'true') =>
  descendants(root).filter((node) => node.dataset !== undefined && node.dataset[key] === value)

const byText = (root, text) => descendants(root).filter((node) => node.textContent === text)

const row = new FakeElement('div')
row.className = 'wtg9ga_logoRow'

const body = new FakeElement('body')

// Document-level listeners are recorded so the test can fire them by hand.
const docListeners = new Map()
const document = {
  documentElement: { lang: 'zh-CN' },
  body,
  createElement: (tagName) => new FakeElement(tagName),
  querySelector: (selector) => (String(selector).includes('logoRow') ? row : null),
  addEventListener(type, listener) {
    if (!docListeners.has(type)) docListeners.set(type, new Set())
    docListeners.get(type).add(listener)
  },
  removeEventListener(type, listener) {
    docListeners.get(type)?.delete(listener)
  },
}
const fireDocument = (type, event) => {
  for (const listener of [...(docListeners.get(type) ?? [])]) listener(event)
}

// ---------------------------------------------------------------- fake react

const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useReducer(_reducer, initial) {
    return [initial, () => {}]
  },
  useEffect() {},
}

// ---------------------------------------------------------------- fake environment

let entry = null
const intervals = new Map()
let nextTimer = 1
const alerts = []
const requests = []
let stateResponse = null
let fetchOverride = null

const window = {
  alert(message) {
    alerts.push(message)
  },
  setTimeout() {
    return 0
  },
  location: {
    reload() {},
  },
}

const moduleLoader = {
  load(config) {
    entry = config
  },
}

window.__ModuleLoader__ = moduleLoader

Object.assign(globalThis, {
  window,
  document,
  __ModuleLoader__: moduleLoader,
  setInterval(callback) {
    const id = nextTimer++
    intervals.set(id, callback)
    return id
  },
  clearInterval(id) {
    intervals.delete(id)
  },
  fetch: async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (fetchOverride !== null) return fetchOverride(url, init)
    const body = stateResponse ?? {
      ok: true,
      desktop: true,
      hmr: true,
      settings: { confirmRestart: true, confirmReload: false, rebuildAfterReload: true },
    }
    return {
      status: 200,
      ok: true,
      async json() {
        return body
      },
    }
  },
})

assert.ok(entry === null, 'nothing should be loaded before importing the client half')

await import('../client.js')

assert.ok(entry !== null, 'the client half registers itself with the module loader')
assert.equal(entry.id, 'dsh-refresh', 'the module id is the package name')

const reactRequests = []
const client = entry.factory((name) => {
  reactRequests.push(name)
  assert.equal(name, 'react', 'the client half only needs react')
  return react
})
assert.deepEqual(reactRequests, ['react'])
assert.deepEqual(client.inject, ['slots'], 'the client half injects the slots service')

// ---------------------------------------------------------------- registration

const injected = []
const registered = []
const effects = []
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name)
      callback()
    },
    register(options, component) {
      registered.push({ options, component })
      return { dispose() {} }
    },
  },
  effect(callback, label) {
    effects.push({ disposable: callback(), label })
    return () => {}
  },
}

client.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 0))

assert.deepEqual(injected, ['conversation.session.header.utilities', 'settings.section'])
assert.equal(registered.length, 2, 'two slots are registered')

const [reloadSlot, settingsSlot] = registered
assert.equal(reloadSlot.options.name, 'conversation.session.header.utilities')
assert.equal(reloadSlot.options.id, 'dsh-refresh')
assert.equal(reloadSlot.options.order, 29, 'the reload button sits where dsh-unlag puts its own')
assert.equal(reloadSlot.options.label(), '刷新插件与界面')
assert.equal(typeof reloadSlot.component, 'function')

assert.equal(settingsSlot.options.name, 'settings.section')
assert.equal(settingsSlot.options.id, 'dsh-refresh')
assert.equal(settingsSlot.options.order, 100)
assert.equal(settingsSlot.options.label(), '刷新与重启')
assert.equal(typeof settingsSlot.component, 'function')

// ---------------------------------------------------------------- brand buttons

assert.equal(effects.length, 1, 'one effect mounts the brand buttons')
assert.equal(effects[0].label, 'dsh-refresh: brand buttons')

const host = row.children.find((child) => child.dataset?.dshRefreshBrand === 'true')
assert.ok(host, 'the button group is appended to the brand row')
assert.ok(
  /transform:translateY\(\d+(?:\.\d+)?px\)/.test(String(host.style.cssText)),
  'the group is nudged onto the wordmark baseline',
)

const buttons = descendants(host).filter((node) => node.tagName === 'BUTTON')
assert.equal(buttons.length, 2, 'one restart button and one quit button')

const restartButton = byDataset(host, 'dshRefreshRestart')[0]
const quitButton = byDataset(host, 'dshRefreshQuit')[0]
assert.ok(restartButton, 'the restart button is present')
assert.ok(quitButton, 'the quit button is present')
assert.equal(restartButton.attributes['aria-label'], '重启 DSH')
assert.equal(quitButton.attributes['aria-label'], '退出 DSH')
assert.ok(restartButton.innerHTML.includes('<svg'), 'the restart button carries the refresh glyph')
assert.ok(quitButton.innerHTML.includes('<svg'), 'the quit button carries the power glyph')

const tooltipOf = () =>
  body.children.find(
    (node) => node.style?.cssText !== undefined && String(node.style.cssText).includes('#1f2328'),
  )

assert.equal(tooltipOf(), undefined, 'no tooltip before hover')
restartButton.dispatch('pointerenter')
assert.equal(tooltipOf(), undefined, 'the plate waits out the delay instead of flashing')
assert.equal(restartButton.style.background, 'rgba(0,0,0,.05)', 'hovering paints the button like its neighbours')
await new Promise((resolve) => setTimeout(resolve, 700))
const tooltip = tooltipOf()
assert.ok(tooltip, 'resting on the button paints a black tooltip')
assert.equal(tooltip.style.display, 'flex', 'resting shows the tooltip')
restartButton.dispatch('pointerleave')
assert.equal(tooltipOf(), undefined, 'leaving removes it again')
assert.equal(restartButton.style.background, 'transparent', 'leaving restores the flat background')

// A re-render of the side bar drops the group; the timer puts it back.
host.remove()
assert.equal(row.children.length, 0)
for (const callback of intervals.values()) callback()
const reattached = row.children.filter((child) => child.dataset?.dshRefreshBrand === 'true')
assert.equal(reattached.length, 1, 'the group is re-attached after a re-render')
assert.equal(reattached[0], host, 'the same node is re-used')

// ---------------------------------------------------------------- red confirmation

const cardOf = () =>
  body.children.find(
    (node) => node.style?.cssText !== undefined && String(node.style.cssText).includes('#dc2626'),
  )

const postsOf = () => requests.filter((item) => item.init?.method === 'POST')

assert.equal(cardOf(), undefined, 'no confirmation before a press')

restartButton.dispatch('click')
const restartCard = cardOf()
assert.ok(restartCard, 'a press pops the small red key')
assert.ok(String(restartCard.style.cssText).includes('background:#dc2626'), 'the key is red')
assert.equal(restartCard.textContent, '重启', 'the key carries the action word only')
assert.equal(byText(restartCard, '取消').length, 0, 'there is no cancel button inside it')
assert.equal(postsOf().length, 0, 'opening the key does not call the Host yet')

// Pressing the key again folds it away without doing anything.
restartButton.dispatch('click')
assert.equal(cardOf(), undefined, 'a second press closes the key')
assert.equal(postsOf().length, 0, 'closing sends nothing')

// Walking the pointer away folds it away too (no need to aim at a target).
restartButton.dispatch('click')
assert.ok(cardOf(), 'the key is open again')
fireDocument('pointermove', { clientX: 0, clientY: 0 })
assert.ok(cardOf(), 'a pointer still on the button keeps the key open')
fireDocument('pointermove', { clientX: 4000, clientY: 4000 })
assert.equal(cardOf(), undefined, 'a pointer far away dismisses the key')

// Pressing the red key itself posts to the restart route.
restartButton.dispatch('click')
cardOf().dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 0))
const restartCall = requests.find((item) => item.url === '/dsh-refresh/restart')
assert.ok(restartCall, 'pressing the red key posts to the restart route')
assert.equal(restartCall.init.method, 'POST')

// The quit button is the other way round: its own key, its own route.
quitButton.dispatch('click')
const quitCard = cardOf()
assert.ok(quitCard, 'a press on the power glyph pops its own key')
assert.equal(quitCard.textContent, '退出')
quitCard.dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 0))
const quitCall = requests.find((item) => item.url === '/dsh-refresh/quit')
assert.ok(quitCall, 'confirming posts to the quit route')

// ---------------------------------------------------------------- failure path

requests.length = 0
alerts.length = 0
fetchOverride = async () => ({
  status: 500,
  ok: false,
  async json() {
    return { ok: false, message: '找不到桌面端进程' }
  },
})

// A fresh group is needed because the first one is now busy for good.
effects[0].disposable()
assert.equal(row.children.length, 0, 'dispose removes the group')
row.children = []
const second = []
const ctxSecond = {
  slots: { inject() {}, register() { return { dispose() {} } } },
  effect(callback, label) {
    second.push({ disposable: callback(), label })
    return () => {}
  },
}
client.apply(ctxSecond)
const hostAgain = row.children.find((child) => child.dataset?.dshRefreshBrand === 'true')
const restartAgain = byDataset(hostAgain, 'dshRefreshRestart')[0]
restartAgain.dispatch('click')
cardOf().dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(alerts.length, 1, 'a failed restart reports it')
assert.ok(alerts[0].includes('找不到桌面端进程'))
fetchOverride = null

// The second group disposes on its own.
second[0].disposable()
assert.equal(row.children.length, 0, 'dispose removes the second group')
assert.equal(intervals.size, 0, 'dispose stops the re-attach timer')

console.log('all client-half checks passed')
