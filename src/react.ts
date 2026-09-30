// The React seam. The core entry (".") imports nothing from here or from React.
import { useEffect, useRef, useState } from 'react'
import type { ChatstreamEvent, ChatStreamClient, ConnectionStatus, Cursor, GapInfo } from './types.js'

export interface ChatStreamState {
  /** `idle` until the stream is opened; `error` when the iteration threw. Otherwise the transport's status. */
  status: 'idle' | ConnectionStatus | 'error'
  /** Every event received since the stream was opened, in order, gap events included. */
  events: readonly ChatstreamEvent[]
  gaps: readonly GapInfo[]
  error: Error | null
}

export interface UseChatStreamOptions {
  /** Where to resume from. Read when the stream opens; changing it does not reopen the stream. */
  cursor?: Cursor | null
  /** Open the stream while true (the default). Turning it off aborts the connection. */
  enabled?: boolean
}

const IDLE: ChatStreamState = { status: 'idle', events: [], gaps: [], error: null }

/**
 * Opens `client`'s stream while mounted and enabled, and returns what has arrived.
 * Unmounting, or a different `client`, aborts the connection.
 *
 * It keeps every event, so a long run holds all of them; fold them with a reducer
 * (`@hollis-labs/chatstream-reducer`) and drop what you do not need.
 */
export function useChatStream(client: ChatStreamClient, options: UseChatStreamOptions = {}): ChatStreamState {
  const enabled = options.enabled ?? true
  const [state, setState] = useState<ChatStreamState>(IDLE)
  const cursorRef = useRef(options.cursor ?? null)
  cursorRef.current = options.cursor ?? null

  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    setState({ ...IDLE, status: 'connecting' })
    const offStatus = client.onStatus((status) => {
      setState((s) => (s.status === 'error' ? s : { ...s, status }))
    })
    const offGap = client.onGap((gap) => setState((s) => ({ ...s, gaps: [...s.gaps, gap] })))
    void (async () => {
      try {
        for await (const ev of client.open(cursorRef.current, ac.signal)) {
          setState((s) => ({ ...s, events: [...s.events, ev] }))
        }
      } catch (err) {
        if (!ac.signal.aborted) setState((s) => ({ ...s, status: 'error', error: err instanceof Error ? err : new Error(String(err)) }))
      }
    })()
    return () => {
      ac.abort()
      offStatus()
      offGap()
    }
  }, [client, enabled])

  return state
}
