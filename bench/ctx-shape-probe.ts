/**
 * Hidden-class probe for `ParseContext`.
 *
 *   node --allow-natives-syntax --import tsx/esm bench/ctx-shape-probe.ts
 *
 * Answers two questions, and nothing else — this is not a timing harness:
 *
 *   1. How many REALISED maps does `ctx` have across the configuration matrix
 *      (ast / trackLines / rootTrivia / tolerant / trailing-trivia) crossed with
 *      the three engines (interpreted / codegen / table)? Measured with
 *      `%HaveSameMap`, not asserted.
 *   2. Is `ctx` still in fast properties after a parse that clears the trivia
 *      sinks? Measured with `%HasFastProperties` before and after.
 *
 * The grammar deliberately routes through `token()`, which is the construct
 * that clears `_triviaLog` / `_rootTriviaLog` — the operation the ctx-shape
 * change is about. Run this file at the base commit and at the change and
 * compare the counts: a count that does not drop means the fix did not land.
 */
import { rules } from '../src/combinators/parser.ts'
import { node } from '../src/combinators/node.ts'
import { regex } from '../src/combinators/regex.ts'
import { literal } from '../src/combinators/literal.ts'
import { many } from '../src/combinators/repeat.ts'
import { choice } from '../src/combinators/choice.ts'
import { token } from '../src/combinators/token.ts'
import { classifiedTrivia } from '../src/combinators/map.ts'
import { run } from '../src/functional/run.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { tableRules } from '../src/table/exec.ts'
import type { Combinator, ParseContext } from '../src/types.ts'

const haveSameMap = eval('(a, b) => %HaveSameMap(a, b)') as (a: object, b: object) => boolean
const hasFastProperties = eval('o => %HasFastProperties(o)') as (o: object) => boolean

type Runnable = Parameters<typeof run>[0]

const seen: Array<{ tag: string; ctx: ParseContext }> = []
let CURRENT = 'init'

/**
 * Wrap an entry so it records the `ctx` the driver handed it. Works for all
 * three engines: interpreted entries are combinators (patch `.parse`), codegen
 * and table entries are plain functions.
 */
function spyEntry(entry: Runnable): Runnable {
  if (typeof entry === 'function') {
    const fn = entry as (i: string, p: number, c: ParseContext) => unknown
    return ((i: string, p: number, c: ParseContext) => {
      seen.push({ tag: CURRENT, ctx: c })
      return fn(i, p, c)
    }) as unknown as Runnable
  }
  const inner = entry as Combinator<unknown>
  const orig = inner.parse.bind(inner)
  return new Proxy(inner, {
    get(t, k, r) {
      if (k === 'parse') {
        return (i: string, p: number, c: ParseContext) => {
          seen.push({ tag: CURRENT, ctx: c })
          return orig(i, p, c)
        }
      }
      return Reflect.get(t, k, r)
    },
  }) as unknown as Runnable
}

// Labelled trivia — `run({ rootTrivia })` throws without it, and the rootTrivia
// cell is the one that measured +52% with `delete`, so it must not be skipped.
const trivia = classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
}) as Combinator<unknown>

const grammar = rules<Record<string, Combinator<unknown>>>({ trivia }, g => ({
  Word: node('Word', regex(/[a-z]+/), c => ({ t: 'Word', c })),
  Tok: token(regex(/[0-9]+/)) as Combinator<unknown>,
  Doc: node('Doc', many(choice(g.Word!, g.Tok!, literal(';'))), c => ({ t: 'Doc', c })),
})) as unknown as Record<string, Combinator<unknown>>

const INPUT = 'alpha 12 beta ; gamma /* c */ delta 7 ; epsilon 99'

const ENGINES: Array<[string, Runnable]> = [
  ['interp', grammar.Doc! as unknown as Runnable],
  ['codegen', (compose([grammar as never]) as unknown as Record<string, Runnable>).Doc!],
  ['table', tableRules(encodeTable(grammar)).Doc! as unknown as Runnable],
]

const CONFIGS: Array<[string, Parameters<typeof run>[2]]> = [
  ['ast', {}],
  ['trackLines', { trackLines: true } as never],
  ['rootTrivia', { trivia, rootTrivia: { select: ['blockComment'] } } as never],
  ['tolerant', { tolerant: true } as never],
  ['trivia-tail', { trivia } as never],
]

// ---- %HasFastProperties across a parse that clears the sinks ----------------
let liveFast: boolean | null = null
let afterCtx: ParseContext | null = null
{
  CURRENT = 'fastprops'
  const wrapped = spyEntry(grammar.Doc! as unknown as Runnable)
  run(wrapped, INPUT, {})
  const first = seen[0]
  if (first) {
    liveFast = hasFastProperties(first.ctx)
    afterCtx = first.ctx
  }
  seen.length = 0
}

// ---- realised-map count over engines x configs ------------------------------
for (const [engineName, entry] of ENGINES) {
  const wrapped = spyEntry(entry)
  for (const [cfgName, opts] of CONFIGS) {
    CURRENT = `${engineName}/${cfgName}`
    try {
      // Warm up: V8 can generalize a field's representation on first assignment,
      // so a cold count reads transitions that no longer exist once the code is
      // hot. The steady state is what every real parse sees.
      for (let i = 0; i < 300; i++) run(wrapped, INPUT, opts)
    } catch (e) {
      console.log(`  (skipped ${CURRENT}: ${(e as Error).message.slice(0, 90)})`)
    }
  }
}

const classes: Array<{ rep: ParseContext; tags: Set<string>; n: number }> = []
for (const { tag, ctx } of seen) {
  const hit = classes.find(c => haveSameMap(c.rep, ctx))
  if (hit) { hit.tags.add(tag); hit.n++ } else { classes.push({ rep: ctx, tags: new Set([tag]), n: 1 }) }
}

console.log(`ctx objects observed: ${seen.length}`)
console.log(`REALISED MAPS: ${classes.length}`)
for (const [i, c] of classes.entries()) {
  console.log(`  map#${i + 1}  n=${c.n}  fastProps=${hasFastProperties(c.rep)}  configs=[${[...c.tags].sort().join(', ')}]`)
}
console.log(`%HasFastProperties(ctx) during parse: ${liveFast}`)
console.log(`%HasFastProperties(ctx) after parse:  ${afterCtx ? hasFastProperties(afterCtx) : 'n/a'}`)
