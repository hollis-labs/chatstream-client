// Fails when the checked-in generated TypeScript differs from a fresh
// regeneration from manifest/. Needs the Go toolchain (see tools/gen/go.mod).
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const checkedIn = join(root, 'src/generated/chatstream-types.generated.ts')
const dir = mkdtempSync(join(tmpdir(), 'chatstream-gen-'))
const fresh = join(dir, 'fresh.ts')
try {
  const r = spawnSync('go', ['run', '.', '-root', '../..', '-output', fresh], { cwd: join(root, 'tools/gen'), encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    console.error('gen:check DID NOT RUN: the generator failed (is Go installed?)\n' + (r.error ?? r.stderr))
    process.exit(2)
  }
  if (readFileSync(fresh, 'utf8') !== readFileSync(checkedIn, 'utf8')) {
    console.error('gen:check FAILED: src/generated/chatstream-types.generated.ts is out of date with manifest/.\nEdit the manifest, run `npm run gen`, and commit the result; never edit the generated file.')
    process.exit(1)
  }
  console.log('gen:check ok: generated output matches a fresh regeneration')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
