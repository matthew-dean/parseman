/**
 * Fixed lexical bodies that close the Jess grammars' capability gaps. Each body
 * is pinned against the CHARACTER lowering of the same grammar — the build a
 * capability gap forces — in every reader: the reference driver, the closure
 * assembly and the precompiled emitted assembly. A run's whole result is
 * compared (value, span, expected, unconsumedFrom), as is the completion probe's
 * best failure, on accepting and failing inputs, with the token bare and inside
 * an enclosing choice whose expected sets merge with the token's.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, keywords, literal, many, noTrivia, not, oneOrMore, optional, regex, rules, sequence, token, withCtx, word,
} from '../../src/index.ts'
import type { Combinator, ParseContext, ParseFail } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules, cfgKey } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { OP_LEX_PROGRAM, OP_TOKEN } from '../../src/table/ops.ts'
import { collectLexicalCapabilities } from '../../src/compiler/token-alphabet.ts'

type Comb = Combinator<unknown>

/** A capability gap that keeps a whole program on the CHARACTER lowering. */
const GAP = token(sequence(
  literal('a'), literal('b'), literal('c'), literal('d'), literal('e'), literal('f'),
))

function emitted(prog: TableProgram): Record<string, Runnable> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return tableRules({ ...prog, asm: precompiled })
}

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', emitted(prog)],
  ]
}

function probe(entry: Runnable, input: string): ParseFail | null {
  const ctx = createParseContext() as ParseContext & { _probe: { offset: number; best: ParseFail | null } }
  ctx._probe = { offset: input.length, best: null }
  ;(entry as (input: string, pos: number, ctx: ParseContext) => unknown)(input, 0, ctx)
  return ctx._probe.best
}

/**
 * `grammar(r)` builds `{ Root, Wrapped, ... }` where `Root` is the token under
 * test. The selected build must lower `Root` to one lexical program; the
 * character build is the same map plus GAP.
 */
function pinSelectedToCharacter(
  grammar: Record<string, Comb>,
  inputs: readonly string[],
): void {
  const selected = encodeTable(grammar)
  const selectedOps = [...reachableIps(selected)].map(ip => selected.code[ip])
  expect(selectedOps, 'every token lowers to one lexical program').toContain(OP_LEX_PROGRAM)
  expect(selectedOps).not.toContain(OP_TOKEN)
  const character = encodeTable({ ...grammar, Gap: GAP })
  expect([...reachableIps(character)].map(ip => character.code[ip]), 'the gap keeps the CHARACTER lowering')
    .not.toContain(OP_LEX_PROGRAM)
  const characterReaders = readers(character)
  for (const [readerName, selectedRules] of readers(selected)) {
    const characterRules = characterReaders.find(([name]) => name === readerName)![1]
    for (const rule of Object.keys(grammar)) {
      for (const input of inputs) {
        const label = `${readerName} ${rule} ${JSON.stringify(input)}`
        expect(digestValue(run(selectedRules[rule]!, input)), label)
          .toBe(digestValue(run(characterRules[rule]!, input)))
        expect(probe(selectedRules[rule]!, input), `probe ${label}`)
          .toEqual(probe(characterRules[rule]!, input))
      }
    }
  }
}

const wrap = (root: Comb): Record<string, Comb> => ({
  Root: root,
  Wrapped: choice(sequence(root, literal(';')), literal('!'), regex(/[a-z]+#/)),
})

describe('fixed lexical choice of any arity', () => {
  // The .jess variable-reference token: `$.`, `$^name`, `$name`.
  const jessVariable = token(noTrivia(choice(
    literal('$.'),
    sequence(literal('$^'), regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)),
    sequence(literal('$'), regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)),
  )))

  it('lowers a 3-arm ordered choice with the character expected sets', () => {
    pinSelectedToCharacter(wrap(jessVariable),
      ['$.', '$^a', '$a', '$^', '$', '$1', 'x', '', '$a;', '$.;', '!', 'ab#'])
  })

  // The Less media-query word: not a connective, not `only`, then an identifier.
  const connective = token(noTrivia(choice(
    keywords(['not', 'only', 'and', 'or', 'from', 'to'], { caseInsensitive: true, boundary: '-_a-zA-Z0-9' }),
    regex(/and(?![-_a-zA-Z0-9])/i),
    regex(/or(?![-_a-zA-Z0-9])/i),
  )))
  const queryWord = token(noTrivia(sequence(
    not(connective),
    not(keywords(['only'], { caseInsensitive: true, boundary: '-_a-zA-Z0-9' })),
    regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/),
  )))

  it('lowers a 3-arm choice under a negative assertion', () => {
    pinSelectedToCharacter(wrap(queryWord),
      ['not', 'ONLY', 'and', 'or', 'from', 'nothing', 'orange', 'x', '1', '', 'x;', 'and;', 'ab#'])
  })
})

