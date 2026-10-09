/**
 * A macro `compose()` over a BUILD-COMPILED upstream it cannot resolve fails the
 * build. It used to warn and leave a runtime `compose()` in place, which re-built
 * the upstream from its carried IR with `eval`. Runtime `compose()` now links live
 * `rules()` grammars only (docs/design/runtime-and-size-contract.md, rule 1), so
 * that fallback would throw at import instead: the build is where to say so.
 *
 * The bundled-upstream case that must keep WORKING is exercised end to end, under
 * the CSP flag too, in `test/unit/csp-runtime-paths.test.ts`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

let dir = ''
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

function downstream(upstream: string, source: string): () => ReturnType<typeof transformMacro> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-unresolved-upstream-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(dir, 'upstream.js'), upstream)
  return () => transformMacro(source, path.join(dir, 'down.ts'), new Set(['parseman']))
}

describe('compose() over an unresolvable build-compiled upstream', () => {
  it('fails the build, naming the upstream and the likely cause', () => {
    // A compiled module whose carried pieces spread a binding the build cannot
    // follow — what a bundler leaves when it rewrites an ancestor out of reach.
    const run = downstream(`import { tableRules } from 'parseman/table'
export const base = /* @__PURE__ */ tableRules({}, {
  [/* @__PURE__ */ Symbol.for('parseman.composedPieces')]: [...mystery[Symbol.for('parseman.composedPieces')] ?? []],
})
`, `import { compose, rules, literal } from 'parseman' with { type: 'macro' }
import { base } from './upstream.js'
export const g = compose([base, rules(g => ({ Extra: literal('x') }))])`)
    expect(run).toThrow(/compose\(\): argument 0 \(`base` from '\.\/upstream\.js'\) is a build-compiled grammar whose carried pieces could not be resolved/)
    expect(run).toThrow(/spread `mystery`, which is neither an import nor a top-level binding/)
    expect(run).toThrow(/bundler/)
  })

  it('still only warns for an argument that is not build-compiled', () => {
    // A grammar the macro cannot resolve statically (here, one returned by a local
    // call) is a live rules() grammar at runtime, which runtime compose() links, so
    // the fallback is real there.
    const run = downstream('export {}\n', `import { compose, rules, literal } from 'parseman' with { type: 'macro' }
const make = () => rules(g => ({ A: literal('a') }))
export const g = compose([make(), rules(g => ({ B: literal('b') }))])`)
    const out = run()
    expect(out?.warnings.some(w => w.includes("argument 0 isn't a build-resolvable grammar; falling back to runtime"))).toBe(true)
  })
})
