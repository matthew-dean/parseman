/**
 * How much of the composed (linkable) path's dispatch is already resolved at fuse time?
 *
 * Decides whether extending the `@FS` substitution to the DISJOINT-DISPATCH decision is
 * worth building. Two outcomes, and they point opposite ways:
 *   - most placeholders resolve to a real first-char condition  -> composed grammars
 *     already get guarded firstMatch, and the remaining gap is guarded-O(n) vs O(1);
 *   - most resolve to `true`                                    -> arms are ATTEMPTED,
 *     and the win is the same size as the interpreter's.
 */
import { transformMacro } from '../../src/plugin/index.ts'
import { _fsStats } from '../../src/compiler/linker.ts'

process.env.PARSEMAN_FS_STATS = '1'

const IMP = `import { rules, composeLeaf, choice, sequence, literal, regex, node, many, oneOrMore, trivia } from 'parseman' with { type: 'macro' }`

// A composed grammar shaped like the shipping ones: a recursive, g.X-saturated base
// recognition grammar plus a local leaf that binds it — the composeLeaf shape all four
// dialects use.
const SRC = `${IMP}
const _ws = trivia(oneOrMore(regex(/[ \\t\\n\\r]+/)))
const base = rules({ trivia: _ws }, (g) => ({
  Value:   choice(g.Num, g.Ident, g.Str, g.Paren),
  Num:     regex(/[0-9]+/),
  Ident:   regex(/[a-zA-Z-]+/),
  Str:     sequence(literal('"'), regex(/[^"]*/), literal('"')),
  Paren:   sequence(literal('('), many(g.Value), literal(')')),
  Item:    choice(g.Paren, g.Str, g.Num, g.Ident),
  List:    many(g.Item),
}))
export const g = composeLeaf([base, rules({ trivia: _ws }, (g) => ({
  Doc: node('Doc', many(g.Item), (c) => ({ c })),
}))])
`

const out = transformMacro(SRC.trim(), '/tmp/fuse-stats-probe.ts', new Set(['parseman']))
if (!out) throw new Error('macro returned null')
if ((out.warnings ?? []).length) console.log('warnings:', (out.warnings ?? []).join('; '))

const total = _fsStats.resolved + _fsStats.unresolved
console.log(`compiler: /Users/matthew/git/worktrees/pm-leftfactor/src/compiler/linker.ts`)
console.log(`\n@FS placeholders seen at fuse time: ${total}`)
console.log(`  resolved to a real first-char condition : ${_fsStats.resolved}`)
console.log(`  left as \`true\` (arm always attempted)   : ${_fsStats.unresolved}`)
const art = out.code
console.log(`\nemitted artifact ${art.length} B`)
console.log(`  first-char comparisons : ${(art.match(/_code\d*\s*(?:>=|===|<=)/g) ?? []).length}`)
console.log(`  switch-on-code         : ${(art.match(/switch \(_code/g) ?? []).length}`)
