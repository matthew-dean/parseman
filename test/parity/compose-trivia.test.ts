import { describe, it, expect } from 'vitest'
import { rules, compose, trivia, sequence, literal, oneOrMore, regex, run } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// Eval a fully-macro-compiled module (import already stripped, no `new Function`
// eval inside it) and return its top-level bindings. The emitted compose is a
// self-contained fused IIFE, so this executes the SAME code the plugin ships.
function evalMacroModule(code: string, ...names: string[]): Record<string, any> {
  const body = code.replace(/\bexport\s+/g, '')
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} }`)()
}

const rw = trivia(oneOrMore(regex(/[ \t\n]+/)))

// A base grammar and a delta composed on top, BOTH declaring grammar-level trivia
// via rules({ trivia }, factory). The delta's Doc references the base's Pair, so
// fusion re-binds across the boundary. Trivia must skip in every fused rule.
function composed() {
  const base = rules({ trivia: rw }, (_g: any) => ({
    Pair: sequence(literal('a'), literal('b')),
  }))
  return compose([
    base,
    rules({ trivia: rw }, (g: any) => ({
      Doc: sequence(literal('x'), g.Pair, literal('y')),
    })),
  ]) as Record<string, any>
}

describe('grammar-level trivia through compose()', () => {
  it('runtime fuse: a composed grammar skips trivia in its own AND inherited rules', () => {
    const g = composed()
    // Doc = 'x' Pair 'y' ; Pair = 'a' 'b' — all separated by trivia.
    expect(run(g.Doc, 'x a b y').ok).toBe(true)
    expect(run(g.Doc, 'x a b y').span.end).toBe(7)
    // inherited base rule, parsed on its own, also gets the trivia
    expect(run(g.Pair, 'a b').ok).toBe(true)
    // still glued-tolerant
    expect(run(g.Doc, 'xaby').ok).toBe(true)
  })

  it('macro fuse: compose([...]) emits trivia-skips for the fused rules', () => {
    const code = `
import { rules, compose, trivia, sequence, literal, oneOrMore, regex } from 'parseman' with { type: 'macro' }
const rw = trivia(oneOrMore(regex(/[ \\t\\n]+/)))
const base = rules({ trivia: rw }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules({ trivia: rw }, (g) => ({ Doc: sequence(literal('x'), g.Pair, literal('y')) }))])
`
    const out = transformMacro(code, 'test.ts', new Set(['parseman']))
    const src = out?.code ?? ''
    expect(out, 'macro must transform the compose grammar').not.toBeNull()
    // The compose must INLINE to static fused source, not fall back to a runtime
    // `compose([...])` call (the options-first `rules({trivia}, …)` used to break the
    // plugin's piece disambiguation and force that fallback).
    expect(src.includes('compose(['), 'compose must inline, not fall back to runtime').toBe(false)
    // …and the fused rules must skip trivia between terms.
    expect(/_tf\d/.test(src), 'macro-fused compose output must contain a trivia-skip').toBe(true)
    // The import must be fully removed (nothing fell back to the interpreter).
    expect(src.includes("from 'parseman'"), 'macro import must be fully stripped').toBe(false)

    // Strongest check: EXECUTE the emitted module and prove composing-wins reaches an
    // INHERITED rule. The delta's Doc references the base's Pair; the composing grammar's
    // trivia must be baked into that inherited Pair too, not just Doc's own terms.
    const { g } = evalMacroModule(src, 'g')
    // Doc = 'x' Pair 'y' ; Pair = 'a' 'b', all trivia-separated.
    expect(run(g.Doc, 'x a b y').ok, 'fused Doc parses with trivia').toBe(true)
    expect(run(g.Doc, 'x a b y').span.end).toBe(7)
    // The space between 'a' and 'b' lives entirely inside the INHERITED base Pair rule —
    // if composing trivia hadn't reached it, this would fail at the glued 'a b'.
    expect(run(g.Pair, 'a b').ok, 'inherited Pair skips trivia (composing-wins)').toBe(true)
    // Still glued-tolerant.
    expect(run(g.Doc, 'xaby').ok).toBe(true)
  })
})
