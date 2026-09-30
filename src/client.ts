import { cursorOfEvent, isTerminalEvent } from './events.js'
import { DEFAULT_MAX_EVENT_BYTES, SseParser, type SseFrame } from './sse.js'
import {
  FrameTooLargeError,
  HttpStatusError,
  NotEventStreamError,
  ReconnectLimitError,
  type Capabilities,
  type ChatstreamEvent,
  type ChatStreamClient,
  type ConnectionStatus,
  type Cursor,
  type GapInfo,
  type PersistedMessage,
  type ReconcileResult,
  type StreamOptions,
} from './types.js'

const DEFAULT_IDLE_MS = 45_000
const DEFAULT_MAX_SERVER_RETRY_MS = 5 * 60_000
// A server `retry: 0` is honoured as "as soon as possible", not as "in a tight loop": a server that
// keeps closing must not be hammered.
const MIN_SERVER_RETRY_MS = 100
const DEFAULT_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000]
const JITTER = 0.2

const defaultBackoff = (attempt: number): number => {
  const base = DEFAULT_SCHEDULE_MS[Math.min(attempt, DEFAULT_SCHEDULE_MS.length - 1)]!
  return Math.max(0, base + (Math.random() * 2 - 1) * JITTER * base)
}

const defaultIsFinalStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429

/** The connection went quiet for `idleTimeoutMs`. Internal: it triggers a reconnect and is never thrown. */
class IdleError extends Error {
  constructor(ms: number) {
    super(`chatstream: no bytes for ${ms}ms`)
    this.name = 'IdleError'
  }
}

