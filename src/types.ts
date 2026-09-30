// Names for the generated wire types, and the hand-written contract of the client.
// Nothing here is generated; the wire vocabulary it points at is, from manifest/.
import type {
  ChatstreamCapabilitiesData,
  ChatstreamEventApprovalMode,
  ChatstreamEventData,
  ChatstreamEventErrorCode,
  ChatstreamEventFinishReason,
  ChatstreamEventGapReason,
  ChatstreamEventPartKind,
  ChatstreamEventUsage,
  ChatstreamEventVerb,
} from './generated/chatstream-types.generated.js'

/** One item of a chat stream (go-chatstream's Event). Generated. */
export type ChatstreamEvent = ChatstreamEventData
export type Usage = ChatstreamEventUsage
export type Verb = ChatstreamEventVerb
export type PartKind = ChatstreamEventPartKind
export type FinishReason = ChatstreamEventFinishReason
export type ApprovalMode = ChatstreamEventApprovalMode
export type GapReason = ChatstreamEventGapReason
export type ErrorCode = ChatstreamEventErrorCode
export type Capabilities = ChatstreamCapabilitiesData

/** Where a resume picks up: the last `seq` the consumer has. Sent as `Last-Event-ID`, header only. */
export interface Cursor {
  seq: number
}

/** A range of events the consumer will not see. */
export interface GapInfo {
  /** First lost seq. */
  from: number
  /** Last lost seq; 0 when the producer did not say. */
  to: number
  /** The server's reason (`retention`, `cursor_ahead`, `dropped_slow`, ...), or `client_detected`. */
  reason: string
  /** `server`: an in-band gap event. `client`: this client saw seq jump past the next expected one. */
  source: 'server' | 'client'
}

/** What the transport is doing. */
export type ConnectionStatus = 'connecting' | 'open' | 'stalled' | 'reconnecting' | 'done' | 'closed'

/** The part of a persisted message `reconcile` reads; structural, so any reducer's message fits. */
export interface PersistedMessage {
  /** The highest seq applied to the message. */
  lastSeq?: number
  /** `done` and `error` mean the run ended; anything else means it may still be running. */
  status?: string
}

export interface ReconcileResult {
  /** Whether to open the stream again. */
  resume: boolean
  /** The cursor to resume from, when `resume`. */
  probe?: Cursor
}

export interface StreamOptions {
  /**
   * Delay in milliseconds before reconnect attempt `attempt` (0 is the first).
   * Default: 1, 2, 4, 8, 16 seconds (the last repeating), spread by 20% either way.
   * A server `retry:` overrides it.
   */
  backoff?: (attempt: number) => number
  /**
   * Reconnect when no bytes at all (comments and keepalives included) have arrived
   * for this long. Driven by arrival on the wire, never by what the frames say.
   * Default 45000; 0 disables it.
   */
  idleTimeoutMs?: number
  /** Statuses that end the stream instead of being retried. Default: every 4xx except 408 and 429. */
  isFinalStatus?: (status: number) => boolean
  /** Give up after this many consecutive reconnects that saw no event. Default: never. */
  maxReconnects?: number
  /** Cap on a server-sent `retry:`, in milliseconds. Default 300000. */
  maxServerRetryMs?: number
  /** Largest single SSE event, in bytes of decoded text. Default 16 MiB, like go-chatstream's framing. */
  maxEventBytes?: number
  /** Extra request headers, or a function returning them (called for every connection). */
  headers?: HeadersInit | (() => HeadersInit)
  /** Passed to fetch. */
  credentials?: RequestCredentials
  /** The fetch to use. Default: the global one. */
  fetch?: typeof fetch
  /** Overrides what `capabilities()` declares. */
  capabilities?: Partial<Capabilities>
}

export interface ChatStreamClient {
  /**
   * Opens the stream and yields its events in order, reconnecting with the last
   * `seq` as `Last-Event-ID` until a terminal event, a final status, or `signal`.
   * Events at or below the cursor are dropped, and a jump past the next expected
   * `seq` yields a `gap` event first. Aborting `signal` ends the iteration quietly.
   */
  open(cursor: Cursor | null, signal: AbortSignal): AsyncIterable<ChatstreamEvent>
  cursorOf(ev: ChatstreamEvent): Cursor
  isTerminal(ev: ChatstreamEvent): boolean
  /** Decides from a persisted message whether to resume, and from where. */
  reconcile(persisted: PersistedMessage | null): Promise<ReconcileResult>
  capabilities(): Capabilities
  /** Called for every gap, in-band or detected. Returns an unsubscribe function. */
  onGap(cb: (gap: GapInfo) => void): () => void
  /** Called on every connection status change. Returns an unsubscribe function. */
  onStatus(cb: (status: ConnectionStatus) => void): () => void
}

/** The response was not one the stream can continue from. */
export class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number, statusText = '') {
    super(`chatstream: server answered ${status}${statusText ? ' ' + statusText : ''}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/** The response was 200 but not `text/event-stream`. */
export class NotEventStreamError extends Error {
  constructor(contentType: string | null) {
    super(`chatstream: expected text/event-stream, got ${contentType ?? 'no content type'}`)
    this.name = 'NotEventStreamError'
  }
}

/** One SSE event was larger than `maxEventBytes`. Not retried: a retry meets the same event. */
export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`chatstream: an SSE event exceeded ${limit} bytes`)
    this.name = 'FrameTooLargeError'
  }
}

/** `maxReconnects` consecutive reconnects saw no event. `cause` is the last failure. */
export class ReconnectLimitError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`chatstream: giving up after ${attempts} reconnect attempts`, { cause })
    this.name = 'ReconnectLimitError'
  }
}
