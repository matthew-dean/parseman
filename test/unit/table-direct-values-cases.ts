/**
 * Shared by the two direct-values differentials (`table-direct-values.test.ts`,
 * `table-direct-values-failures.test.ts`): the legs, and the grammars with their
 * inputs.
 */
import { expect } from 'vitest'
import { baseNodes, cutUnderChoice, cutUnderMany, dispatchNoFallback, dispatchNodes, fieldNodes, forbidSep, jsonRules, jsonWs, nodeLadder, selectNodes, trailingSep, trailingTriviaNodes } from '../../bench/table-grammars.ts'
import { BASE_CASES, JSON_CASES, LESS_CASES, ladderCases } from './table-identity-cases.ts'
import { lessRules } from '../../bench/workloads/less.ts'
import { cssRules } from '../../examples/css/parser.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram, type TableRule } from '../../src/table/program.ts'
import { reachableSites } from '../../src/table/site-labels.ts'
import type { run } from '../../src/functional/run.ts'
import {
  attempt, balanced, choice, dispatch, literal, many, node, noTrivia, oneOrMoreSep, optional, otherwise, peek,
  not, regex, routed, rules, scanTo, sepBy, sequence, token, trivia, when,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'

export type Grammar = Record<string, Combinator<unknown>>
export type Case = { readonly name: string; readonly input: string }

/** A precompiled emitted assembly for the default option set, direct or not. */
function emitted(prog: TableProgram, direct: boolean, select?: ReadonlySet<number>): TableProgram {
  const cfg = defaultAssemblyCfgs(prog)[0]!
  const em = emitAssemblySource(resolveTable(prog), prog, { ...cfg, direct }, assemblyExtraIps(prog), true, select)
  // The leg is what it says it is: direct values print the entry adapter.
  expect(em.source.includes('function _eIn('), direct ? 'direct leg' : 'collector leg').toBe(direct)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
  return { ...prog, asm: [{ key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }] }
}

/** Every other reachable site, so the hybrid crosses an engine edge at every level. */
function stripe(prog: TableProgram): Set<number> {
  const roots = [...Object.values(prog.rules), ...assemblyExtraIps(prog)]
  return new Set([...reachableSites(resolveTable(prog).code, roots)].filter((_, i) => i % 2 === 0))
}

export function legs(prog: TableProgram, entry: string): Record<string, TableRule> {
  return {
    closure: tableRules({ ...prog, asm: [] })[entry]!,
    collectors: tableRules(emitted(prog, false))[entry]!,
    direct: tableRules(emitted(prog, true))[entry]!,
    'direct+closure': tableRules(emitted(prog, true, stripe(prog)))[entry]!,
  }
}

/**
 * The shapes the direct lowering treats differently: nodes that read raw
 * entries, nodes that read their trivia log over a count-only raw buffer, a
 * speculative prefix that must be rolled back, separators demoted out of the
 * children, `token`/`leaf` boundaries that collect nothing, an interpreted scan,
 * a routed dispatch, and lookaheads that push and roll back.
 */
const ws = trivia(regex(/[ \t\n]+/))
const shapes = rules<Grammar>({ trivia: ws }, g => ({
  Doc: node('Doc', many(g.Item!), (children, _f, _s, raw, tl) => ({ doc: children, raw: raw.length, tl: [...tl] })),
  Item: choice(g.Call!, g.Pair!, g.List!, g.Block!, g.Word!, g.Tok!),
  // Reads raw entries: the raw view keeps what `children` does not.
  Call: node('Call', sequence(g.Name!, noTrivia(literal('(')), optional(sepBy(g.Word!, literal(','))), literal(')')),
    (children, _f, span, raw) => ({ call: children, raw: raw.map(r => (r as { value?: unknown }).value ?? r), span })),
  // A speculative prefix: `a = b` is tried as a pair and rolled back to a word.
  Pair: node('Pair', sequence(attempt(sequence(g.Word!, literal('='))), g.Word!), children => ({ pair: children })),
  // Reads its trivia log over a buffer that keeps only a raw count.
  List: node('List', sequence(literal('['), oneOrMoreSep(g.Word!, literal(',')), literal(']')),
    (children, _f, _s, _raw, tl) => ({ list: children, tl: [...tl] })),
  // An interpreted scan, and a lookahead that pushes and rolls back.
  Block: node('Block', sequence(peek(literal('{')), balanced('{', '}')), (children, _f, _s, raw) => ({ block: children, raw: raw.length })),
  Name: regex(/[A-Z][a-z]*/),
  Word: node('Word', sequence(not(literal('Z')), regex(/[a-z]+/)), children => ({ word: (children[0] as { value: string }).value })),
  // A token boundary collects one leaf for its whole match.
  Tok: node('Tok', sequence(token(sequence(literal('#'), regex(/[0-9]+/))), optional(scanTo(literal(';')))), children => ({ tok: children })),
  Route: dispatch(regex(/[a-z]+/), when('if', sequence(routed(), g.Word!)), otherwise(routed())),
}))
const SHAPE_CASES: Case[] = [
  { name: 'call', input: 'Foo(a, b, c)' },
  { name: 'empty call', input: 'Foo()' },
  { name: 'pair', input: 'a = b' },
  { name: 'pair rolled back', input: 'a b' },
  { name: 'list', input: '[ a , b ,c ]' },
  { name: 'block', input: '{ x { y } }' },
  { name: 'token', input: '#12 rest;' },
  { name: 'mixed', input: 'Foo(a) a = b [a,b] {z} #1;' },
  // Rejected input, at every depth.
  { name: 'unclosed call', input: 'Foo(a,' },
  { name: 'bad list', input: '[a,,b]' },
  { name: 'lookahead refuses', input: 'Z' },
  { name: 'unclosed block', input: '{ x' },
  { name: 'stray', input: 'a = ' },
  { name: 'empty', input: '' },
]


/** One grammar under test: its entry, its inputs, and the run options it needs. */
export type Suite = {
  readonly name: string
  readonly grammar: Grammar
  readonly entry: string
  readonly cases: readonly Case[]
  readonly opts?: Parameters<typeof run>[2]
}

const SEPARATED: Case[] = [{ name: 'a', input: 'a' }, { name: 'ab', input: 'a,b' }, { name: 'trail', input: 'a,' }, { name: 'bad', input: ',' }]

export const SUITES: readonly Suite[] = [
  { name: 'shapes', grammar: shapes, entry: 'Doc', cases: SHAPE_CASES },
  { name: 'shapes route', grammar: shapes, entry: 'Route', cases: [{ name: 'if', input: 'if x' }, { name: 'other', input: 'zz' }, { name: 'bad', input: 'if' }] },
  { name: 'json', grammar: jsonRules as unknown as Grammar, entry: 'Value', cases: JSON_CASES, opts: { trivia: jsonWs as never } },
  { name: 'base', grammar: baseNodes, entry: 'Doc', cases: BASE_CASES },
  { name: 'fields', grammar: fieldNodes, entry: 'Doc', cases: [
    { name: 'pair', input: 'ab=12' }, { name: 'entry', input: '[ab=1,cd=2;zz]' },
    { name: 'unclosed', input: '[ab=1' }, { name: 'bad', input: 'ab=zz' }, { name: 'empty', input: '' },
  ] },
  { name: 'dispatch', grammar: dispatchNodes, entry: 'Doc', cases: [
    { name: 'media', input: '@media' }, { name: 'import', input: '@IMPORT' }, { name: 'vendor', input: '@-webkit-x' },
    { name: 'other', input: '@whatever' }, { name: 'bad', input: 'x' }, { name: 'empty', input: '' },
  ] },
  { name: 'dispatch, no fallback', grammar: dispatchNoFallback, entry: 'Doc', cases: [{ name: 'one', input: '@media' }, { name: 'bad', input: '@x' }] },
  { name: 'select', grammar: selectNodes, entry: 'Doc', cases: [
    { name: 'mixed', input: 'abc12abcx!y' }, { name: 'bad', input: 'ab!' }, { name: 'empty', input: '' },
  ] },
  { name: 'trailing trivia', grammar: trailingTriviaNodes, entry: 'Root', cases: [
    { name: 'none', input: 'ab cd' }, { name: 'tail', input: 'ab cd   ' }, { name: 'ws', input: '   ' }, { name: 'empty', input: '' },
  ], opts: { trivia: jsonWs as never } },
  { name: 'cut under choice', grammar: cutUnderChoice, entry: 'Doc', cases: [{ name: 'x', input: '@x!' }, { name: 'y', input: '@y' }, { name: 'bad', input: '@x?' }] },
  { name: 'cut under many', grammar: cutUnderMany, entry: 'Doc', cases: [{ name: 'xx', input: '@x!@x!' }, { name: 'bad', input: '@x!@x?' }] },
  { name: 'trailing separator', grammar: trailingSep, entry: 'Doc', cases: SEPARATED },
  { name: 'forbidden separator', grammar: forbidSep, entry: 'Doc', cases: SEPARATED },
  { name: 'ladder', grammar: nodeLadder(8), entry: 'Root', cases: ladderCases(8) },
  { name: 'less workload', grammar: lessRules as unknown as Grammar, entry: 'Stylesheet', cases: [
    ...LESS_CASES, { name: 'unclosed', input: 'a { color: red' }, { name: 'bad decl', input: 'a { color: }' },
  ] },
  { name: 'css example', grammar: cssRules as unknown as Grammar, entry: 'Stylesheet', cases: [
    { name: 'rule', input: 'a, b > c { color: red; margin: 0 1px }' }, { name: 'at', input: '@media screen { a { b: c } }' },
    { name: 'bad', input: 'a { b: ' },
  ] },
]

export type { TableRule }
