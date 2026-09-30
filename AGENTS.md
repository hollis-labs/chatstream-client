# chatstream-client

A resumable client for go-chatstream's chat streams over SSE: reconnect with
`Last-Event-ID`, de-duplicate by `seq`, gaps, stall detection. TypeScript, ESM, no
runtime dependencies, React 19 optional peer behind `./react`. Pre-release; see the
README's Status.

## Start Here

- `src/client.ts` owns `createChatStreamClient`: the reconnect loop, dedupe, gaps, the idle watchdog.
- `src/sse.ts` owns the SSE parser. `src/events.ts` owns what is terminal. `src/types.ts` owns the client's contract and the names for the generated types.
- `src/react.ts` owns `useChatStream`. Nothing else may import it.
- `src/generated/chatstream-types.generated.ts` is GENERATED. `manifest/` (go-envelopes' manifest layout) is its source; `tools/gen` runs go-envelopes' generator over it.
- `test/fixtures/fake-server.js` is the scripted upstream (drop, overlap, gap, 404, stuck) in the vocabulary of go-chatstream's `conformance/fakeserver`.
- `@hollis-labs/chatstream-reducer` is the sibling package. It carries a copy of `manifest/`, `tools/gen` and the generated file; the two must stay byte-identical (`cmp`).

## Commands

```sh
npm ci
npm run typecheck
npm test              # builds, then node --test against dist/; no Go needed
npm run gen           # regenerate src/generated/ from manifest/ (needs Go)
npm run gen:check     # fails if the checked-in generated file is out of date
npm run gen:go-test   # fails if the manifest drifts from go-chatstream's Go source
```

Tests import `dist/`, so `npm test` builds first. Do not run `npm publish`, tag or
push from here; publishing is the scope owner's manual step, in `docs/RELEASING.md`.

## Boundaries

Each invariant below is guarded by a named test. Break one on purpose and that test
should fail; if it does not, the guard is not doing its job.

- **The cursor is `seq`, sent as `Last-Event-ID`, header only: the URL is never modified.** `resume.test.js` "the cursor is header-only: the request URL is never modified (no query fallback)".
- **Reconnect resumes from the last `seq` seen.** `resume.test.js` "drop: reconnects with the last seq as Last-Event-ID ...", "a clean close with no terminal event is not the end: it reconnects".
- **Events at or below the cursor are dropped: an overlapping replay does not repeat.** `resume.test.js` "overlap: ..." and `property.test.js` "random drops and overlaps deliver every event exactly once, in order, with no gap".
- **A frame with no `id:` is not the previous frame's id.** `sse.test.js` "the id is per block: ..." and `resume.test.js` "an id-less control frame is not mistaken for a duplicate of the previous frame".
- **Gaps.** A jump past the next expected `seq` yields a `gap` event and `onGap` once: `resume.test.js` "gap (client-detected) ...", "attach with a cursor: ...". A server gap is forwarded once and covers its range: "gap (in-band) ...". First attach with no cursor: `seq` 1 is not a gap ("first attach (no cursor) at seq 1 is not a gap"), and a first event at `seq` 5 announced by nothing is one ("... IS a gap of 1..4"). The spike checked `lastId &&` and missed the second; a naive fix that starts the count at 1 breaks the first.
- **Only `run.finish`, `run.error` and `run.abort` are terminal.** Everything else that goes wrong leaves the run open. `resume.test.js` "every terminal verb ends the stream ...", "non-terminal errors do not end the stream ...", "a run.error that IS terminal ...". The spike ended the stream on any `error`.
- **A frame that cannot be decoded is preserved as a `raw` event, not dropped and not fatal.** `resume.test.js` "a data frame that is JSON but not an event is preserved as raw, not fatal", the malformed frame in "non-terminal errors ...", and `property.test.js` "arbitrary frames never make the client throw ...".
- **Stall detection is frame-arrival-driven, not content-driven.** `stall.test.js` "a stream of heartbeat-only frames does not stall ...", "heartbeats sent as empty-data events, and as partial lines, count as arrival too", "a silent stream stalls ...", "the timer is measured from the last byte ...". Flux's stall timer is refreshed only by handled events, so keepalives never count; do not reintroduce that.
- **A slow consumer is not a stall: the watchdog is paused while the consumer runs.** `stall.test.js` "a slow consumer is not a stall ...".
- **Final statuses end the stream; the rest are retried.** `resume.test.js` "404 on resume is final ...", "5xx, 408 and 429 are retried; other 4xx are final", "isFinalStatus overrides ...", "a 200 that is not text/event-stream is final", "204 ends the stream ...".
- **Backoff, and a server `retry:` capped.** `resume.test.js` "backoff: attempt counts consecutive failures and resets once events arrive", "the default backoff is 1, 2, 4, 8, 16 seconds ...", "a server retry: replaces the schedule, and is capped by maxServerRetryMs", "maxReconnects: ...".
- **Abort and early exit close the connection.** `resume.test.js` "aborting the signal ends the iteration quietly ...", "breaking out of the loop early cancels the connection too".
- **The SSE parser follows WHATWG, and chunking never changes the result.** `sse.test.js` (each vector by name) and its two property tests.
- **The core entry has no React and no `@hollis-labs` import; `./react` has no `@hollis-labs` import.** `isolation.test.js`, which loads each entry in a process whose resolver refuses those modules, and reads the built files' imports.
- **The `./react` hook opens while mounted, follows status and gaps, and aborts and unsubscribes on unmount.** `react.test.js`.
- **The wire types are generated, never hand-edited.** `npm run gen:check` (CI job `codegen`) compares the checked-in file with a fresh regeneration; `generated.test.js` checks the file still carries the generator's header. Edit `manifest/`, run `npm run gen`.
- **The manifest matches go-chatstream's Go source.** `tools/gen/drift_test.go` (`npm run gen:go-test`): `TestEnumsMatchGoConstants`, `TestCapabilitiesMatchGoStruct`, `TestEventUsageRawMatchGoStructs`, `TestRealGoldenEventsValidateAgainstTheManifest`. A field or verb added in Go fails these until the manifest follows.
- **The public type surface.** `test/types/api.ts`, checked by `npm run typecheck` (a `@ts-expect-error` that stops erroring fails the typecheck).
- **The tarball ships `dist`, README, CHANGELOG, LICENSE and nothing else; no source maps; no `tools/`, `manifest/` or Go.** Not guarded by a test. It is `files` in `package.json`, `sourceMap`/`declarationMap` false in `tsconfig.build.json`, `rm -rf dist` in `build`, and the `npm pack --dry-run` step in CI and the release runbook.
- **No `file:`, `link:` or `workspace:` entries in `package.json` or the lockfile, and no tarballs or local paths committed; no dependency on `@hollis-labs/plugin-*`.** Review-only, except that `isolation.test.js` refuses `@hollis-labs` imports at runtime.
- **Do not move stall or gap logic into a consumer, and do not add a reducer here.** Folding events into a message is `@hollis-labs/chatstream-reducer`. The two packages have no dependency on each other.

## Conventions

- Source imports carry `.js` extensions; `tsconfig.build.json` emits with no maps.
- Tests are plain `.js` against `dist/`. Timers in tests are node's `mock.timers`; a reconnect's own zero backoff is a fake timer too, so tick past it.
- Do not write a new check that asserts the content of a mutable file or that two sources agree; raise it instead. (The drift tests in `tools/gen` compare the manifest with go-chatstream's source by design of the codegen mechanism; do not add more of that kind.)
