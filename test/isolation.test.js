// The dependency boundary, checked by behaviour: load each entry point in a
// fresh Node process whose resolver refuses the modules it must not need.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hook = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (BLOCK.test(specifier)) throw new Error('blocked import: ' + specifier)
  return next(specifier, context)
}`)}`

function load(entry, block) {
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hook.replace('BLOCK', block))})`
  return spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', `const m = await import(${JSON.stringify(entry)}); console.log(Object.keys(m).sort().join(','))`],
    { encoding: 'utf8' },
  )
}
const dist = (f) => fileURLToPath(new URL(`../dist/${f}`, import.meta.url))

test('core entry (".") loads with react, react-dom and every @hollis-labs package unresolvable', () => {
  const r = load(dist('index.js'), '/^(react|react-dom|@hollis-labs\\/[a-z-]+)(\\/|$)/')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'FrameTooLargeError,HttpStatusError,NotEventStreamError,ReconnectLimitError,SseParser,TERMINAL_VERBS,DEFAULT_MAX_EVENT_BYTES,createChatStreamClient,cursorOfEvent,isTerminalEvent'.split(',').sort().join(','))
})

test('react entry ("./react") loads and exports only the hook', () => {
  const r = load(dist('react.js'), '/^@hollis-labs\\/[a-z-]+(\\/|$)/')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'useChatStream')
})

test('the blocker is real: blocking react makes the react entry fail to load', () => {
  const r = load(dist('react.js'), '/^react(\\/|$)/')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /blocked import: react/)
})

test('the built core files contain no import of react and no import of another package', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = fileURLToPath(new URL('../dist/', import.meta.url))
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'react.js')) {
    const src = readFileSync(dir + f, 'utf8')
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('.'), `${f} imports ${m[1]}`)
    }
  }
})
