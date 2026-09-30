# Changelog

## 0.1.0 — 2026-09-30

Initial extraction; not published, not tagged.

- `.`: `createChatStreamClient(url, options)` returning a `ChatStreamClient` (`open`, `cursorOf`, `isTerminal`, `reconcile`, `capabilities`, `onGap`, `onStatus`), plus `SseParser`, `isTerminalEvent` and the error classes.
- `./react`: `useChatStream(client, { cursor?, enabled? })`.
- Resumable over SSE: reconnects with the last `seq` as `Last-Event-ID` (header only), backs off (1 to 16 s, jittered, a server `retry:` honoured and capped), de-duplicates by `seq`, reports gaps (in-band and client-detected), treats 4xx other than 408 and 429 as final.
- Stall detection is driven by frame arrival: any bytes, keepalive comments included, reset the idle timer, and it is paused while the consumer runs. Flux's stall timer is only refreshed by handled events; that behaviour was not carried over.
- Only `run.finish`, `run.error` and `run.abort` end a stream. The Nanite spike treated every `error` as terminal; that was not carried over. A frame that is not decodable becomes a `raw` event instead of ending the run.
- A first attach with no cursor expects `seq` 1: a first event at `seq` 1 is not a gap, and one above it with no in-band gap is. The spike's gap check skipped the first attach; that was not carried over.
- Wire types (`Event`, `Usage`, `Verb`, `PartKind`, `FinishReason`, `Capabilities`) are generated from `manifest/` by go-envelopes v0.4.0's generator, and pinned to go-chatstream v0.1.0 by Go tests (`npm run gen:check`, `npm run gen:go-test`).
- Flux's `useChat`, the Nanite spike and go-ssekit's client were read for the pattern; none was run, and no equivalence is claimed.
- Source maps and declaration maps are not emitted: they would point at `../src`, which the tarball does not ship.
