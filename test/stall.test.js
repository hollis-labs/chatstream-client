// Stall detection is driven by frame ARRIVAL, not by content (kit-chat's status and
// Flux's stall timer were content-driven: only handled events counted as activity,
// so a server that was alive and sending keepalives looked stalled). Fake timers
// make time exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatStreamClient } from '../dist/index.js'
import { sse, createFakeServer, collect } from './fixtures/fake-server.js'

const URL_ = 'https://hub.example/events'
const settle = async () => { for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r)) }
async function advance(t, ms, step = 500) {
  for (let done = 0; done < ms; done += step) { t.mock.timers.tick(step); await settle() }
}
const IDLE = 30_000

function harness(t, handler, o = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const server = createFakeServer(handler)
  const client = createChatStreamClient(URL_, { fetch: server.fetch, idleTimeoutMs: IDLE, backoff: () => 0, ...o })
  const statuses = []
  client.onStatus((s) => statuses.push(s))
  const ac = new AbortController()
  const done = collect(client.open(null, ac.signal))
  const got = []
  return { server, client, ac, statuses, got, done }
}

test('a stream of heartbeat-only frames does not stall: 30 minutes of keepalive comments, one connection', async (t) => {
  let conn
  const h = harness(t, (_r, c) => { conn = c; c.respond(); c.send(sse(1, { verb: 'run.start' })) })
  await settle()
  for (let i = 0; i < 180; i++) { // a comment every 10s, three times faster than the idle timeout
    await advance(t, 10_000, 10_000)
    conn.send(': keepalive\n\n')
    await settle()
  }
  assert.equal(h.server.requests.length, 1, 'no reconnect')
  assert.ok(!h.statuses.includes('stalled'), `statuses: ${h.statuses}`)
  conn.send(sse(2, { verb: 'run.finish' }))
  const evs = await h.done
  assert.deepEqual(evs.map((e) => e.verb), ['run.start', 'run.finish'])
})

test('heartbeats sent as empty-data events, and as partial lines, count as arrival too', async (t) => {
  let conn
  const h = harness(t, (_r, c) => { conn = c; c.respond() })
  await settle()
  for (let i = 0; i < 20; i++) {
    await advance(t, 20_000, 10_000)
    conn.send(i % 2 ? 'event: heartbeat\ndata:\n\n' : 'da') // half a line is still bytes on the wire
    if (i % 2 === 0) { await settle(); conn.send('ta: ') }
    await settle()
  }
  assert.equal(h.server.requests.length, 1)
  assert.ok(!h.statuses.includes('stalled'))
  conn.send('x\n\n' + sse(1, { verb: 'run.finish' }))
  await h.done
})

test('a silent stream stalls: status goes stalled, the connection is cut, and it resumes with Last-Event-ID', async (t) => {
  const h = harness(t, (_r, c, i) => {
    c.respond()
    if (i === 0) { c.send(sse(1, { verb: 'run.start' })); c.send(sse(2, { verb: 'part.delta', text: 'a' })) }
    else { c.send(sse(3, { verb: 'part.delta', text: 'b' })); c.send(sse(4, { verb: 'run.finish' })); c.close() }
  })
  await advance(t, IDLE - 500)
  assert.equal(h.server.requests.length, 1, 'not stalled a moment before the timeout')
  assert.ok(!h.statuses.includes('stalled'))
  await advance(t, 1000)
  assert.ok(h.statuses.includes('stalled'), `statuses: ${h.statuses}`)
  await advance(t, 1000) // the reconnect's own (zero) backoff timer is a fake timer too
  assert.equal(h.server.requests.length, 2)
  assert.equal(h.server.requests[1].lastEventId, '2')
  const evs = await h.done
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4])
})

test('the timer is measured from the last byte, not from the start: activity late in the window postpones the stall', async (t) => {
  let conn
  const h = harness(t, (_r, c) => { conn = c; c.respond() })
  await settle()
  await advance(t, IDLE - 1000)
  conn.send(': still here\n\n')
  await settle()
  await advance(t, IDLE - 1000)
  assert.equal(h.server.requests.length, 1)
  await advance(t, 2000)
  await advance(t, 1000)
  assert.equal(h.server.requests.length, 2, 'stalls IDLE after the last byte')
  h.ac.abort()
  await h.done
})

test('a slow consumer is not a stall: the watchdog measures the server\'s silence, not the consumer\'s speed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let conn
  const server = createFakeServer((_r, c) => { conn = c; c.respond(); c.send(sse(1, { verb: 'run.start' })) })
  const client = createChatStreamClient(URL_, { fetch: server.fetch, idleTimeoutMs: IDLE, backoff: () => 0 })
  const statuses = []
  client.onStatus((s) => statuses.push(s))
  const seen = []
  const consumer = (async () => {
    for await (const ev of client.open(null, new AbortController().signal)) {
      seen.push(ev.verb)
      if (ev.seq === 1) await new Promise((r) => setTimeout(r, IDLE * 3)) // the consumer is busy for 90s
    }
  })()
  await settle()
  await advance(t, IDLE * 3 + 1000, 1000)
  assert.equal(server.requests.length, 1, 'no reconnect while the consumer was busy')
  assert.ok(!statuses.includes('stalled'), `statuses: ${statuses}`)
  conn.send(sse(2, { verb: 'run.finish' }))
  await consumer
  assert.deepEqual(seen, ['run.start', 'run.finish'])
})

test('a connection that never answers is stalled too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let n = 0
  const good = createFakeServer((_r, c) => { c.respond(); c.send(sse(1, { verb: 'run.finish' })); c.close() })
  const fetch = (u, init) => (n++ === 0 ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) : good.fetch(u, init))
  const client = createChatStreamClient(URL_, { fetch, idleTimeoutMs: IDLE, backoff: () => 0 })
  const statuses = []
  client.onStatus((s) => statuses.push(s))
  const p = collect(client.open(null, new AbortController().signal))
  await advance(t, IDLE + 1000)
  assert.ok(statuses.includes('stalled'))
  assert.deepEqual((await p).map((e) => e.verb), ['run.finish'])
})

test('idleTimeoutMs: 0 disables the watchdog', async (t) => {
  let conn
  const h = harness(t, (_r, c) => { conn = c; c.respond() }, { idleTimeoutMs: 0 })
  await advance(t, 60 * 60_000, 60_000)
  assert.equal(h.server.requests.length, 1)
  conn.send(sse(1, { verb: 'run.finish' }))
  await h.done
})
