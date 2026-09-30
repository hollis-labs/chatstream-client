// Reconnect, resume, dedupe, gap and terminal behaviour against a scripted fake
// server (drop, overlap, gap, 404, stuck: go-chatstream's conformance/fakeserver
// vocabulary) and go-ssekit's client rules: reconnect with the last event id,
// backoff, a server `retry:` honoured and capped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createChatStreamClient, HttpStatusError, NotEventStreamError, ReconnectLimitError, FrameTooLargeError,
} from '../dist/index.js'
import { sse, run, scripted, createFakeServer, collect } from './fixtures/fake-server.js'

const URL_ = 'https://hub.example/api/streams/run-1/events'
const fast = { backoff: () => 0, idleTimeoutMs: 0 }
const open = (server, o = {}, cursor = null) => {
  const client = createChatStreamClient(URL_, { fetch: server.fetch, ...fast, ...o })
  const ac = new AbortController()
  return { client, ac, events: () => collect(client.open(cursor, ac.signal)) }
}
const verbs = (evs) => evs.map((e) => e.verb)
const seqs = (evs) => evs.map((e) => e.seq)

test('a complete run: one request, no Last-Event-ID, seq copied from the SSE id, ends at the terminal event', async () => {
  const server = scripted([[{ send: run(3) }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(seqs(evs), [1, 2, 3, 4, 5, 6])
  assert.equal(evs.at(-1).verb, 'run.finish')
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].lastEventId, null)
  assert.equal(server.requests[0].headers.accept, 'text/event-stream')
})

test('drop: reconnects with the last seq as Last-Event-ID and yields each event once, in order', async () => {
  const blocks = run(5) // seq 1..8
  const server = scripted([[{ send: blocks.slice(0, 4) }, { drop: true }], [{ send: blocks.slice(4) }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(seqs(evs), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(server.requests.map((r) => r.lastEventId), [null, '4'])
})

test('a clean close with no terminal event is not the end: it reconnects', async () => {
  const blocks = run(2)
  const server = scripted([[{ send: blocks.slice(0, 2) }, { close: true }], [{ send: blocks.slice(2) }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(seqs(evs), [1, 2, 3, 4, 5])
  assert.deepEqual(server.requests.map((r) => r.lastEventId), [null, '2'])
})

test('overlap: a server that replays from before the cursor does not duplicate events', async () => {
  const blocks = run(5)
  const server = scripted([[{ send: blocks.slice(0, 5) }, { drop: true }], [{ send: blocks.slice(2) }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(seqs(evs), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(evs.filter((e) => e.verb === 'gap').length, 0)
})

test('the cursor is header-only: the request URL is never modified (no query fallback)', async () => {
  const blocks = run(3)
  const server = scripted([[{ send: blocks.slice(0, 3) }, { drop: true }], [{ send: blocks.slice(3) }, { close: true }]])
  await open(server, {}, { seq: 0 }).events()
  await open(scripted([[{ send: blocks.slice(3) }, { close: true }]]), {}, { seq: 3 }).events()
  for (const r of server.requests) assert.equal(r.url, URL_)
  const s2 = scripted([[{ send: blocks.slice(3) }, { close: true }]])
  await open(s2, {}, { seq: 3 }).events()
  assert.equal(s2.requests[0].url, URL_)
  assert.equal(s2.requests[0].lastEventId, '3', 'a given cursor is sent on the first request')
})

test('gap (client-detected): a resume that skips events yields a gap event first, and onGap is called once', async () => {
  const blocks = run(5) // seq 1..8
  const server = scripted([[{ send: blocks.slice(0, 3) }, { drop: true }], [{ send: blocks.slice(6) }, { close: true }]])
  const { client, events } = open(server)
  const gaps = []
  client.onGap((g) => gaps.push(g))
  const evs = await events()
  assert.deepEqual(verbs(evs).slice(2, 5), ['part.delta', 'gap', 'part.delta'])
  const gap = evs.find((e) => e.verb === 'gap')
  assert.equal(gap.seq, 0, 'a synthesized gap event is not sequenced and does not move the cursor')
  assert.deepEqual([gap.from, gap.to, gap.reason], [4, 6, 'client_detected'])
  assert.deepEqual(gaps, [{ from: 4, to: 6, reason: 'client_detected', source: 'client' }])
  assert.deepEqual(server.requests.map((r) => r.lastEventId), [null, '3'])
})

test('gap (in-band): a server gap event is forwarded once, reported, and covers its range', async () => {
  const server = scripted([[
    { send: [
      sse(0, { verb: 'gap', from: 1, to: 9, reason: 'retention' }), // an id-less control frame
      sse(10, { verb: 'run.start' }),
      sse(11, { verb: 'run.finish', reason: 'stop' }),
    ] },
    { close: true },
  ]])
  const { client, events } = open(server)
  const gaps = []
  client.onGap((g) => gaps.push(g))
  const evs = await events()
  assert.deepEqual(verbs(evs), ['gap', 'run.start', 'run.finish'], 'no second, client-detected gap for what the server announced')
  assert.deepEqual(gaps, [{ from: 1, to: 9, reason: 'retention', source: 'server' }])
})

test('an id-less control frame is not mistaken for a duplicate of the previous frame', async () => {
  const server = scripted([[
    { send: [sse(1, { verb: 'run.start' }), sse(2, { verb: 'activity', kind: 'x' }), sse(0, { verb: 'gap', from: 3, to: 3, reason: 'dropped_slow' }), sse(4, { verb: 'run.finish' })] },
    { close: true },
  ]])
  assert.deepEqual(verbs(await open(server).events()), ['run.start', 'activity', 'gap', 'run.finish'])
})

test('first attach (no cursor) at seq 1 is not a gap', async () => {
  const server = scripted([[{ send: run(1) }, { close: true }]])
  const { client, events } = open(server)
  const gaps = []
  client.onGap((g) => gaps.push(g))
  const evs = await events()
  assert.equal(evs.filter((e) => e.verb === 'gap').length, 0)
  assert.deepEqual(gaps, [])
})

test('first attach (no cursor) whose first event is seq 5, announced by nothing, IS a gap of 1..4', async () => {
  const server = scripted([[{ send: [sse(5, { verb: 'part.delta', part_id: 'p', text: 'x' }), sse(6, { verb: 'run.finish' })] }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(verbs(evs), ['gap', 'part.delta', 'run.finish'])
  assert.deepEqual([evs[0].from, evs[0].to], [1, 4])
})

test('attach with a cursor: the next seq is not a gap, a later one is', async () => {
  const ok = scripted([[{ send: [sse(5, { verb: 'part.delta' }), sse(6, { verb: 'run.finish' })] }, { close: true }]])
  assert.deepEqual(verbs(await open(ok, {}, { seq: 4 }).events()), ['part.delta', 'run.finish'])
  const skipped = scripted([[{ send: [sse(9, { verb: 'part.delta' }), sse(10, { verb: 'run.finish' })] }, { close: true }]])
  const evs = await open(skipped, {}, { seq: 4 }).events()
  assert.deepEqual([evs[0].verb, evs[0].from, evs[0].to], ['gap', 5, 8])
})

test('404 on resume is final: it throws once and does not retry', async () => {
  const blocks = run(3)
  const server = scripted([[{ send: blocks.slice(0, 3) }, { drop: true }], [{ status: 404 }]])
  const { events } = open(server)
  await assert.rejects(events(), (e) => e instanceof HttpStatusError && e.status === 404)
  assert.equal(server.requests.length, 2)
})

test('5xx, 408 and 429 are retried; other 4xx are final', async () => {
  for (const code of [500, 503, 408, 429]) {
    const server = scripted([[{ status: code }], [{ send: run(1) }, { close: true }]])
    const evs = await open(server).events()
    assert.equal(evs.at(-1).verb, 'run.finish', `status ${code}`)
    assert.equal(server.requests.length, 2, `status ${code}`)
  }
  for (const code of [400, 401, 403, 410]) {
    const server = scripted([[{ status: code }], [{ send: run(1) }, { close: true }]])
    await assert.rejects(open(server).events(), (e) => e.status === code, `status ${code}`)
    assert.equal(server.requests.length, 1, `status ${code}`)
  }
})

test('isFinalStatus overrides which statuses end the stream', async () => {
  const server = scripted([[{ status: 503 }], [{ send: run(1) }, { close: true }]])
  await assert.rejects(open(server, { isFinalStatus: (s) => s === 503 }).events(), HttpStatusError)
  assert.equal(server.requests.length, 1)
})

test('a 200 that is not text/event-stream is final', async () => {
  const server = createFakeServer((_r, conn) => conn.respond({ headers: { 'content-type': 'application/json' } }))
  await assert.rejects(open(server).events(), NotEventStreamError)
})

test('204 ends the stream without an error and without reconnecting', async () => {
  const server = scripted([[{ status: 204 }]])
  assert.deepEqual(await open(server).events(), [])
  assert.equal(server.requests.length, 1)
})

test('a network failure to connect is retried like any drop', async () => {
  let n = 0
  const real = scripted([[{ send: run(1) }, { close: true }]])
  const fetch = (u, i) => (n++ === 0 ? Promise.reject(new TypeError('failed to fetch')) : real.fetch(u, i))
  const evs = await collect(createChatStreamClient(URL_, { fetch, ...fast }).open(null, new AbortController().signal))
  assert.equal(evs.at(-1).verb, 'run.finish')
  assert.equal(n, 2)
})

test('backoff: attempt counts consecutive failures and resets once events arrive', async () => {
  const blocks = run(6) // seq 1..9
  const server = scripted([
    [{ status: 503 }], [{ status: 503 }], [{ status: 503 }],
    [{ send: blocks.slice(0, 2) }, { drop: true }],
    [{ status: 503 }],
    [{ send: blocks.slice(2) }, { close: true }],
  ])
  const attempts = []
  await open(server, { backoff: (n) => { attempts.push(n); return 0 } }).events()
  assert.deepEqual(attempts, [0, 1, 2, 0, 1], 'three failures climb; the connection that delivered events resets the count (its own reconnect waits backoff(0)); the next failure climbs to 1')
})

test('the default backoff is 1, 2, 4, 8, 16 seconds with jitter, repeating the last', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = scripted([...Array(6).fill([{ status: 503 }]), [{ send: run(1) }, { close: true }]])
  const { client, ac } = open(server, { backoff: undefined, idleTimeoutMs: 0 })
  const p = collect(client.open(null, ac.signal))
  const settle = async () => { for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r)) }
  const waits = []
  for (let i = 0; i < 6; i++) {
    await settle()
    const seen = server.requests.length
    let waited = 0
    while (server.requests.length === seen && waited < 20000) { t.mock.timers.tick(100); waited += 100; await settle() }
    waits.push(waited)
  }
  await p
  const expect = [1000, 2000, 4000, 8000, 16000, 16000]
  waits.forEach((w, i) => assert.ok(w >= expect[i] * 0.8 - 100 && w <= expect[i] * 1.2 + 100, `wait ${i} was ${w}ms, want ~${expect[i]}ms`))
})

test('a server retry: replaces the schedule, and is capped by maxServerRetryMs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = scripted([
    [{ send: run(1).slice(0, 2) }, { retry: 250 }, { drop: true }],
    [{ send: run(1).slice(2) }, { close: true }],
  ])
  const { client, ac } = open(server, { backoff: () => 99999, idleTimeoutMs: 0 })
  const p = collect(client.open(null, ac.signal))
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r))
  assert.equal(server.requests.length, 1)
  t.mock.timers.tick(249)
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r))
  assert.equal(server.requests.length, 1, 'not before the server\'s retry')
  t.mock.timers.tick(1)
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r))
  assert.equal(server.requests.length, 2, 'at the server\'s retry, not the schedule\'s 99999')
  await p

  const capped = scripted([[{ send: run(1).slice(0, 2) }, { retry: 86_400_000 }, { drop: true }], [{ send: run(1).slice(2) }, { close: true }]])
  const c2 = open(capped, { idleTimeoutMs: 0, maxServerRetryMs: 5000, backoff: () => 0 })
  const p2 = collect(c2.client.open(null, c2.ac.signal))
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r))
  t.mock.timers.tick(5000)
  for (let k = 0; k < 30; k++) await new Promise((r) => setImmediate(r))
  assert.equal(capped.requests.length, 2, 'a day-long retry: is capped')
  await p2
})

test('maxReconnects: gives up with the last cause after that many consecutive fruitless reconnects', async () => {
  const server = scripted([[{ status: 503 }], [{ status: 503 }], [{ status: 503 }]])
  await assert.rejects(open(server, { maxReconnects: 2 }).events(), (e) => e instanceof ReconnectLimitError && e.cause.status === 503)
  assert.equal(server.requests.length, 3)
})

test('every terminal verb ends the stream and nothing reconnects: run.finish, run.error, run.abort', async () => {
  for (const verb of ['run.finish', 'run.error', 'run.abort']) {
    const server = scripted([[{ send: [sse(1, { verb: 'run.start' }), sse(2, { verb }), sse(3, { verb: 'part.delta' })] }, { drop: true }]])
    const evs = await open(server).events()
    assert.deepEqual(verbs(evs), ['run.start', verb], verb)
    assert.equal(server.requests.length, 1, verb)
  }
})

// The spike treated every `error` as terminal. Here only the three terminal verbs are, and
// everything else that goes wrong leaves the run open.
test('non-terminal errors do not end the stream: a raw dialect error, a rate-limit activity, a malformed frame, an unknown verb, a dropped connection', async () => {
  const server = scripted([
    [{ send: [
      sse(1, { verb: 'run.start' }),
      sse(2, { verb: 'raw', raw: { dialect: 'claude.stream-json', type: 'error', payload: { error: 'overloaded' } } }),
      sse(3, { verb: 'activity', kind: 'claude.assistant_error', value: { error: 'rate_limit' } }),
      'id: 4\nevent: raw\ndata: { this is not json\n\n',
      sse(5, { verb: 'a.verb.from.the.future', whatever: true }),
    ] }, { drop: true }],
    [{ send: [sse(6, { verb: 'part.delta', text: 'still here' }), sse(7, { verb: 'run.finish', reason: 'stop' })] }, { close: true }],
  ])
  const evs = await open(server).events()
  assert.deepEqual(verbs(evs), ['run.start', 'raw', 'activity', 'raw', 'a.verb.from.the.future', 'part.delta', 'run.finish'])
  assert.equal(evs[3].raw.type, 'malformed_frame')
  assert.equal(evs[3].raw.payload, '{ this is not json')
  assert.equal(evs[3].seq, 4, 'the malformed frame still moves the cursor: it was received')
  assert.equal(server.requests.length, 2)
})

test('a data frame that is JSON but not an event is preserved as raw, not fatal', async () => {
  const server = scripted([[{ send: ['data: [1,2]\n\n', 'data: "text"\n\n', 'data: {"no":"verb"}\n\n', sse(1, { verb: 'run.finish' })] }, { close: true }]])
  const evs = await open(server).events()
  assert.deepEqual(verbs(evs), ['raw', 'raw', 'raw', 'run.finish'])
})

test('a run.error that IS terminal (Go: stream_lost, retryable, no id) ends the stream', async () => {
  const server = scripted([[{ send: [sse(1, { verb: 'run.start' }), sse(0, { verb: 'run.error', code: 'stream_lost', retryable: true })] }, { close: true }]])
  const evs = await open(server).events()
  assert.equal(evs.at(-1).verb, 'run.error')
  assert.equal(server.requests.length, 1)
})

test('aborting the signal ends the iteration quietly and cancels the connection', async () => {
  let conn
  const server = createFakeServer((_r, c) => { conn = c; c.respond(); c.send(sse(1, { verb: 'run.start' })) })
  const ac = new AbortController()
  const client = createChatStreamClient(URL_, { fetch: server.fetch, ...fast })
  const got = []
  for await (const ev of client.open(null, ac.signal)) {
    got.push(ev)
    ac.abort()
  }
  assert.equal(got.length, 1)
  assert.equal(conn.signal.aborted, true)
  const before = await collect(client.open(null, ac.signal))
  assert.deepEqual(before, [], 'an already-aborted signal opens nothing')
  assert.equal(server.requests.length, 1)
})

test('breaking out of the loop early cancels the connection too', async () => {
  let conn
  const server = createFakeServer((_r, c) => { conn = c; c.respond(); c.send(run(3).join('')) })
  const client = createChatStreamClient(URL_, { fetch: server.fetch, ...fast })
  for await (const ev of client.open(null, new AbortController().signal)) { if (ev.seq === 2) break }
  assert.equal(conn.signal.aborted, true)
})

test('an event larger than maxEventBytes is final: FrameTooLargeError, no retry', async () => {
  const server = scripted([[{ send: [`data: ${'x'.repeat(500)}\n\n`] }, { close: true }]])
  await assert.rejects(open(server, { maxEventBytes: 100 }).events(), FrameTooLargeError)
  assert.equal(server.requests.length, 1)
})

test('extra headers (object or function) are sent on every connection', async () => {
  let n = 0
  const server = scripted([[{ send: run(1).slice(0, 2) }, { drop: true }], [{ send: run(1).slice(2) }, { close: true }]])
  await open(server, { headers: () => ({ authorization: `Bearer t${++n}` }) }).events()
  assert.deepEqual(server.requests.map((r) => r.headers.authorization), ['Bearer t1', 'Bearer t2'])
})

test('cursorOf, isTerminal, reconcile and capabilities', async () => {
  const { client } = open(scripted([]))
  assert.deepEqual(client.cursorOf({ seq: 9 }), { seq: 9 })
  assert.equal(client.isTerminal({ verb: 'run.finish' }), true)
  assert.equal(client.isTerminal({ verb: 'raw' }), false)
  assert.equal(client.isTerminal({ verb: 'gap' }), false)
  assert.deepEqual(await client.reconcile(null), { resume: false })
  assert.deepEqual(await client.reconcile({ status: 'done', lastSeq: 9 }), { resume: false })
  assert.deepEqual(await client.reconcile({ status: 'error', lastSeq: 9 }), { resume: false })
  assert.deepEqual(await client.reconcile({ status: 'streaming', lastSeq: 9 }), { resume: true, probe: { seq: 9 } })
  assert.deepEqual(await client.reconcile({ status: 'stalled' }), { resume: true, probe: { seq: 0 } })
  const caps = client.capabilities()
  assert.equal(caps.ResumeCursor, true)
  assert.equal(caps.Framing, 1)
  caps.Tools = true
  assert.equal(client.capabilities().Tools, false, 'capabilities are a value: a caller cannot change the client\'s')
  const over = createChatStreamClient(URL_, { capabilities: { Tools: true, Text: 1 } }).capabilities()
  assert.deepEqual([over.Tools, over.Text, over.Framing], [true, 1, 1])
})
