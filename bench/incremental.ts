/**
 * Incremental re-parse benchmark: Parséman `parseDoc` vs Lezer's
 * fragment-reuse incremental parse.
 *
 * Both engines support editing a parsed document and re-parsing only what
 * changed. Their cost curves differ by grammar shape and edit location, so this
 * measures three deliberately different scenarios rather than one flattering
 * number:
 *
 *   1. deep-nested, same-length leaf edit  — favours subtree grafting
 *   2. large flat array, same-length edit  — a single element changes
 *   3. large flat array, structural insert — a new element is added
 *
 * For each, we compare each engine's incremental path against its own
 * from-scratch parse of the edited text, so the speedup is self-relative and
 * honest. Fixtures are compact JSON (no insignificant whitespace) so both
 * engines do equivalent work on identical bytes.
 */
import {
  rules, node, regex, literal, choice, optional, sepBy, sequence,
  parseDoc,
  type CSTNode, type CSTLeaf, type CSTError,
  type ParseContext, type ParseResult,
} from '../src/index.ts'
import { parser as lezerJsonParser } from '@lezer/json'
import { TreeFragment, type Tree, type ChangedRange } from '@lezer/common'
import { LARGE_JSON } from './fixtures.ts'

// ---------------------------------------------------------------------------
// Parséman CST JSON grammar as a rule registry (no trivia; compact JSON).
// Each node type is a registry key so parseDoc().edit() can re-parse
// the smallest containing rule by type.
// ---------------------------------------------------------------------------

type JNode = CSTNode
type RuleFn = (input: string, pos: number, ctx: ParseContext) => ParseResult<JNode>

function mk(type: string, ch: ReadonlyArray<CSTNode | CSTLeaf | CSTError>, span: { start: number; end: number }): JNode {
  return { _tag: 'node', type, span, state: null, children: ch }
}

const strRe = regex(/"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/)
const numRe = regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)

const grammar = rules(g => {
  const Str    = node('Str',    strRe,            (c, _r, s) => mk('Str', c as JNode['children'], s))
  const Num    = node('Num',    numRe,            (c, _r, s) => mk('Num', c as JNode['children'], s))
  const True   = node('True',   literal('true'),  (c, _r, s) => mk('True', c as JNode['children'], s))
  const False  = node('False',  literal('false'), (c, _r, s) => mk('False', c as JNode['children'], s))
  const Null   = node('Null',   literal('null'),  (c, _r, s) => mk('Null', c as JNode['children'], s))
  const Member = node('Member',
    sequence(g.Str, literal(':'), g.Value),
    (c, _r, s) => mk('Member', c as JNode['children'], s))
  const Object = node('Object',
    sequence(literal('{'), optional(sepBy(g.Member, literal(','))), literal('}')),
    (c, _r, s) => mk('Object', c as JNode['children'], s))
  const Array = node('Array',
    sequence(literal('['), optional(sepBy(g.Value, literal(','))), literal(']')),
    (c, _r, s) => mk('Array', c as JNode['children'], s))
  const Value = node('Value',
    choice(g.Object, g.Array, g.Str, g.Num, g.True, g.False, g.Null),
    (c, _r, s) => mk('Value', c as JNode['children'], s))
  return { Value, Object, Array, Member, Str, Num, True, False, Null }
})

const registry: Record<string, RuleFn> = Object.fromEntries(
  Object.entries(grammar).map(([k, comb]) => [k, (i, p, c) => comb.parse(i, p, c)]),
) as Record<string, RuleFn>

// ---------------------------------------------------------------------------
// Fixtures + edit scenarios
// ---------------------------------------------------------------------------

export type EditScenario = {
  name: string
  input: string
  /** old-doc offsets: replace [from, to) with `replacement` */
  from: number
  to: number
  replacement: string
}

// Representative fixture: the same 12 kB nested JSON the CST chart uses —
//   {"items":[{"id":0,"value":"item-0","nested":{"a":0,"b":"str-0"}}, …]}
const DOC = LARGE_JSON

// 1. Overtype a leaf (same length, delta 0): the "type over a character" case.
//    Edit inside a deep string value near the middle of the document.
const leafPos = DOC.indexOf('str-100')
const overtype: EditScenario = {
  name: 'overtype leaf (same-length)',
  input: DOC,
  from: leafPos,
  to: leafPos + 1,
  replacement: 'X',
}

// 2. Insert a character into that leaf (delta +1): the common keystroke, which
//    shifts every offset after it.
const insertChar: EditScenario = {
  name: 'insert char in leaf (+1)',
  input: DOC,
  from: leafPos,
  to: leafPos,
  replacement: 'Z',
}

// 3. Structural insert near the front: add a whole new array element just after
//    the opening '[' so ~all following siblings shift.
const arrPos = DOC.indexOf('[') + 1
const structural: EditScenario = {
  name: 'structural insert (new element)',
  input: DOC,
  from: arrPos,
  to: arrPos,
  replacement: '{"id":9999,"value":"x","nested":{"a":0,"b":"y"}},',
}

export const SCENARIOS: EditScenario[] = [overtype, insertChar, structural]

function applyEdit(s: EditScenario): string {
  return s.input.slice(0, s.from) + s.replacement + s.input.slice(s.to)
}

// ---------------------------------------------------------------------------
// Parséman incremental
// ---------------------------------------------------------------------------

export function makeParsemanIncremental(s: EditScenario): {
  incremental: () => unknown
  fullReparse: () => unknown
} {
  // JSON arrays/objects are genuine repetitions, so structural list-reuse is sound
  // here — opt in so a structural insert reuses the untouched tail instead of
  // reparsing the whole collection.
  const opts = { structuralReuse: true } as const
  const base = parseDoc<JNode>(registry, 'Value', s.input, opts)
  if (!base.tree) throw new Error(`Parséman failed to parse fixture: ${s.name}`)
  const newInput = applyEdit(s)
  return {
    incremental: () => base.edit(s.from, s.to, s.replacement),
    fullReparse: () => parseDoc<JNode>(registry, 'Value', newInput, opts),
  }
}

// ---------------------------------------------------------------------------
// Lezer incremental
// ---------------------------------------------------------------------------

export function makeLezerIncremental(s: EditScenario): {
  incremental: () => Tree
  fullReparse: () => Tree
} {
  const baseTree = lezerJsonParser.parse(s.input)
  const newInput = applyEdit(s)
  const change: ChangedRange = {
    fromA: s.from,
    toA: s.to,
    fromB: s.from,
    toB: s.from + s.replacement.length,
  }
  return {
    incremental: () => {
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(baseTree), [change])
      return lezerJsonParser.parse(newInput, fragments)
    },
    fullReparse: () => lezerJsonParser.parse(newInput),
  }
}
