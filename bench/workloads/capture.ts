/**
 * Kept apart from `index.ts` because these use API a cross-version A/B reference may
 * not have (`sourceLeaf` postdates the 0.48.0 peak), and every timed gate loads
 * `index.ts` against that reference. Only the call-count gate, which measures against
 * `origin/main`, loads this file.
 */
import { choice, compile, cstBuildHost, leaf, literal, node, oneOrMore, optional, parser, regex, rules, sequence, sourceLeaf, trivia, type Combinator } from '../../src/index.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import { jsonPayload, makePlain, type Workload } from './index.ts'

/**
 * Capture shapes no corpus workload in `index.ts` reaches, counted by the call-count gate only
 * (`bench/call-count-guard.ts`), not timed. Each is a plain parse, so the run installs the
 * plain skip set:
 *
 * - `json/captureTrivia` — an AST parse with `captureTrivia: true` and no CST buffer ever
 *   open, over pretty-printed JSON so every gap has trivia in it.
 * - `cst/leaves` — a CST parse whose gaps fall mostly inside `leaf()` and `sourceLeaf()`,
 *   which close the CST buffer for their span.
 *
 * - `cst/mixed` — a CST parse of a rule reached both inside a `node()` and outside every
 *   node, so its gaps cannot know from the grammar whether a buffer is open.
 *
 * Capture is on at every gap of all three, with no buffer open at most gaps of the first
 * two. A skip that records a gap without asking whether a buffer is open pays a call per
 * gap that does nothing; one that asks must not ask again when it pushes.
 */
export function buildCaptureWorkloads(): Workload[] {
  const jsonInput = JSON.stringify(JSON.parse(jsonPayload(24)), null, 2)
  const leaves = rules({ trivia: trivia(regex(/[ \n]+/)) }, (g: { Doc: Combinator<unknown>; Item: Combinator<unknown> }) => ({
    Doc: node('Doc', oneOrMore(g.Item)),
    Item: node('Item', sequence(
      literal('x'),
      leaf(oneOrMore(literal('a')), (v: unknown) => v),
      sourceLeaf(oneOrMore(literal('b')), (v: unknown) => v),
      literal('y'),
    )),
  }))
  const leafInput = Array.from({ length: 400 }, () => 'x a a a a a a a a b b b b b b b b y').join('\n')
  const mixed = rules({ trivia: trivia(regex(/[ \n]+/)) }, (g: { Root: Combinator<unknown>; X: Combinator<unknown> }) => ({
    Root: oneOrMore(choice(node('A', g.X), sequence(literal('!'), g.X))),
    X: sequence(literal('a'), optional(literal('-')), literal('b'), literal('c')),
  }))
  const mixedInput = Array.from({ length: 400 }, (_, i) => i % 4 === 3 ? '! a b c' : 'a b c').join('\n')
  const cstWorkload = (id: string, c: Combinator<unknown>, input: string): Workload => ({
    id,
    bytes: input.length,
    make: () => {
      const compiled = compile(c, undefined, { hostMode: 'cst' })
      const build = cstBuildHost()
      return { parse: () => compiled.parseWithContext(input, { trackLines: false, build }, 0) }
    },
    input,
  })
  return [
    { id: 'json/captureTrivia', bytes: jsonInput.length, make: makePlain(parser({ captureTrivia: true }, jsonDoc), jsonInput), input: jsonInput },
    cstWorkload('cst/leaves', leaves.Doc, leafInput),
    cstWorkload('cst/mixed', mixed.Root, mixedInput),
  ]
}
