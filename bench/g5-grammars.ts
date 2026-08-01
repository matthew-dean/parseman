/**
 * G5 lane driver: correctness first, then the numbers.
 *
 * Grammar under test: `examples/json` — the smallest real recursive `rules()`
 * grammar in the repo, and one of the grammars in the external comparison
 * benchmark, so a speed number here is directly comparable to the chart.
 */
import { rules, literal, regex, sequence, choice, optional, sepBy, transform, trivia, node, many, field, dispatch, when, otherwise, routed, startsWith, type Combinator } from '../src/index.ts'

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
}>({ trivia: jsonWs }, g => ({
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


/**
 * A grammar whose reducers READ THE FIELD MAP.
 *
 * `field()` had no opcode until the map was threaded through `OP_NODE`, and the
 * encoder refused it rather than lower it wrong — a `field` recorded into a sink
 * the node then dropped would parse perfectly and lose the fields silently,
 * which is the failure mode this whole subsystem exists to prevent.
 *
 * Deliberately exercises the shapes `buildFieldMap` distinguishes: a single
 * capture, a REPEATED name (which becomes an array), an absent optional field,
 * and a field nested under a repetition so rollback of a failed arm is covered.
 */
export const fieldNodes = rules<Record<string, Combinator<unknown>>>(g => ({
  Key: node('Key', regex(/[a-z]+/), c => ({ t: 'Key', c })),
  Val: node('Val', regex(/[0-9]+/), c => ({ t: 'Val', c })),
  Pair: node(
    'Pair',
    sequence(field('key', g.Key!), literal('='), field('val', g.Val!)),
    (c, f) => ({ t: 'Pair', c, f }),
  ),
  // `tag` repeats, so the map must turn it into an array; `note` is optional and
  // usually absent, so the map must omit it rather than record `undefined`.
  Entry: node(
    'Entry',
    sequence(
      literal('['),
      sepBy(field('tag', g.Pair!), literal(',')),
      optional(sequence(literal(';'), field('note', g.Key!))),
      literal(']'),
    ),
    (c, f) => ({ t: 'Entry', c, f }),
  ),
  Doc: node('Doc', many(choice(g.Entry!, g.Pair!)), c => ({ t: 'Doc', c })),
})) as unknown as Record<string, Combinator<unknown>>

/**
 * A grammar exercising EVERY dispatch arm shape.
 *
 * Each arm returns a DISTINCT marker, because tree identity alone cannot tell
 * you an arm was chosen for the right reason — only that the tree matched. Two
 * arms that produce the same tree for an input make identity blind to which one
 * ran, so the arms are made distinguishable on purpose and read back directly.
 *
 *   key hit                `@media`      -> 'K:media'
 *   case-insensitive key   `@IMPORT`     -> 'CI:import'   (ASCII-folded key map)
 *   matcher arm            `@-webkit-x`  -> 'M:...'       (startsWith)
 *   otherwise + routed     `@whatever`   -> 'O:@whatever' (fallback OWNS the token)
 */
export const dispatchNodes = rules<Record<string, Combinator<unknown>>>(() => {
  const at = regex(/@[a-zA-Z-]+/)
  return {
    Doc: dispatch(
      at,
      when('@media', transform(literal(''), () => 'K:media')),
      when('@import', transform(literal(''), () => 'CI:import'), { caseInsensitive: true }),
      when(startsWith('@-'), transform(literal(''), () => 'M:vendor')),
      otherwise(transform(routed(), v => `O:${String(v)}`)),
    ) as unknown as Combinator<unknown>,
  }
}) as unknown as Record<string, Combinator<unknown>>

/** The same, with NO `otherwise()` — an unmatched key must FAIL. */
export const dispatchNoFallback = rules<Record<string, Combinator<unknown>>>(() => {
  const at = regex(/@[a-zA-Z-]+/)
  return {
    Doc: dispatch(
      at,
      when('@media', transform(literal(''), () => 'K:media')),
    ) as unknown as Combinator<unknown>,
  }
}) as unknown as Record<string, Combinator<unknown>>

/**
 * `collapse` / `unwrap` / `project` / `trailingTrivia`.
 *
 * WHY THE TEST READS THE VALUE BACK INSTEAD OF TRUSTING IDENTITY — the third
 * time this pattern has decided a design in this lane, so it is written down:
 *
 *   A COLLAPSED NODE AND ITS CHILD CAN DIGEST ALIKE. `collapse` makes the node
 *   BE its single captured child, so the node and the child serialise to the
 *   same bytes and a three-way digest agrees whether or not the collapse
 *   happened. Same for `unwrap` (leaf -> its string) and `project` (the node ->
 *   child N). Identity proves the tree matched; it cannot prove the right child
 *   came out. The proof has to name the child.
 *
 * Each rule is built so the WRONG selection is distinguishable: `Coll` wraps a
 * marker child, `Proj` captures three children so an off-by-one is visible, and
 * `Unwr` wraps a leaf so unwrap-vs-collapse differ (string vs leaf object).
 */
export const selectNodes = rules<Record<string, Combinator<unknown>>>(g => ({
  Marker: node('Marker', regex(/[a-z]+/), c => ({ t: 'Marker', c })),
  // collapse: the single captured child, EXACTLY as captured (stays a node).
  Coll: node('Coll', g.Marker!, { collapse: true }),
  // unwrap: a single captured LEAF becomes its string value.
  Unwr: node('Unwr', regex(/[0-9]+/), { unwrap: true }),
  // project: child index 1 of three, so an off-by-one picks a different letter.
  Proj: node('Proj', sequence(literal('a'), literal('b'), literal('c')), { project: 1 }),
  Doc: node('Doc', many(choice(g.Proj!, g.Unwr!, g.Coll!)), c => ({ t: 'Doc', c })),
})) as unknown as Record<string, Combinator<unknown>>

/** `trailingTrivia`: after a successful body, consume trivia ONCE into this node. */
export const trailingTriviaNodes = rules<Record<string, Combinator<unknown>>>({ trivia: jsonWs }, g => ({
  Word: node('Word', regex(/[a-z]+/), (c, _f, s, _r, tl) => ({ t: 'Word', c, tl: tl.length })),
  Root: node('Root', many(g.Word!), (c, _f, s, _r, tl) => ({ t: 'Root', c, tl: tl.length, end: s.end }), { trailingTrivia: true }),
})) as unknown as Record<string, Combinator<unknown>>
