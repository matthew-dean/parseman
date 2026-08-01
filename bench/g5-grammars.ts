/**
 * G5 lane driver: correctness first, then the numbers.
 *
 * Grammar under test: `examples/json` — the smallest real recursive `rules()`
 * grammar in the repo, and one of the grammars in the external comparison
 * benchmark, so a speed number here is directly comparable to the chart.
 */
import { rules, literal, regex, sequence, choice, optional, sepBy, transform, trivia, node, many, type Combinator } from '../src/index.ts'

// ---------------------------------------------------------------------------
// JSON, rebuilt as a full rules() map so every production is an addressable
// rule (the shipped example hides most of them in closure consts).
// ---------------------------------------------------------------------------
function unescapeJsonString(inner: string): string {
  if (!inner.includes('\\')) return inner
  return inner
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\//g, '/')
    .replace(/\\b/g, '\b').replace(/\\f/g, '\f').replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}

function objectFromPairs(pairs: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [k, v] of pairs) obj[k] = v
  return obj
}

export const jsonWs = trivia(regex(/[ \t\n\r]*/))

export const jsonRules = rules<{
  Value: Combinator<unknown>
  Str: Combinator<string>
  Num: Combinator<number>
  True: Combinator<boolean>
  False: Combinator<boolean>
  Null: Combinator<null>
  Arr: Combinator<unknown[]>
  Obj: Combinator<Record<string, unknown>>
  Pair: Combinator<[string, unknown]>
}>(g => ({
  Str: transform(
    sequence(literal('"'), regex(/(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/), literal('"')),
    v => unescapeJsonString((v as [string, string, string])[1]),
  ) as Combinator<string>,
  Num: transform(regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/), s => parseFloat(s as string)) as Combinator<number>,
  True: transform(literal('true'), () => true) as Combinator<boolean>,
  False: transform(literal('false'), () => false) as Combinator<boolean>,
  Null: transform(literal('null'), () => null) as Combinator<null>,
  Arr: transform(
    sequence(literal('['), optional(sepBy(g.Value, literal(','))), literal(']')),
    v => ((v as [string, unknown[] | undefined, string])[1] ?? []),
  ) as Combinator<unknown[]>,
  Pair: transform(
    sequence(g.Str, literal(':'), g.Value),
    v => { const t = v as [string, string, unknown]; return [t[0], t[2]] },
  ) as Combinator<[string, unknown]>,
  Obj: transform(
    sequence(literal('{'), optional(sepBy(g.Pair, literal(','))), literal('}')),
    v => objectFromPairs(((v as [string, Array<[string, unknown]> | undefined, string])[1] ?? [])),
  ) as Combinator<Record<string, unknown>>,
  Value: choice(g.Obj, g.Arr, g.Str, g.Num, g.True, g.False, g.Null) as Combinator<unknown>,
}))

// ---------------------------------------------------------------------------
// A node()-bearing grammar on the same ruler the size probe uses, so the
// per-rule byte number is comparable to bench/size/probe.ts's node-scale ladder.
// ---------------------------------------------------------------------------
export function nodeLadder(n: number): Record<string, Combinator<unknown>> {
  const map = rules<Record<string, Combinator<unknown>>>(g => {
    const out: Record<string, Combinator<unknown>> = {}
    for (let i = 0; i < n; i++) {
      out[`N${i}`] = node(`N${i}`, sequence(regex(/[a-z]+/), literal(String.fromCharCode(97 + (i % 26))), optional(literal(';'))), c => ({ t: `N${i}`, c }))
    }
    // `choice` declares a non-empty tuple, so a bare spread does not satisfy it;
    // name the head explicitly rather than widening the signature.
    const arms = Array.from({ length: n }, (_, i) => g[`N${i}`]!)
    out.Root = node('Root', many(choice(arms[0]!, ...arms.slice(1))), c => ({ t: 'Root', c }))
    return out
  })
  return map as Record<string, Combinator<unknown>>
}

/**
 * The probe's BASE grammar (notes/size-reduction.md, bench/size/probe.ts
 * `baseModule`): five node() rules that actually BUILD a tree, unlike the
 * node-scale ladder — whose greedy `[a-z]+` prefix means no N-rule can ever
 * match, making it a size ruler and not a semantic one. Identity has to be
 * gated on something that produces nodes.
 */
export const baseNodes = rules<Record<string, Combinator<unknown>>>(g => ({
  Word: node('Word', regex(/[A-Za-z_][A-Za-z0-9_]*/), c => ({ t: 'Word', c })),
  Num: node('Num', regex(/[0-9]+/), c => ({ t: 'Num', c })),
  Atom: node('Atom', choice(g.Word!, g.Num!), c => ({ t: 'Atom', c })),
  List: node('List', sequence(literal('('), sepBy(g.Atom!, literal(',')), literal(')')), c => ({ t: 'List', c })),
  Doc: node('Doc', many(choice(g.List!, g.Atom!)), c => ({ t: 'Doc', c })),
})) as unknown as Record<string, Combinator<unknown>>

/**
 * Reducer sources for the JSON rule map, in `encodeTable` order. Both lowerings
 * must emit these identically — they are the author's own code, not machinery —
 * so including them keeps the whole-module comparison honest.
 */
export const JSON_FN_SOURCES: string[] = [
  `v => unescapeJsonString(v[1])`,
  `s => parseFloat(s)`,
  `() => true`,
  `() => false`,
  `() => null`,
  `v => (v[1] ?? [])`,
  `v => [v[0], v[2]]`,
  `v => objectFromPairs(v[1] ?? [])`,
]

