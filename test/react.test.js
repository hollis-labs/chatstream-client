// The ./react hook under jsdom: it follows the client's events, status and gaps,
// honours `enabled`, and aborts the connection on unmount.
import { JSDOM } from 'jsdom'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
for (const k of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useChatStream } = await import('../dist/react.js')
after(() => dom.window.close())

/** A hand-driven client: the test decides what arrives and when. */
function fakeClient() {
  const c = { signals: [], cursors: [], push: null, statusCbs: new Set(), gapCbs: new Set() }
  c.open = (cursor, signal) => {
    c.cursors.push(cursor)
    c.signals.push(signal)
    const queue = []
    let wake
    c.push = (ev) => { queue.push(ev); wake?.() }
    return { async *[Symbol.asyncIterator]() {
      while (!signal.aborted) {
        if (!queue.length) await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }) })
        while (queue.length) yield queue.shift()
      }
    } }
  }
  c.onStatus = (cb) => { c.statusCbs.add(cb); return () => c.statusCbs.delete(cb) }
  c.onGap = (cb) => { c.gapCbs.add(cb); return () => c.gapCbs.delete(cb) }
  return c
}

let last
function Probe({ client, options }) {
  last = useChatStream(client, options)
  return h('span', null, `${last.status}:${last.events.length}`)
}

test('starts idle when disabled; opens when enabled; follows events, status and gaps; aborts on unmount', async () => {
  const client = fakeClient()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => { root.render(h(Probe, { client, options: { enabled: false } })) })
  assert.equal(last.status, 'idle')
  assert.equal(client.signals.length, 0)

  await act(async () => { root.render(h(Probe, { client, options: { cursor: { seq: 4 } } })) })
  assert.equal(client.signals.length, 1)
  assert.deepEqual(client.cursors[0], { seq: 4 })
  assert.equal(last.status, 'connecting')

  await act(async () => { for (const cb of client.statusCbs) cb('open') })
  assert.equal(last.status, 'open')
  await act(async () => { client.push({ seq: 5, verb: 'run.start' }) })
  await act(async () => { client.push({ seq: 6, verb: 'part.delta' }) })
  assert.deepEqual(last.events.map((e) => e.seq), [5, 6])
  await act(async () => { for (const cb of client.gapCbs) cb({ from: 7, to: 8, reason: 'retention', source: 'server' }) })
  assert.equal(last.gaps.length, 1)

  await act(async () => { root.unmount() })
  assert.equal(client.signals[0].aborted, true, 'unmounting aborts the connection')
  assert.equal(client.statusCbs.size, 0, 'and unsubscribes')
  assert.equal(client.gapCbs.size, 0)
})

test('an error thrown by the stream surfaces as status error', async () => {
  const client = fakeClient()
  client.open = () => ({ async *[Symbol.asyncIterator]() { throw new Error('boom') } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => { root.render(h(Probe, { client })) })
  await act(async () => {})
  assert.equal(last.status, 'error')
  assert.equal(last.error.message, 'boom')
  await act(async () => { root.unmount() })
})
