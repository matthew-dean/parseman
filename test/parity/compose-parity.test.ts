import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'
// `pick` is internal (not in the public API — see test/unit/pick-not-public.test.ts), so
// import it directly for the harness that still exercises pick()'s composition behavior.
import { pick } from '../../src/compiler/linker.ts'
import { transformMacro } from '../../src/plugin/index.ts'

/**
 * The guardrail: for each grammar, fuse it BOTH ways —
 *   - RUNTIME `compose()` (interpreter/`new Function` path), and
 *   - the MACRO (`transformMacro`, then EXECUTE the emitted module)
 * — and assert IDENTICAL parse results (ok + end position) on a battery of inputs.
 *
 * Both are produced from ONE source string, so they can't silently drift. `evalModule`
 * strips the import line and injects the real library as parameters: for the runtime
 * path this runs the untouched `compose()/pick()` calls; for the macro path the compose
 * is already inlined to a self-contained fused IIFE (and any interpreter fallback still
 * has the library available). This proves interpreter ≡ macro at every composition depth,
 * including through `pick()`.
 */
function evalModule(code: string, ...want: string[]): Record<string, any> {
  const body = code.replace(/^\s*import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '')
  const lib: Record<string, unknown> = { ...P, pick }  // pick is internal; inject it for the harness
  const names = Object.keys(lib)
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { ${want.join(', ')} }`)(...names.map(n => lib[n]))
}
const end = (r: any): string | number => (r.ok ? r.span.end : 'FAIL')

// Trivia flavors with an OBSERVABLE difference: ws (whitespace) vs wsc (ws OR /*…*/).
const TRIVIA = String.raw`
const ws  = trivia(oneOrMore(regex(/[ \t\n]+/)))
const wsc = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))`

// NB: `pick` is deliberately NOT imported here — it's internal (not a public 'parseman'
// export). The macro recognises `pick(…)` by callee name, and the runtime path injects
// `pick` separately (see evalModule), so the pick cases run without a public import.
const IMPORTS = `import { rules, compose, parser, noTrivia, trivia, sequence, literal, oneOrMore, choice, regex } from 'parseman' with { type: 'macro' }`

type Case = { name: string; src: string; entry: string; inputs: string[]; pick?: boolean; expect?: Record<string, string | number> }

const cases: Case[] = [
  {
    name: 'single-level: ws, cross-boundary ref to inherited rule',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules({ trivia: ws }, (g) => ({ Doc: sequence(literal('x'), g.Pair, literal('y')) }))])`,
    entry: 'Doc',
    inputs: ['x a b y', 'xaby', 'x a b', 'x a/*c*/b y', 'q'],
    expect: { 'x a b y': 7, 'xaby': 4 },
  },
  {
    name: 'composing-wins: the delta’s wsc reaches the inherited base Pair',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules({ trivia: wsc }, (g) => ({ Doc: sequence(literal('x'), g.Pair) }))])`,
    entry: 'Doc',
    inputs: ['x a/*c*/b', 'x a b', 'x/*c*/a/*c*/b', 'xab'],
    expect: { 'x a/*c*/b': 9, 'x a b': 5 },
  },
  {
    name: 'delta declares no trivia → inherits the base grammar’s wsc',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: wsc }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules((g) => ({ Doc: sequence(literal('x'), g.Pair) }))])`,
    entry: 'Doc',
    inputs: ['x a/*c*/b', 'xab', 'x a b'],
    expect: { 'x a/*c*/b': 9, 'xab': 3 },
  },
  {
    name: 'noTrivia override: inner region glued, surroundings skip',
    src: `${IMPORTS}${TRIVIA}
export const g = compose([rules({ trivia: ws }, (r) => ({
  Doc: sequence(literal('x'), r.Inner, literal('y')),
  Inner: noTrivia(sequence(literal('p'), literal('q'))),
}))])`,
    entry: 'Doc',
    inputs: ['x pq y', 'x p q y', 'xpqy'],
    expect: { 'x pq y': 6, 'x p q y': 'FAIL' },
  },
  {
    name: 'parser({trivia: other}) override: inner region uses the OTHER trivia',
    src: `${IMPORTS}${TRIVIA}
export const g = compose([rules({ trivia: ws }, (r) => ({
  Doc: sequence(literal('x'), r.Inner),
  Inner: parser({ trivia: wsc }, sequence(literal('p'), literal('q'))),
}))])`,
    entry: 'Doc',
    inputs: ['x p/*c*/q', 'x/*c*/pq', 'x p q'],
    expect: { 'x p/*c*/q': 9, 'x/*c*/pq': 'FAIL' },
  },
  {
    name: 'multi-level (css→less→scss): deepest rule adopts outermost wsc',
    src: `${IMPORTS}${TRIVIA}
const css = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
const less = compose([css, rules({ trivia: ws }, (g) => ({ Mid: sequence(literal('m'), g.Pair) }))])
export const g = compose([less, rules({ trivia: wsc }, (g) => ({ Doc: sequence(literal('x'), g.Mid) }))])`,
    entry: 'Doc',
    inputs: ['x m a/*c*/b', 'x m a b', 'xmab'],
    expect: { 'x m a/*c*/b': 11, 'x m a b': 7 },
  },
  {
    name: 'pick from a trivia-declaring grammar: the picked rule still skips trivia',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (r) => ({ Pair: sequence(literal('a'), literal('b')), Junk: literal('z') }))
export const g = compose([pick(base, ['Pair'])])`,
    entry: 'Pair',
    inputs: ['a b', 'ab', 'a  b', 'q'],
    pick: true,
    expect: { 'a b': 3, 'ab': 2 },
  },
  {
    name: 'pick from a composed grammar: composing-wins wsc survives the pick',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (r) => ({ Pair: sequence(literal('a'), literal('b')) }))
const composed = compose([base, rules({ trivia: wsc }, (r) => ({ Doc: sequence(literal('x'), r.Pair) }))])
export const g = compose([pick(composed, ['Pair'])])`,
    entry: 'Pair',
    inputs: ['a/*c*/b', 'a b', 'ab'],
    pick: true,
    expect: { 'a/*c*/b': 7, 'a b': 3 },
  },
]

describe('compose/pick parity — interpreter ≡ macro at every depth', () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = transformMacro(c.src, 'parity.ts', new Set(['parseman']))
      expect(out, 'macro must transform the module').not.toBeNull()
      const macroCode = out!.code

      // The macro must FULLY compile — no interpreter fallback: import stripped, and no
      // residual runtime `compose(` / `pick(` calls. (Fallback would still be correct but
      // would make "macro" secretly the runtime path, defeating the parity guarantee.)
      expect(macroCode.includes("from 'parseman'"), `${c.name}: import must be stripped`).toBe(false)
      expect(/\bcompose\s*\(/.test(macroCode), `${c.name}: compose must inline`).toBe(false)
      if (c.pick) expect(/\bpick\s*\(/.test(macroCode), `${c.name}: pick must inline`).toBe(false)

      const runtimeG = evalModule(c.src, 'g').g
      const macroG = evalModule(macroCode, 'g').g

      for (const input of c.inputs) {
        const r = end(P.run(runtimeG[c.entry], input))
        const m = end(P.run(macroG[c.entry], input))
        expect(m, `${c.name}: macro vs runtime on ${JSON.stringify(input)}`).toEqual(r)
        // Guard against BOTH paths being wrong the same way, where we have a known value.
        if (c.expect && input in c.expect) {
          expect(r, `${c.name}: runtime value on ${JSON.stringify(input)}`).toEqual(c.expect[input])
        }
      }
    })
  }
})
