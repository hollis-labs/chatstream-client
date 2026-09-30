// Property tests over the client's own parsing and resume logic (seeded, reproducible).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatStreamClient } from '../dist/index.js'
import { sse, run, scripted, createFakeServer, collect } from './fixtures/fake-server.js'

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const fast = { backoff: () => 0, idleTimeoutMs: 0 }
const go = (server, o = {}) => collect(createChatStreamClient('https://x/e', { fetch: server.fetch, ...fast, ...o }).open(null, new AbortController().signal))

test('property: random drops and overlaps deliver every event exactly once, in order, with no gap (300 runs)', async () => {
  const r = rng(11)
  for (let n = 0; n < 300; n++) {
    const len = 1 + Math.floor(r() * 12)
    const blocks = run(len) // seq 1..len+3
    const total = blocks.length
    // cut the run at random points; each reconnect replays from up to 3 events before the cut
    const cuts = [...new Set(Array.from({ length: Math.floor(r() * 4) }, () => 1 + Math.floor(r() * (total - 1))))].sort((a, b) => a - b)
    const plan = []
    let from = 0
    for (const cut of cuts) {
      plan.push([{ send: blocks.slice(from, cut) }, { drop: true }])
      from = Math.max(0, cut - Math.floor(r() * 4))
    }
    plan.push([{ send: blocks.slice(from) }, { close: true }])
    const evs = await go(scripted(plan))
    assert.deepEqual(evs.map((e) => e.seq), Array.from({ length: total }, (_, i) => i + 1), `run ${n}: cuts ${cuts}`)
  }
})

test('property: arbitrary frames never make the client throw, and a sequenced event is never delivered twice (300 runs)', async () => {
  const r = rng(99)
  const bodies = ['{}', '[]', 'null', '"s"', '1', '{"verb":1}', '{"verb":"part.delta","text":5}', '{"verb":"activity"}', 'not json', '{"verb":"gap","from":"x","to":-3}', '{"verb":"gap","from":5,"to":9}', '{"verb":"raw","seq":-4}', '{"verb":"usage","seq":1.5}', '']
  const ids = ['', '1', '2', '3', '3', '7', 'x', '-1', '99999999999999999999', '5']
  for (let n = 0; n < 300; n++) {
    let text = ''
    for (let i = 0, k = Math.floor(r() * 20); i < k; i++) {
      const id = ids[Math.floor(r() * ids.length)]
      text += `${id !== '' ? `id: ${id}\n` : ''}data: ${bodies[Math.floor(r() * bodies.length)]}\n\n`
    }
    text += sse(1000, { verb: 'run.finish' })
    const server = createFakeServer((_q, c) => { c.respond(); c.send(text); c.close() })
    const evs = await go(server)
    assert.equal(evs.at(-1).verb, 'run.finish')
    const sequenced = evs.filter((e) => e.seq > 0).map((e) => e.seq)
    assert.deepEqual(sequenced, [...new Set(sequenced)].sort((a, b) => a - b), 'strictly increasing')
    for (const e of evs) {
      assert.equal(typeof e.verb, 'string')
      assert.ok(Number.isSafeInteger(e.seq) && e.seq >= 0)
    }
  }
})

test('property: however the bytes are chunked on the wire, the events are the same (200 runs)', async () => {
  const r = rng(5)
  const text = run(9).join('') + ': keepalive\n\n'
  const enc = new TextEncoder().encode(text)
  const whole = (await go(createFakeServer((_q, c) => { c.respond(); c.send(enc); c.close() }))).map((e) => [e.seq, e.verb, e.text])
  for (let n = 0; n < 200; n++) {
    const server = createFakeServer((_q, c) => {
      c.respond()
      for (let i = 0; i < enc.length;) { const len = 1 + Math.floor(r() * 30); c.send(enc.slice(i, i + len)); i += len }
      c.close()
    })
    assert.deepEqual((await go(server)).map((e) => [e.seq, e.verb, e.text]), whole)
  }
})