describe('fixed lexical repeat', () => {
  const ident = regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)

  it('lowers token(rule) whose rule is a one-or-more run, under a grammar trivia', () => {
    // The shared `PagePseudoRun` (`:first:left`), referenced as `token(g.PagePseudoRun)`.
    const grammar = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
      Root: token(g.PagePseudoRun!),
      PagePseudoRun: noTrivia(oneOrMore(sequence(literal(':'), ident))),
      Wrapped: choice(sequence(token(g.PagePseudoRun!), literal('{')), literal('!'), regex(/[a-z]+#/)),
    })) as Record<string, Comb>
    pinSelectedToCharacter(grammar,
      [':first', ':first:left', ':a:b:c', ':', ':1', ':a:', ':a:1', 'x', '', ':a {', ':a{', ':a:{', '!'])
  })

  it('lowers a bounded and an unbounded many', () => {
    pinSelectedToCharacter(wrap(token(sequence(ident, many(sequence(literal(':'), ident))))),
      ['a', 'a:b', 'a:b:c', 'a:', 'a:1', '1', '', 'a:b;', '!'])
    pinSelectedToCharacter(wrap(token(oneOrMore(sequence(literal(':'), ident), { min: 2, max: 3 }))),
      [':a', ':a:b', ':a:b:c', ':a:b:c:d', ':a:', '', ':a:b;', '!'])
  })
})

describe('fixed lexical no-trivia scopes and rule references', () => {
  const IDENT_BOUNDARY = '-_a-zA-Z0-9\\u0080-\\uFFFF\\\\'
  const ident = regex(/-?(?:[_a-zA-Z\u0080-\uffff]|\\[^\n\r\f])(?:[-_a-zA-Z0-9\u0080-\uffff]|\\[^\n\r\f])*/)
  const at = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
    PagePseudoRun: noTrivia(oneOrMore(sequence(literal(':'), ident))),
    ImportAtKeyword: word('@import', IDENT_BOUNDARY, { caseInsensitive: true }),
    ConditionalAtKeyword: keywords(['@media', '@container', '@supports'], { caseInsensitive: true, boundary: IDENT_BOUNDARY }),
    KeyframesAtKeyword: regex(/@(?:-[a-z]+-)?keyframes(?![-_a-zA-Z0-9\u0080-\uFFFF\\])/i),
    // Less's at-rule prelude word: an identifier, then `(` or a pseudo-page run.
    Root: token(noTrivia(sequence(ident, optional(choice(literal('('), g.PagePseudoRun!))))),
    // Less's at-keyword ladder: a no-trivia token scope as a choice arm.
    NonStatementAtKeyword: token(noTrivia(choice(
      keywords(['@-import', '@-compose', '@compose', '@-use', '@use', '@-export'], { caseInsensitive: true, boundary: IDENT_BOUNDARY }),
      g.ImportAtKeyword!, g.ConditionalAtKeyword!,
    ))),
    CustomValueAtKeyword: token(noTrivia(choice(g.NonStatementAtKeyword!, g.KeyframesAtKeyword!))),
    Wrapped: choice(sequence(g.Root!, literal(';')), sequence(g.CustomValueAtKeyword!, literal('{')), literal('!')),
  })) as Record<string, Comb>

  it('lowers a token whose rule reference and choice arm are no-trivia scopes', () => {
    pinSelectedToCharacter(at, [
      'page', 'page(', 'page:first', 'page:first:left', 'page:', 'page :first', '1',
      '@media', '@MEDIA', '@import', '@use', '@-use', '@keyframes', '@-webkit-keyframes', '@mediax', '@foo', '@',
      'page;', 'page:a;', '@media{', '@keyframes{', '!', '',
    ])
  })

  it('does not lower a reference that reinstalls its rule\'s trivia', () => {
    // A rule referenced with no trivia in force runs under its own ambient
    // trivia when it has a position that reads it (`ref.ts`), so `a = b`
    // parses inside the token. A lexical body would glue it to `a=b`.
    const g = rules({ trivia: regex(/ +/) }, (r: Record<string, Comb>) => ({
      Root: noTrivia(sequence(literal('<'), token(r.Pair!), literal('>'))),
      Pair: sequence(ident, literal('='), ident),
    })) as Record<string, Comb>
    const prog = encodeTable(g)
    expect([...reachableIps(prog)].map(ip => prog.code[ip])).not.toContain(OP_LEX_PROGRAM)
    for (const [name, entries] of readers(prog)) {
      expect(run(entries.Root!, '<a = b>').ok, name).toBe(true)
      expect(digestValue(run(entries.Root!, '<a = b>')), name).toBe(digestValue(run(g.Root!, '<a = b>')))
    }
  })
})

describe('withCtx children are bound by name in every reader', () => {
  it('closes capability over a withCtx scope and lowers the tokens beside it', () => {
    // Less and SCSS scope parse state with withCtx; its edges kept the whole
    // program on the character lowering although the emitter binds its child.
    const ident = regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)
    const g = rules({ trivia: regex(/ +/) }, (r: Record<string, Comb>) => ({
      Root: token(noTrivia(choice(literal('$.'), sequence(literal('$^'), ident), sequence(literal('$'), ident)))),
      Wrapped: withCtx({ inMixin: true }, sequence(r.Root!, literal(';'))),
    })) as Record<string, Comb>
    expect(collectLexicalCapabilities(Object.keys(g).sort().map(k => g[k]!), k => g[k]).capabilityComplete).toBe(true)
    pinSelectedToCharacter(g, ['$a', '$.', '$^b', '$', 'x', '', '$a;', '$a ;', '$.;', '$1;'])
  })
})

