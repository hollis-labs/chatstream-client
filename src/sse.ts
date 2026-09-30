// A WHATWG server-sent-events parser over bytes. It is here, and not a dependency,
// because the client has none; it follows the same rules go-ssekit's parser does:
// an incomplete event at end of input is discarded, chunking never changes the
// result, a CR ends a line immediately, and a `retry:` is reported even when no
// event follows it.
import { FrameTooLargeError } from './types.js'

export interface SseFrame {
  /** The `event:` field; `message` when the block had none. */
  event: string
  /** The `data:` lines joined with LF. */
  data: string
  /**
   * The `id:` field of THIS block, or null when the block had none (or an empty or
   * NUL-carrying one). It is not the running last-event-id of the WHATWG API: a
   * control frame with no id line must not inherit the previous frame's cursor.
   */
  id: string | null
  /** The `retry:` field of this block, in milliseconds, or null. */
  retry: number | null
}

export interface SseParserOptions {
  /** Called as soon as a valid `retry:` line is read, even in a block that never dispatches. */
  onRetry?: (ms: number) => void
  /** Largest event (or unterminated line) in characters of decoded text. Default 16 MiB. */
  maxEventBytes?: number
}

export const DEFAULT_MAX_EVENT_BYTES = 16 << 20

export class SseParser {
  #decoder = new TextDecoder('utf-8')
  #buf = ''
  #started = false
  #skipLF = false
  #event = ''
  #data: string[] = []
  #hasData = false
  #id: string | null = null
  #retry: number | null = null
  #size = 0
  readonly #max: number
  readonly #onRetry: ((ms: number) => void) | undefined

  constructor(o: SseParserOptions = {}) {
    this.#max = o.maxEventBytes && o.maxEventBytes > 0 ? o.maxEventBytes : DEFAULT_MAX_EVENT_BYTES
    this.#onRetry = o.onRetry
  }

  /** Feeds bytes (or already-decoded text) and returns the frames they complete. */
  push(chunk: Uint8Array | string): SseFrame[] {
    let text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true })
    if (!this.#started && text.length > 0) {
      this.#started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    if (this.#skipLF && text.length > 0) {
      this.#skipLF = false
      if (text.charCodeAt(0) === 10) text = text.slice(1)
    }
    const scanFrom = this.#buf.length // what is left over holds no line break: scan only the new text
    this.#buf += text
    const out: SseFrame[] = []
    let i = scanFrom
    let start = 0
    const buf = this.#buf
    while (i < buf.length) {
      const c = buf.charCodeAt(i)
      if (c === 10 || c === 13) {
        this.#line(buf.slice(start, i), out)
        if (c === 13) {
          if (i + 1 < buf.length) {
            if (buf.charCodeAt(i + 1) === 10) i++
          } else {
            this.#skipLF = true // the LF of a CRLF may open the next chunk
          }
        }
        i++
        start = i
      } else {
        i++
      }
    }
    this.#buf = buf.slice(start)
    if (this.#buf.length > this.#max) throw new FrameTooLargeError(this.#max)
    return out
  }

  /** Ends the input. An event with no blank line after it is discarded, as the specification requires. */
  end(): SseFrame[] {
    this.#decoder.decode()
    this.#buf = ''
    this.#reset()
    return []
  }

  #reset(): void {
    this.#event = ''
    this.#data = []
    this.#hasData = false
    this.#id = null
    this.#retry = null
    this.#size = 0
  }

  #line(line: string, out: SseFrame[]): void {
    if (line === '') {
      if (this.#hasData) {
        out.push({ event: this.#event || 'message', data: this.#data.join('\n'), id: this.#id ? this.#id : null, retry: this.#retry })
      }
      this.#reset()
      return
    }
    if (line.charCodeAt(0) === 58) return // a comment
    const colon = line.indexOf(':')
    let field = line
    let value = ''
    if (colon >= 0) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.charCodeAt(0) === 32) value = value.slice(1)
    }
    this.#size += line.length
    if (this.#size > this.#max) throw new FrameTooLargeError(this.#max)
    switch (field) {
      case 'event':
        this.#event = value
        break
      case 'data':
        this.#data.push(value)
        this.#hasData = true
        break
      case 'id':
        if (!value.includes('\0')) this.#id = value
        break
      case 'retry':
        if (/^[0-9]+$/.test(value)) {
          const ms = Math.min(Number(value), Number.MAX_SAFE_INTEGER)
          this.#retry = ms
          this.#onRetry?.(ms)
        }
        break
    }
  }
}
