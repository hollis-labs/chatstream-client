# @hollis-labs/chatstream-client

A resumable client for chat streams over server-sent events. It opens the stream,
reconnects with `Last-Event-ID` when the connection drops, de-duplicates by `seq`,
reports gaps, and notices a stalled connection by whether bytes arrive, not by what
they say. It yields the events of [go-chatstream](https://github.com/hollis-labs/go-chatstream)
and nothing else: folding them into a message is
[`@hollis-labs/chatstream-reducer`](https://github.com/hollis-labs/chatstream-reducer)'s job.

Framework-free core. React 19 is an optional peer of `./react`, a small hook over the
same client.

## Status

**Pre-release.** This project is unreleased, not deployed, and has no outside consumers. It's being built in the open: the code, the docs, and this README describe what exists today, not a pitch for what's planned. Interfaces and behavior change without notice, and there are no compatibility guarantees yet.

See [CHANGELOG.md](./CHANGELOG.md) for what has changed.

## Install

```sh
npm install @hollis-labs/chatstream-client
```

Not on npm yet, so that line does not work today.

## Use

A self-contained example: a server that drops the connection half way and replays an
overlap, and a client that reads through it. Save it as `demo.mjs` next to a build of
this package (`npm run build`, then import from `./dist/index.js`).

```js
import http from 'node:http'
import { createChatStreamClient } from '@hollis-labs/chatstream-client'

const ev = (seq, verb, more = {}) =>
  `id: ${seq}\nevent: ${verb}\ndata: ${JSON.stringify({ v: '1', seq: 0, run_id: 'run-1', time: new Date().toISOString(), verb, ...more })}\n\n`
const stream = [
  ev(1, 'run.start'),
  ev(2, 'part.start', { part_id: 'p', kind: 'text' }),
  ev(3, 'part.delta', { part_id: 'p', text: 'Hello, ' }),
  ev(4, 'part.delta', { part_id: 'p', text: 'world' }),
  ev(5, 'run.finish', { reason: 'stop' }),
]

// The first connection is cut after three events. The second replays from one event
// earlier than the client's Last-Event-ID, as a server may.
const server = http.createServer((req, res) => {
  const last = Number(req.headers['last-event-id'] ?? 0)
  console.log('request, Last-Event-ID:', req.headers['last-event-id'] ?? '(none)')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (last === 0) { res.write(stream.slice(0, 3).join(''), () => res.destroy()); return } // cut once the bytes are out
  res.end(stream.slice(Math.max(0, last - 1)).join(''))
}).listen(0)
await new Promise((r) => server.once('listening', r))

const client = createChatStreamClient(`http://127.0.0.1:${server.address().port}/events`, { backoff: () => 50 })
client.onGap((gap) => console.log('gap', gap))

for await (const ev of client.open(null, new AbortController().signal)) {
  console.log(ev.seq, ev.verb, ev.text ?? '')
  if (client.isTerminal(ev)) break
}
server.close()
```

It prints two requests (no `Last-Event-ID`, then `3`), and events 1 to 5 exactly once each.

With a reducer, and to resume a stored message:

```ts
import { createChatStreamClient } from '@hollis-labs/chatstream-client'
import { createReducer } from '@hollis-labs/chatstream-reducer'

const client = createChatStreamClient('/api/streams/run-1/events')
const { resume, probe } = await client.reconcile(storedMessage) // storedMessage: a reducer Message or null
if (resume) {
  const reducer = createReducer(storedMessage)
  for await (const ev of client.open(probe ?? null, signal)) render(reducer.push(ev))
}
```

## What it does

- **The cursor is `seq`, in the `Last-Event-ID` header, and only there.** The URL is never modified. On the wire go-chatstream's JSON `seq` is 0 and the SSE `id:` carries the cursor, so the client copies the id into `ev.seq`. A frame with no `id:` (a gap notice, a synthesized terminal) keeps `seq` 0 and is never mistaken for a repeat of the previous frame.
- **Reconnect** after a dropped connection, a clean close with no terminal event, a network error, an idle timeout, or a 5xx, 408 or 429. Delays follow `backoff(attempt)`, by default 1, 2, 4, 8, 16 seconds (the last repeating) with 20% jitter; `attempt` restarts at 0 once a connection has delivered an event. A server `retry:` replaces the schedule, is capped (`maxServerRetryMs`, default 5 minutes) and floored at 100 ms, so `retry: 0` cannot make the client hammer a server that keeps closing.
- **Final** (thrown, not retried): any other 4xx (a 404 on resume means the run is gone), a 200 that is not `text/event-stream`, an SSE event over `maxEventBytes`. A 204 ends the stream quietly. `isFinalStatus` overrides the status rule.
- **De-duplication**: an event at or below the highest `seq` already seen is dropped, so a server that replays an overlap does not repeat itself.
- **Gaps**: an in-band `gap` event is forwarded and reported to `onGap`, and what it covers is not reported again. Otherwise a `seq` past the next one expected yields a `gap` event of this client's own (`reason: 'client_detected'`, `seq` 0) before it, so a reducer marks the message incomplete. With no cursor the first event is expected at `seq` 1; with a cursor, at the cursor plus one.
- **Terminal is `run.finish`, `run.error` and `run.abort`, and nothing else.** Everything else that goes wrong leaves the run open: a dialect's error carried as `raw` or `activity`, an event whose data is not JSON (kept as a `raw` event with `raw.type` `malformed_frame`, as go-chatstream's decoders do), an unknown verb (passed through), a dropped connection (reconnect).
- **Stall detection is driven by arrival.** `idleTimeoutMs` (default 45000; 0 turns it off) is reset by any bytes on the wire, keepalive comments and half a line included, and is paused while your loop body runs, so a slow consumer is not a stalled server. When it fires the status goes `stalled`, the connection is cut, and the client reconnects with the last `seq`.
- **`onStatus`** reports `connecting`, `open`, `stalled`, `reconnecting`, `done` and `closed`; `onGap` reports gaps. Both return an unsubscribe function.
- Aborting the signal, or leaving the loop, closes the connection. An abort ends the iteration without throwing.

`useChatStream(client, { cursor?, enabled? })` from `./react` opens the stream while mounted and returns `{ status, events, gaps, error }`.

The wire types (`ChatstreamEvent`, `Usage`, `Verb`, `PartKind`, `FinishReason`, `Capabilities`) are
generated, not hand-written; see Development.

## Compatibility

ESM only. It needs `fetch`, `ReadableStream`, `TextDecoder`, `Headers` and `AbortController`, which
Node 18 and later and current browsers have (Node 24 in CI, Node 26 locally). React `^19` for
`./react` only (tested with 19.3). The wire vocabulary is go-chatstream v0.1.0's `Event`, checked
against it by the codegen drift tests described below; a newer go-chatstream is untested. There are no
runtime dependencies. The client has not been run against a real go-chatstream server: its behaviour
is checked against a scripted fake of the failures go-chatstream's `conformance/fakeserver` describes.

## What was read, and what was run

- **Read, and run for the wire contract:** go-chatstream v0.1.0 (`event.go`, `meta.go`,
  `capabilities.go`, `finish.go`, `hubbind`, `framing`, `conformance/fakeserver`); every adapter's
  golden event file validates against this repo's manifest in a Go test.
- **Read, not run:** go-ssekit's client and parser (its reconnect, backoff, `retry:` cap and
  idle-watchdog rules were followed; its tests were not run here), Flux's `useChat` (where the stall
  timer is only refreshed by handled events, so a keepalive comment never counts), the Nanite
  spike's `streamTurn` (`~/dev/projects/chat/src/lib/nanite/client.ts`: every `error` terminal, and a gap
  check that skips the first attach) and its `resume-check.mts` scenarios, and kit-chat's
  `ChatStreamStatus`, which is only a type: the stall detector the brief attributes to kit-chat is in
  Flux. None was run, and **no behavioural equivalence with any of them is claimed**; the fixes above are
  this package's own, each with a test.
- **Run, by this repo's tests:** the SSE parser (unit and seeded property tests), the client against a
  scripted fake server (drop, overlap, gap, 404, 5xx, stuck, malformed frames, header-only cursor), stall
  detection under fake timers, the isolation of the core entry from React, and the `./react` hook under jsdom.
- **Not run anywhere:** a real browser, a real go-chatstream server, Firefox and Safari.

## Known limitations

- Delays are computed with `setTimeout` and `Date` at call time, so they follow whatever a test replaces
  them with, and are throttled like any timer in a background browser tab.
- `reconcile` decides from the persisted message alone; it does not ask the server whether the run is
  still alive. A resume of a run that has ended replays it from the cursor.
- A gap the client detects is a guess about a cause it cannot know (`client_detected`); a first event
  at `seq` above 1 with no cursor and no in-band gap is reported as a gap of `1..seq-1`.
- `useChatStream` keeps every event it has seen, and copies the array on each one.
- `maxReconnects` defaults to never giving up, as go-ssekit's client does; a server that is always
  unreachable is retried forever, at the last backoff step, until the signal aborts.
- The generated `Capabilities` type keeps the Go struct's untagged JSON shape (PascalCase keys, numeric
  enums). Go never puts it on the wire; `capabilities()` declares only what this transport does.
- The manifest, generator and generated file are duplicated in `@hollis-labs/chatstream-reducer`
  (see Development); a shared types package is not possible until one is published.

## Out of scope

- Reducing events into a message (that is `@hollis-labs/chatstream-reducer`), or any rendering.
- Decoding provider bytes, the hub, framing on the server, persistence.
- Sending requests: starting a run, answering an approval, cancelling. `open` reads a stream.
- Authentication beyond the `headers` and `credentials` options.
- Publishing.

## Development

```sh
npm ci
npm run typecheck   # src plus the typecheck-only fixture in test/types
npm test            # builds, then node --test against dist/ (no Go needed)
```

The wire types in `src/generated/chatstream-types.generated.ts` are generated from the manifest in
`manifest/` (go-envelopes' manifest layout: `envelopes.yaml` plus a JSON Schema per type) by
go-envelopes' own generator, pinned at v0.4.0. `cmd/envelopes-export` has no flag for another manifest, so
`tools/gen` makes the same two calls it does (`envelopes.LoadCore` with `WithManifestFS`, then
`codegen.TypeScript`). Never edit the generated file.

```sh
npm run gen           # regenerate after editing the manifest (needs Go)
npm run gen:check     # fails if the checked-in file differs from a fresh regeneration
npm run gen:go-test   # fails if the manifest drifts from go-chatstream's Go source
```

`gen:go-test` compares the manifest with go-chatstream v0.1.0 (`tools/gen/go.mod`): the fields and
required-ness of `Event`, `Usage` and `Raw` by reflection, the verb, part-kind, finish-reason, approval-mode,
usage-scope, gap-reason and error-code sets by parsing its constants, and it validates every event of every
adapter golden file against the schema. CI runs all three in a `codegen` job. Release steps:
[docs/RELEASING.md](./docs/RELEASING.md).

## License

MIT. See [LICENSE](./LICENSE).
