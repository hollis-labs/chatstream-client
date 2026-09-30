# Releasing

Nothing here has been run. The package is unpublished and untagged, and the GitHub
repository does not exist yet. CI gates; it never publishes. Publishing is done by
hand by the owner of the `@hollis-labs` scope, and the tag is created only after the
publish has succeeded and been checked, so a tag never names a version that was not
published.

1. Create the repository (maintainer): `gh repo create hollis-labs/chatstream-client --public --source . --remote origin` then `git push -u origin main`.
2. Confirm CI is green on the commit you will release: both `gate` and `codegen`. `codegen` needs `go` to be able to fetch `github.com/hollis-labs/go-envelopes` and `go-chatstream`; if those repositories are private, give the job a token and `GOPRIVATE` first.
3. Confirm the wire types are still the ones go-chatstream ships: if go-chatstream has a newer tag, bump it in `tools/gen/go.mod`, run `npm run gen` and `npm run gen:go-test`, and read the diff of the manifest and the generated file before releasing. Never hand-edit `src/generated/`.
4. In `CHANGELOG.md`, make sure the heading is `## 0.1.0 — <date>` (em dash) with the release date, and commit it.
5. `npm ci && npm test && npm pack --dry-run`. The file list is `dist/*`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`, with no `.map` files and no `src`. Confirm `package.json` has no `file:`, `link:` or `workspace:` dependency.
6. Publish, logged in as the scope owner: `npm publish --access public`.
7. Verify the publish before tagging:
   - `npm view @hollis-labs/chatstream-client version` prints `0.1.0`.
   - In an EMPTY temporary directory, `npm install @hollis-labs/chatstream-client@0.1.0 react react-dom`, then import both entry points (`.` and `/react`) from a small script, and run the README example.
8. Only after step 7 passes: `git tag -a v0.1.0 <sha>`, push the tag, then `gh release create v0.1.0 --notes-file <the CHANGELOG section>`.
9. `@hollis-labs/chatstream-reducer` carries a copy of the same manifest, generator and generated file. Release the two together, and check that `manifest/` and `src/generated/` are still byte-identical between them (`cmp`); if a shared types package has been published by then, move both onto it instead.
