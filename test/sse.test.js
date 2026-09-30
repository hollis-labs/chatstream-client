// The SSE parser: WHATWG behaviour, the rules go-ssekit's parser also keeps, and a
// property test (chunking never changes the result; arbitrary bytes never throw).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseParser, FrameTooLargeError } from '../dist/index.js'

const enc = new TextEncoder()
const parse = (...chunks) => {
  const p = new SseParser()
  const out = []
  for (const c of chunks) out.push(...p.push(typeof c === 'string' ? enc.encode(c) : c))
  out.push(...p.end())
  return out
}

test('a basic event: name, data, id', () => {
  assert.deepEqual(parse('id: 7\nevent: run.start\ndata: {"a":1}\n\n'), [
    { event: 'run.start', data: '{"a":1}', id: '7', retry: null },
  ])
})

test('multiple data lines are joined with LF; one leading space is stripped, no more', () => {
  assert.deepEqual(parse('data:  two spaces\ndata:x\ndata\n\n')[0].data, ' two spaces\nx\n')
})

test('a comment is not an event; a comment block alone yields nothing', () => {
  assert.deepEqual(parse(': keepalive\n\n'), [])
  assert.equal(parse(': hi\ndata: x\n\n')[0].data, 'x')
})

test('CRLF, CR and LF all end lines, including across chunk boundaries', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    assert.deepEqual(parse(`data: a${nl}${nl}data: b${nl}${nl}`).map((f) => f.data), ['a', 'b'], JSON.stringify(nl))
  }
  // CR at the end of one chunk, LF at the start of the next: one line end, not two
  assert.deepEqual(parse('data: a\r', '\n\r', '\ndata: b\r\n\r\n').map((f) => f.data), ['a', 'b'])
})

test('a CR ends a line immediately, without waiting for a following LF', () => {
  const p = new SseParser()
  assert.deepEqual(p.push(enc.encode('data: a\r\r')).map((f) => f.data), ['a'])
})

test('an incomplete event at end of input is discarded', () => {
  assert.deepEqual(parse('data: a\n\ndata: b\n'), [{ event: 'message', data: 'a', id: null, retry: null }])
  assert.deepEqual(parse('data: a'), [])
})

test('the id is per block: a frame with no id line has id null, not the previous frame\'s', () => {
  const frames = parse('id: 5\ndata: a\n\ndata: control\n\n')
  assert.deepEqual(frames.map((f) => f.id), ['5', null])
})

test('an empty id and an id with NUL are not ids', () => {
  assert.deepEqual(parse('id:\ndata: a\n\nid: 1\u00002\ndata: b\n\n').map((f) => f.id), [null, null])
})

test('retry: only digits count, and it is reported even when no event follows', () => {
  const seen = []
  const p = new SseParser({ onRetry: (ms) => seen.push(ms) })
  assert.deepEqual(p.push(enc.encode('retry: 1500\n\nretry: abc\n\nretry: 12x\n\n')), [])
  assert.deepEqual(seen, [1500])
  assert.equal(new SseParser().push(enc.encode('retry: 30\ndata: x\n\n'))[0].retry, 30)
})

test('a UTF-8 BOM at the start is dropped, and a character split across chunks survives', () => {
  const bytes = enc.encode('﻿data: héllo \u{1F600}\n\n')
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.equal(parse(bytes.slice(0, cut), bytes.slice(cut))[0].data, 'héllo \u{1F600}', `cut at ${cut}`)
  }
})

test('an event with an empty data line dispatches; one with no data line does not', () => {
  assert.deepEqual(parse('data:\n\n').map((f) => f.data), [''])
  assert.deepEqual(parse('event: x\nid: 3\n\n'), [])
})

test('an event over the limit throws FrameTooLargeError; so does an endless unterminated line', () => {
  const p = new SseParser({ maxEventBytes: 64 })
  assert.throws(() => p.push(enc.encode(`data: ${'x'.repeat(100)}\n\n`)), FrameTooLargeError)
  const q = new SseParser({ maxEventBytes: 64 })
  assert.throws(() => q.push(enc.encode('x'.repeat(100))), FrameTooLargeError)
})

// ---- property tests, with a seeded generator so a failure reproduces ----

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = ['data: ', 'event: ', 'id: ', 'retry: ', ': ', 'data', '\n', '\r', '\r\n', '\n\n', 'x', ' ', '{"a":1}', 'é', '\u{1F600}', '﻿', '\u0000', '12', ':', '']

function randomStream(r, n) {
  let s = ''
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)]
  return s
}

function splitAt(bytes, r) {
  const chunks = []
  let i = 0
  while (i < bytes.length) {
    const len = 1 + Math.floor(r() * 7)
    chunks.push(bytes.slice(i, i + len))
    i += len
  }
  return chunks
}

test('property: however the bytes are chunked, the frames are the same (2000 random streams)', () => {
  const r = rng(20260930)
  for (let n = 0; n < 2000; n++) {
    const bytes = enc.encode(randomStream(r, 1 + Math.floor(r() * 40)))
    const whole = parse(bytes)
    const pieces = parse(...splitAt(bytes, r))
    const bytewise = parse(...Array.from(bytes, (b) => Uint8Array.of(b)))
    assert.deepEqual(pieces, whole, `random chunking of ${JSON.stringify(new TextDecoder().decode(bytes))}`)
    assert.deepEqual(bytewise, whole, `byte-at-a-time of ${JSON.stringify(new TextDecoder().decode(bytes))}`)
  }
})

test('property: arbitrary bytes never throw except FrameTooLargeError, and never yield a frame without data (2000 random byte strings)', () => {
  const r = rng(7)
  for (let n = 0; n < 2000; n++) {
    const bytes = Uint8Array.from({ length: Math.floor(r() * 200) }, () => Math.floor(r() * 256))
    const p = new SseParser({ maxEventBytes: 150 })
    try {
      for (const c of splitAt(bytes, r)) for (const f of p.push(c)) assert.equal(typeof f.data, 'string')
      p.end()
    } catch (e) {
      assert.ok(e instanceof FrameTooLargeError, `unexpected ${e}`)
    }
  }
})
