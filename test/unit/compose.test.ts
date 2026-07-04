/**
 * Grammar composition — sharing reusable rule fragments across grammars.
 *
 * A "fragment" is just a factory `(g, deps?) => Record<string, Combinator>`. You
 * compose it into a grammar by spreading its result into the `rules()` map. Because
 * the SAME `g` proxy is threaded through, rules in the fragment and rules in the
 * consumer resolve each other's `g.*` references transparently.
 *
 * This is plain JavaScript — it needs no macro and works identically in the
 * interpreter. (The macro's job is only to INLINE these spreads for the compiled
 * fast path; see macro-transform tests.)
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  rules, regex, sequence, oneOrMore, parse, type Combinator,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// A real path INSIDE test/fixtures/frag so a consumer's `./numbers-fragment`
// relative import resolves to the on-disk fixture at build time.
const FRAG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/frag')

/** Compile a macro source string and pull out one exported parse function. */
function makeMacroParser(code: string, exportName: string, id = 'compose-test.ts') {
  const result = transformMacro(code, id, new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code
    // Drop any leftover ESM import lines (e.g. a fragment import that's now dead
    // after inlining — a real bundler tree-shakes it) so `new Function` accepts it.
    .replace(/^\s*import\b[^\n;]*;?$/gm, '')
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + `\nreturn ${exportName}`
  return {
    warnings: result.warnings,
    code: result.code,
    parse: new Function(fnBody)() as (input: string, pos: number, ctx: Record<string, unknown>) => { ok: boolean },
  }
}

// A shared fragment: two rules, the second referencing the first via `g`.
const numbers = (g: any) => ({
  digit: regex(/[0-9]/),
  number: oneOrMore(g.digit),
})

describe('grammar composition (interpreted)', () => {
  it('composes a shared fragment via object spread', () => {
    const { pair } = rules<{ pair: Combinator<unknown> }>(g => ({
      ...numbers(g),                                  // fragment merged in
      pair: sequence(g.number, regex(/,/), g.number), // consumer rule uses g.number
    }))
    expect(parse(pair, '12,34').ok).toBe(true)
    expect(parse(pair, 'x,34').ok).toBe(false)
  })

  it('a later spread overrides an earlier rule of the same name', () => {
    const base = (_g: any) => ({ token: regex(/[a-z]+/) })
    const { token } = rules<{ token: Combinator<unknown> }>(g => ({
      ...base(g),
      token: regex(/[0-9]+/), // override: digits, not letters
    }))
    expect(parse(token, '123').ok).toBe(true)
    expect(parse(token, 'abc').ok).toBe(false)
  })
})

describe('grammar composition (macro-inlined)', () => {
  it('inlines a `...frag(g)` spread into the compiled rule map (no interpreter fallback)', () => {
    const src = `
      import { rules, regex, sequence, oneOrMore } from 'parseman' with { type: 'macro' };
      const numbers = (g) => ({ digit: regex(/[0-9]/), number: oneOrMore(g.digit) });
      export const { pair } = rules((g) => ({
        ...numbers(g),
        pair: sequence(g.number, regex(/,/), g.number),
      }));
    `
    const m = makeMacroParser(src, 'pair')
    // Fully compiled — no warnings, parseman import removed.
    expect(m.warnings).toEqual([])
    expect(m.code).not.toContain("from 'parseman'")
    // And it parses correctly (fragment rules `digit`/`number` resolved through `g`).
    expect(m.parse('12,34', 0, {}).ok).toBe(true)
    expect(m.parse('x,34', 0, {}).ok).toBe(false)
  })

  it('a later property overrides a fragment rule of the same name (spread order)', () => {
    const src = `
      import { rules, regex } from 'parseman' with { type: 'macro' };
      const base = (g) => ({ token: regex(/[a-z]+/) });
      export const { token } = rules((g) => ({
        ...base(g),
        token: regex(/[0-9]+/),
      }));
    `
    const m = makeMacroParser(src, 'token')
    expect(m.warnings).toEqual([])
    expect(m.parse('123', 0, {}).ok).toBe(true)   // override won: digits
    expect(m.parse('abc', 0, {}).ok).toBe(false)  // not the base's letters
  })

  it('inlines nested spreads and a block-body fragment with local consts', () => {
    const src = `
      import { rules, regex, sequence, literal } from 'parseman' with { type: 'macro' };
      const inner = (g) => ({ digit: regex(/[0-9]/) });
      const outer = (g) => {
        const comma = literal(',');
        return { ...inner(g), comma, pair: sequence(g.digit, comma, g.digit) };
      };
      export const { pair } = rules((g) => ({ ...outer(g) }));
    `
    const m = makeMacroParser(src, 'pair')
    expect(m.warnings).toEqual([])
    expect(m.parse('1,2', 0, {}).ok).toBe(true)
    expect(m.parse('1x2', 0, {}).ok).toBe(false)
  })

  it('warns and falls back when a spread references an unknown factory', () => {
    const src = `
      import { rules, regex } from 'parseman' with { type: 'macro' };
      export const { leaf } = rules((g) => ({ ...missing(g), leaf: regex(/a/) }));
    `
    const result = transformMacro(src, 'compose-test.ts', new Set(['parseman']))
    expect(result?.warnings.some(w => w.includes("isn't statically evaluable"))).toBe(true)
  })
})

describe('grammar composition (macro-inlined) — imported fragments (tier 2)', () => {
  it('inlines a `...frag(g)` spread whose factory is imported from another module', () => {
    const src = `
      import { rules, regex, sequence } from 'parseman' with { type: 'macro' };
      import { numbers } from './numbers-fragment';
      export const { pair } = rules((g) => ({
        ...numbers(g),
        pair: sequence(g.number, regex(/,/), g.number),
      }));
    `
    // id lives in the fixtures dir so `./numbers-fragment` resolves to real source.
    const m = makeMacroParser(src, 'pair', path.join(FRAG_DIR, 'consumer.ts'))
    // Fully compiled — no interpreter fallback, parseman import removed.
    expect(m.warnings).toEqual([])
    expect(m.code).not.toContain("from 'parseman'")
    // And it parses correctly (imported `digit`/`number` resolved through `g`).
    expect(m.parse('12,34', 0, {}).ok).toBe(true)
    expect(m.parse('x,34', 0, {}).ok).toBe(false)
  })

  it('inlines an imported fragment exported as a `function` declaration', () => {
    const src = `
      import { rules, regex, sequence } from 'parseman' with { type: 'macro' };
      import { numbersFn } from './numbers-fn-fragment';
      export const { pair } = rules((g) => ({
        ...numbersFn(g),
        pair: sequence(g.number, regex(/,/), g.number),
      }));
    `
    const m = makeMacroParser(src, 'pair', path.join(FRAG_DIR, 'consumer.ts'))
    // Fully compiled — the `export function` form must inline, not fall back.
    expect(m.warnings).toEqual([])
    expect(m.code).not.toContain("from 'parseman'")
    expect(m.parse('12,34', 0, {}).ok).toBe(true)
    expect(m.parse('x,34', 0, {}).ok).toBe(false)
  })

  it('warns and falls back when the imported fragment path is unresolvable', () => {
    const src = `
      import { rules, regex, sequence } from 'parseman' with { type: 'macro' };
      import { numbers } from './does-not-exist';
      export const { pair } = rules((g) => ({
        ...numbers(g),
        pair: sequence(g.number, regex(/,/), g.number),
      }));
    `
    const result = transformMacro(src, path.join(FRAG_DIR, 'consumer.ts'), new Set(['parseman']))
    expect(result?.warnings.some(w => w.includes("isn't statically evaluable"))).toBe(true)
  })
})

describe('grammar composition (interpreted) — nested and block-body fragments', () => {
  it('composes nested spreads', () => {
    const inner = (g: any) => ({ digit: regex(/[0-9]/) })
    const outer = (g: any) => ({ ...inner(g), number: oneOrMore(g.digit) })
    const { pair } = rules<{ pair: Combinator<unknown> }>(g => ({
      ...outer(g),
      pair: sequence(g.number, regex(/,/), g.number),
    }))
    expect(parse(pair, '12,34').ok).toBe(true)
  })

  it('composes a block-body fragment with local consts', () => {
    const punct = (g: any) => {
      const comma = regex(/,/)
      return { comma, pair: sequence(g.digit, comma, g.digit), digit: regex(/[0-9]/) }
    }
    const { pair } = rules<{ pair: Combinator<unknown> }>(g => ({ ...punct(g) }))
    expect(parse(pair, '1,2').ok).toBe(true)
    expect(parse(pair, '1x2').ok).toBe(false)
  })
})
