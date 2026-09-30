import type { ChatstreamEvent, Cursor, Verb } from './types.js'

/** The verbs that end a run. Exactly one ends every run, and nothing follows it. */
export const TERMINAL_VERBS: readonly Verb[] = ['run.finish', 'run.error', 'run.abort']

/**
 * Whether `ev` ends its run: run.finish, run.error or run.abort, and only those.
 * Everything else that goes wrong (a dropped connection, a malformed frame, a
 * dialect's own error carried as `raw` or `activity`) leaves the run open.
 */
export function isTerminalEvent(ev: Pick<ChatstreamEvent, 'verb'>): boolean {
  return (TERMINAL_VERBS as readonly string[]).includes(ev.verb)
}

export function cursorOfEvent(ev: Pick<ChatstreamEvent, 'seq'>): Cursor {
  return { seq: ev.seq }
}
