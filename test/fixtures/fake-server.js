// A scripted fake of an SSE endpoint, in the vocabulary of go-chatstream's
// conformance/fakeserver: drop, overlap, gap, 404 on resume, stuck. It replaces
// `fetch`, records every request, and lets a test push bytes by hand.
const enc = new TextEncoder()

/** One SSE block for a chatstream event: the id carries the cursor, the event name is the verb. */
export function sse(seq, ev) {
  const body = { v: '1', seq: 0, run_id: 'run-1', time: '2026-01-01T00:00:00Z', ...ev }
  return `${seq ? `id: ${seq}\n` : ''}event: ${body.verb}\ndata: ${JSON.stringify(body)}\n\n`
}

/** A complete run of `n` text deltas, seq 1..n+3: run.start, part.start, n deltas, run.finish. */
export function run(n) {
  const blocks = [
    sse(1, { verb: 'run.start' }),
    sse(2, { verb: 'part.start', part_id: 'p', kind: 'text' }),
  ]
  for (let i = 0; i < n; i++) blocks.push(sse(3 + i, { verb: 'part.delta', part_id: 'p', text: String.fromCharCode(97 + (i % 26)) }))
  blocks.push(sse(3 + n, { verb: 'run.finish', reason: 'stop' }))
  return blocks
}

/**
 * `handler(req, conn, index)` is called for each connection. `conn` has
 * send(text), close(), drop(), status(code), respond(init) and `signal`.
 * With no `respond`/`status` call the response is 200 text/event-stream.
 */
export function createFakeServer(handler) {
  const requests = []
  let index = 0
  const fetch = (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const req = { url: String(url), headers, lastEventId: headers['last-event-id'] ?? null, init }
    requests.push(req)
    const i = index++
    const signal = init.signal
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
      let controller
      let closed = false
      const stream = new ReadableStream({ start: (c) => { controller = c } })
      let settled = false
      const abortErr = () => new DOMException('aborted', 'AbortError')
      signal?.addEventListener('abort', () => {
        if (!settled) return reject(abortErr())
        if (!closed) { closed = true; try { controller.error(abortErr()) } catch { /* already closed */ } }
      }, { once: true })
      const conn = {
        signal,
        send(text) { if (!closed) controller.enqueue(typeof text === 'string' ? enc.encode(text) : text) },
        close() { if (!closed) { closed = true; controller.close() } },
        // A cut connection loses what the client has not read yet; wait for the queue to drain
        // first so a test decides exactly which frames arrived before the cut.
        drop(err = new TypeError('network error')) {
          let tries = 0
          const cut = () => {
            if (closed) return
            if (controller.desiredSize < 1 && tries++ < 200) return setImmediate(cut)
            closed = true
            controller.error(err)
          }
          setImmediate(cut)
        },
        status(code, text = '') { settled = true; closed = true; resolve(new Response(text || null, { status: code })) },
        respond(init = {}) {
          settled = true
          resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...init.headers } }))
        },
      }
      const respondDefault = () => { if (!settled) conn.respond() }
      const result = handler(req, conn, i)
      Promise.resolve(result).then(() => { if (!settled) respondDefault() }, reject)
    })
  }
  return { fetch, requests, get connections() { return index } }
}

/**
 * A plan is one list of steps per connection; a connection past the end of the plan is answered 410.
 * Steps: {send: [blocks]} | {comment: text} | {close} | {drop} | {stall} | {status: code}.
 */
export function scripted(plan) {
  return createFakeServer(async (_req, conn, i) => {
    const steps = plan[i]
    if (!steps) return conn.status(410)
    for (const step of steps) {
      if ('status' in step) return conn.status(step.status)
    }
    conn.respond()
    for (const step of steps) {
      if (step.send) for (const b of step.send) conn.send(b)
      else if ('comment' in step) conn.send(`: ${step.comment}\n\n`)
      else if (step.close) conn.close()
      else if (step.drop) conn.drop()
      else if (step.retry !== undefined) conn.send(`retry: ${step.retry}\n\n`)
      else if (step.stall) return // hold the connection open and silent until the client hangs up
    }
  })
}

export async function collect(iterable) {
  const out = []
  for await (const ev of iterable) out.push(ev)
  return out
}

/** Lets pending promise jobs run without advancing (mocked) time. */
export const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
