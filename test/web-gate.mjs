/**
 * Offline check for the "web (non-desktop) build hides the power buttons" gate.
 *
 * Deliberately a separate process: the client keeps its `/state` answer in module
 * scope, so the only way to see what a browser-only install looks like is to boot
 * the module fresh with a Host that reports `desktop: false`.
 */
import assert from 'node:assert/strict'

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

const row = new FakeElement('div')
row.className = 'wtg9ga_logoRow'
const body = new FakeElement('body')

const requests = []
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  body,
  createElement: (tagName) => new FakeElement(tagName),
  querySelector: (selector) => (String(selector).includes('logoRow') ? row : null),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  // `dsh web` reports itself as a plain browser: no Electron, no desktop app.
  fetch: async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return {
      status: 200,
      ok: true,
      async json() {
        return {
          ok: true,
          desktop: false,
          desktopReason: 'not-electron',
          hmr: true,
          settings: { confirmRestart: true, confirmReload: false, rebuildAfterReload: true },
        }
      },
    }
  },
  setInterval() {
    return 0
  },
  clearInterval() {},
  setTimeout() {
    return 0
  },
  clearTimeout() {},
  confirm: () => true,
  alert() {},
}
// Node already exposes `navigator` (read-only); the client tolerates that.
globalThis.fetch = globalThis.window.fetch
// Only the re-attach interval is stubbed; real timers keep `await` working.
globalThis.setInterval = globalThis.window.setInterval
globalThis.clearInterval = globalThis.window.clearInterval

let entry = null
globalThis.window.__ModuleLoader__ = {
  load(value) {
    entry = value
  },
}

await import('../client.js')
assert.ok(entry !== null, 'the client half registers itself')

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

const client = entry.factory(() => react)
const registered = []
const ctx = {
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options) {
      registered.push(options)
      return { dispose() {} }
    },
  },
  effect(callback) {
    callback()
    return () => {}
  },
}

client.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 0))

const brandGroups = row.children.filter((child) => child.dataset?.dshRefreshBrand === 'true')
assert.equal(brandGroups.length, 0, 'no power buttons when the Host is a plain browser build')
assert.equal(row.children.length, 0, 'nothing is appended to the brand row at all')

const stateCalls = requests.filter((item) => item.url === '/dsh-restart-refresh/state')
assert.equal(stateCalls.length, 1, 'the client asks the Host once at boot')
assert.equal(
  requests.filter((item) => item.init?.method === 'POST').length,
  0,
  'booting never posts anything',
)
assert.equal(registered.length, 2, 'the header button and the settings page are still offered')

console.log('web gate checks passed')
