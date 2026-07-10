/**
 * Grammar spec generation demo (`parseman/spec`).
 *
 * Builds a small expression grammar whose precedence is expressed the Parséman
 * way — as layered named rules (or → and → not → comparison → atom) — then
 * generates a formal spec straight from the `rules()` structure:
 *
 *   - EBNF text to stdout
 *   - a self-contained railroad-diagram HTML page
 *
 * Because the emitter walks the SAME combinator tree the interpreter and macro
 * compiler consume, the generated spec cannot drift from what actually parses.
 *
 * Run:  npx tsx examples/spec-gen.ts [out.html]
 */
import { writeFileSync } from 'node:fs'
import {
  rules, choice, sequence, literal, regex, optional, sepBy, oneOrMore, not,
  type Combinator,
} from '../src/index.ts'
import { toEBNF, toRailroadHtml } from '../src/spec/index.ts'

const grammar = rules(g => {
  const ident = regex(/[A-Za-z_][A-Za-z0-9_]*/)
  const number = regex(/[0-9]+(?:\.[0-9]+)?/)
  const cmpOp = choice(literal('=='), literal('!='), literal('<='), literal('>='), literal('<'), literal('>'))

  return {
    // Precedence, loosest first — emitted faithfully as nested productions.
    or: sequence(g.and as Combinator<unknown>, optional(sequence(literal('or'), g.or as Combinator<unknown>))),
    and: sequence(g.not as Combinator<unknown>, optional(sequence(literal('and'), g.and as Combinator<unknown>))),
    not: choice(sequence(literal('not'), g.not as Combinator<unknown>), g.comparison as Combinator<unknown>),
    comparison: sequence(g.atom as Combinator<unknown>, optional(sequence(cmpOp, g.atom as Combinator<unknown>))),
    atom: choice(
      g.call as Combinator<unknown>,
      ident,
      number,
      sequence(literal('('), g.or as Combinator<unknown>, literal(')')),
    ),
    call: sequence(ident, literal('('), optional(sepBy(g.or as Combinator<unknown>, literal(','))), literal(')')),
    // A rule using not() as negative lookahead (rendered as an annotation).
    keyword: sequence(choice(literal('or'), literal('and'), literal('not')), not(regex(/[A-Za-z0-9_]/))),
  }
})

// --- EBNF to stdout -------------------------------------------------------
console.log('=== EBNF ===\n')
console.log(toEBNF(grammar, { root: 'or' }))

console.log('=== EBNF with readable terminal names ===\n')
console.log(
  toEBNF(grammar, {
    root: 'or',
    regexDisplay: src =>
      src.startsWith('[A-Za-z_]') ? 'IDENT'
      : src.startsWith('[0-9]') ? 'NUMBER'
      : undefined,
  }),
)

// --- Railroad diagrams to an HTML file ------------------------------------
const out = process.argv[2] ?? 'grammar-spec.html'
writeFileSync(
  out,
  toRailroadHtml(grammar, {
    root: 'or',
    title: 'Expression grammar',
    regexDisplay: src =>
      src.startsWith('[A-Za-z_]') ? 'IDENT'
      : src.startsWith('[0-9]') ? 'NUMBER'
      : undefined,
  }),
)
console.log(`\nWrote railroad diagrams → ${out}  (open it in a browser)`)