function defaultCapabilities(over: Partial<Capabilities> | undefined): Capabilities {
  return {
    Text: 0, ToolArgs: 0, Tools: false, Reasoning: 0, ReasoningRoundTrip: false, Usage: 0,
    CacheTokens: false, ReasoningTokens: false, Citations: false, Refusal: false, ServerTools: false,
    Files: false, InterleavedParts: false,
    // What this transport itself does: frames are SSE, the stream resumes from a cursor, and an
    // AbortSignal cancels it. What the producer streams (text granularity, tools, ...) is the
    // producer's to declare, through StreamOptions.capabilities.
    Cancel: true, ResumeCursor: true, Approval: 0, Framing: 1,
    ...over,
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * Builds a resumable client for the chat-stream SSE endpoint at `url`.
 *
 * The cursor is `seq`, and it travels in the `Last-Event-ID` request header only:
 * the URL is never modified.
 */
export function createChatStreamClient(url: string, o: StreamOptions = {}): ChatStreamClient {
  const gapListeners = new Set<(gap: GapInfo) => void>()
  const statusListeners = new Set<(status: ConnectionStatus) => void>()
  const isFinalStatus = o.isFinalStatus ?? defaultIsFinalStatus
  const backoff = o.backoff ?? defaultBackoff
  const idleMs = o.idleTimeoutMs ?? DEFAULT_IDLE_MS
  const maxServerRetryMs = o.maxServerRetryMs ?? DEFAULT_MAX_SERVER_RETRY_MS
  const maxReconnects = o.maxReconnects ?? Infinity
  const caps = defaultCapabilities(o.capabilities)

  const emitGap = (gap: GapInfo) => {
    for (const cb of [...gapListeners]) {
      try { cb(gap) } catch { /* a listener's failure is not the stream's */ }
    }
  }
  const emitStatus = (s: ConnectionStatus) => {
    for (const cb of [...statusListeners]) {
      try { cb(s) } catch { /* as above */ }
    }
  }

  async function* stream(cursor: Cursor | null, signal: AbortSignal): AsyncGenerator<ChatstreamEvent, void, undefined> {
    const doFetch = o.fetch ?? globalThis.fetch
    // The highest seq accounted for: received, or declared lost by a gap. First attach
    // without a cursor starts from 0, so the first event is expected at seq 1.
    let acct = cursor && isCount(cursor.seq) ? cursor.seq : 0
    // After a gap whose extent the producer did not give, the next seq cannot be checked.
    let unchecked = false
    let attempt = 0
    let progressed = false
    let serverRetry: number | null = null
    let everOpened = false

    const now = () => new Date().toISOString()
    const synthetic = (base: Partial<ChatstreamEvent>): ChatstreamEvent => ({
      v: '1', seq: 0, run_id: '', time: now(), verb: 'raw', ...base,
    })

    /** Turns one SSE frame into zero or more events, keeping `acct`, dedupe and gap state. */
    const handleFrame = (frame: SseFrame): ChatstreamEvent[] => {
      if (frame.data === '') return [] // a keepalive sent as an empty event
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        parsed = undefined
      }
      const obj = parsed as Record<string, unknown> | undefined
      let ev: ChatstreamEvent
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj) || typeof obj['verb'] !== 'string') {
        // Preserved, not dropped and not fatal: a frame that cannot be decoded is not the end of the run.
        ev = synthetic({ raw: { dialect: 'chatstream-client', type: 'malformed_frame', payload: frame.data } })
      } else {
        ev = obj as unknown as ChatstreamEvent
        if (!isCount(ev.seq)) ev.seq = 0
      }
      if (frame.id !== null && /^[0-9]+$/.test(frame.id) && Number.isSafeInteger(Number(frame.id))) {
        ev.seq = Number(frame.id) // the SSE id is the cursor; the JSON seq is 0 on the wire
      }
      const out: ChatstreamEvent[] = []
      if (ev.seq > 0) {
        if (ev.seq <= acct) return [] // already have it: an overlapping replay
        if (ev.seq > acct + 1 && !unchecked) {
          const from = acct + 1
          const to = ev.seq - 1
          out.push({ v: ev.v || '1', seq: 0, run_id: ev.run_id, time: now(), verb: 'gap', from, to, reason: 'client_detected' })
          emitGap({ from, to, reason: 'client_detected', source: 'client' })
        }
        acct = ev.seq
        unchecked = false
      } else if (ev.verb === 'gap') {
        const from = isCount(ev.from) ? ev.from : 0
        const to = isCount(ev.to) ? ev.to : 0
        emitGap({ from, to, reason: typeof ev.reason === 'string' ? ev.reason : '', source: 'server' })
        if (to > 0) {
          acct = to // what the gap covers is accounted for; do not report it a second time
          unchecked = false
        } else {
          unchecked = true
        }
      }
      out.push(ev)
      return out
    }

    for (;;) {
      if (signal.aborted) return emitStatus('closed')
      emitStatus(everOpened ? 'reconnecting' : 'connecting')
      const ac = new AbortController()
      const onCallerAbort = () => ac.abort(signal.reason)
      signal.addEventListener('abort', onCallerAbort, { once: true })
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let idleFired = false
      const disarm = () => { if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined } }
      const arm = () => {
        disarm()
        if (idleMs > 0) {
          idleTimer = setTimeout(() => {
            idleFired = true
            emitStatus('stalled')
            ac.abort()
          }, idleMs)
        }
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cause: unknown
      try {
        const extra = typeof o.headers === 'function' ? o.headers() : o.headers
        const headers = new Headers(extra)
        headers.set('Accept', 'text/event-stream')
        headers.set('Cache-Control', 'no-cache')
        if (acct > 0) headers.set('Last-Event-ID', String(acct))
        arm() // a connection that never answers is idle too
        const init: RequestInit = { method: 'GET', headers, signal: ac.signal, cache: 'no-store' }
        if (o.credentials) init.credentials = o.credentials
        const res = await doFetch(url, init)
        if (res.status === 204) {
          emitStatus('closed')
          return // the specification's "do not reconnect"
        }
        if (res.status !== 200) {
          const err = new HttpStatusError(res.status, res.statusText)
          void res.body?.cancel().catch(() => {})
          if (isFinalStatus(res.status)) throw err
          cause = err
        } else {
          const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
          if (type !== 'text/event-stream') {
            void res.body?.cancel().catch(() => {})
            throw new NotEventStreamError(res.headers.get('content-type'))
          }
          if (!res.body) throw new NotEventStreamError(null)
          everOpened = true
          emitStatus('open')
          const parser = new SseParser({
            maxEventBytes: o.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
            onRetry: (ms) => { serverRetry = ms },
          })
          reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              parser.end()
              cause = new Error('chatstream: the connection closed before a terminal event')
              break
            }
            arm() // ANY bytes count, comments and keepalives included: arrival, not content
            for (const frame of parser.push(value)) {
              for (const ev of handleFrame(frame)) {
                progressed = true
                disarm() // the watchdog measures the server's silence, not the consumer's speed
                yield ev
                if (isTerminalEvent(ev)) {
                  emitStatus('done')
                  return
                }
                arm()
              }
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return emitStatus('closed')
        if (idleFired) {
          cause = new IdleError(idleMs)
        } else if (
          err instanceof HttpStatusError || err instanceof NotEventStreamError || err instanceof FrameTooLargeError
        ) {
          throw err
        } else {
          cause = err // a network error or a body cut mid-read: an ordinary drop
        }
      } finally {
        disarm()
        signal.removeEventListener('abort', onCallerAbort)
        ac.abort()
        void reader?.cancel().catch(() => {})
      }

      if (progressed) {
        attempt = 0
        progressed = false
      }
      if (attempt >= maxReconnects) throw new ReconnectLimitError(attempt, cause)
      const delay = serverRetry !== null
        ? Math.max(Math.min(MIN_SERVER_RETRY_MS, maxServerRetryMs), Math.min(serverRetry, maxServerRetryMs))
        : Math.max(0, backoff(attempt))
      attempt++
      emitStatus('reconnecting')
      await sleep(delay, signal)
    }
  }

  return {
    open(cursor, signal) {
      return { [Symbol.asyncIterator]: () => stream(cursor, signal) }
    },
    cursorOf: cursorOfEvent,
    isTerminal: isTerminalEvent,
    reconcile(persisted: PersistedMessage | null): Promise<ReconcileResult> {
      if (!persisted || persisted.status === 'done' || persisted.status === 'error') {
        return Promise.resolve({ resume: false })
      }
      return Promise.resolve({ resume: true, probe: { seq: isCount(persisted.lastSeq) ? persisted.lastSeq : 0 } })
    },
    capabilities: () => ({ ...caps }),
    onGap(cb) {
      gapListeners.add(cb)
      return () => void gapListeners.delete(cb)
    },
    onStatus(cb) {
      statusListeners.add(cb)
      return () => void statusListeners.delete(cb)
    },
  }
}
