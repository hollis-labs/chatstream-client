// Typecheck-only fixture (run by `npm run typecheck`; never executed). A
// `@ts-expect-error` that stops being an error fails the typecheck.
import { createChatStreamClient, isTerminalEvent } from '../../src/index.ts'
import type { ChatstreamEvent, ChatStreamClient, Cursor, Capabilities, Usage, Verb, PartKind, FinishReason } from '../../src/index.ts'
import { useChatStream } from '../../src/react.ts'
import type { ChatStreamState } from '../../src/react.ts'

const client: ChatStreamClient = createChatStreamClient('https://hub.example/events', { idleTimeoutMs: 30_000, isFinalStatus: (s) => s === 404 })

declare const signal: AbortSignal
export async function consume(): Promise<number> {
  let last: Cursor = { seq: 0 }
  for await (const ev of client.open(null, signal)) {
    last = client.cursorOf(ev)
    if (client.isTerminal(ev)) break
    const v: string = ev.verb // a Verb, or a verb a newer producer added
    void v
  }
  return last.seq
}

// The generated wire types are the ones the client speaks.
export const ev: ChatstreamEvent = { v: '1', seq: 1, run_id: 'r', time: '2026-01-01T00:00:00Z', verb: 'run.start' }
export const verb: Verb = 'part.delta'
export const kind: PartKind = 'tool_result'
export const reason: FinishReason = 'tool_calls'
export const usage: Usage = { uncached_input: 1, output: 2, scope: 'final' }
export const caps: Capabilities = client.capabilities()
export const terminal: boolean = isTerminalEvent(ev)

// @ts-expect-error a Usage without output is not a Usage
export const badUsage: Usage = { uncached_input: 1 }
// @ts-expect-error an event needs a run_id
export const badEvent: ChatstreamEvent = { v: '1', seq: 1, time: 't', verb: 'run.start' }
// @ts-expect-error an unknown field is not part of the wire vocabulary
export const extraField: ChatstreamEvent = { v: '1', seq: 1, run_id: 'r', time: 't', verb: 'run.start', invented: true }
// @ts-expect-error a finish reason is a closed vocabulary
export const badReason: FinishReason = 'because'
// @ts-expect-error open needs a signal
client.open(null)

export const hook: () => ChatStreamState = () => useChatStream(client, { cursor: { seq: 3 }, enabled: true })
