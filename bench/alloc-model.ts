/**
 * Allocation model that reproduces jess's parse-time node/CST allocation
 * pattern: many small nodes (Dimension/Color/Keyword/Function/Str), source
 * spans, nested children, comma/space value lists, and a STRUCTURAL build host
 * (the shape the Chevrotain-compat layer injects). Trivia is captured, like the
 * real jess parsers.
 *
 * Exports a compiled entry + host so bench/run scripts can profile the three
 * phases (recognizer / structuralCapture / hostConstruction) and A/B wall-clock.
 */
import {
  rules, node, regex, literal, choice, many, sequence, trivia, parser, compile,
  type ParseContext, type BuildHost,
} from '../src/index.ts'

const ws = trivia(regex(/(?:[ \t\n\r]+|\/\*(?:[^*]|\*(?!\/))*\*\/)+/))

const identRe = regex(/-?[a-zA-Z_][a-zA-Z0-9_-]*/)
const numRe = regex(/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-z]+)?/)
const hexRe = regex(/#[0-9a-fA-F]{3,8}/)
const strRe = regex(/"(?:[^"\\]|\\.)*"/)

// Structural value grammar: mirrors jess value/selector reducers — many small
// leaf nodes, a Function node with nested arg list, comma + space lists.
const { Doc } = rules({ trivia: ws, captureTrivia: true }, g => {
  const Dimension = node('Dimension', numRe)
  const Color = node('Color', hexRe)
  const Str = node('Str', strRe)
  const Keyword = node('Keyword', identRe)
  const Func = node(
    'Func',
    sequence(identRe, literal('('), g.ArgList, literal(')')),
  )
  const Primary = node('Primary', choice(g.Func, g.Dimension, g.Color, g.Str, g.Keyword))
  // space-separated compound value
  const Compound = node('Compound', many(g.Primary))
  // comma list
  const ArgList = node('ArgList', sequence(g.Compound, many(sequence(literal(','), g.Compound))))
  const Decl = node('Decl', sequence(g.Keyword, literal(':'), g.ArgList, literal(';')))
  const Doc = node('Doc', many(g.Decl))
  return { Doc, Decl, ArgList, Compound, Primary, Func, Dimension, Color, Str, Keyword }
})

const compiled = compile(Doc)

/**
 * The jess-style structural host: builds a positioned AST node from
 * `rawChildren` (arg 4), copying span — exactly like `cssCstBuildHost`. Declares
 * all positional params so `Function.length === 7` (arity gating can't help it).
 */
function makeHost(optOutChildren: boolean): BuildHost {
  const h: BuildHost = (
    type: string,
    _children: ReadonlyArray<unknown>,
    _fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
    _triviaLog: readonly number[],
    state: unknown,
  ) => ({ _tag: 'node', type, span: { start: span.start, end: span.end }, state: state ?? null, children: rawChildren })
  if (optOutChildren) h._parsemanReadsChildren = false
  return h
}

/** Baseline host (chV allocated) and opted-out host (chV elided). */
export const host = makeHost(false)
export const hostOptOut = makeHost(true)

export const entry = (input: string, pos: number, ctx: ParseContext) =>
  compiled.parseWithContext(input, ctx, pos)

/** Build a large jess-like value-heavy input. */
export function buildInput(decls = 1500): string {
  const parts: string[] = []
  const kws = ['solid', 'auto', 'inherit', 'flex', 'none', 'bold']
  for (let i = 0; i < decls; i++) {
    parts.push(
      `prop-${i}: ${i}px 1.5em #a0${(i % 90) + 10}fff ${kws[i % kws.length]} ` +
        `rgba(${i % 255}, ${(i * 3) % 255}, 0, 0.${i % 9}), ` +
        `"str-${i}" translate(${i}px, -${i % 40}px) ${kws[(i + 2) % kws.length]}; /* c${i} */`,
    )
  }
  return parts.join('\n')
}

export { compiled }
