/**
 * RECOVERY IS ALWAYS LOWERED; A STRICT PARSE IS STILL STRICT.
 *
 * `TableSettings.recovery` used to gate whether the encoder laid down recovery
 * rows at all, which made `compile(...).parseWithErrors()` THROW unless the
 * caller passed a flag `compile()` does not require — a `CompiledParser` contract
 * break. The owner's ruling is that recovery is always lowered: the emitted
 * module grows (json 1,081 → 1,214 B, graphql 2,925 → 3,397 B) against codegen's
 * 15,138 B for the same json root, so the size argument for optionality is gone.
 *
 * LOWERING IS NOT RUNNING, and that is the whole load-bearing claim. Every
 * recovery path stays gated on `ctx._tolerant`, so the rows are inert unless a
 * caller asks for them. This file pins the inertness in BOTH directions: the
 * strict answer must equal the interpreter's strict answer (which is a FAILURE
 * where a tolerant parse would resync), and the tolerant answer must still
 * recover. Deleting the `_tolerant` gate turns the first half green-to-red
 * immediately — a strict parse starts succeeding on junk.
 */
import { describe, expect, it } from 'vitest'
import {
  literal, regex, sepBy, sequence,
  type Combinator, type ParseContext, type ParseError, type ParseResult,
} from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { REC } from '../../src/recovery/scan.ts'

const decl = sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))
const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}')) as Combinator<unknown>

/** `$$` is junk a tolerant list resyncs past and a strict one dies on. */
const INPUT = '{a:1;$$;b:2}'

function strict(entry: Combinator<unknown>, input: string): {
  interpreted: ParseResult<unknown>; exec: ParseResult<unknown>; assembled: ParseResult<unknown>
  execErrors: ParseError[]; assembledErrors: ParseError[]
} {
  const prog = encodeTable({ Entry: entry })
  // `_errors` is LIVE and `_tolerant` is not set. That is the shape that catches a
  // missing gate: a recovery path which forgot to check `_tolerant` would happily
  // fill this sink, and an assertion that only compared `ok` would not notice.
  const execErrors: ParseError[] = []
  const assembledErrors: ParseError[] = []
  return {
    interpreted: entry.parse(input, 0, { trackLines: false, _errors: [] } as unknown as ParseContext),
    exec: execRules(prog)['Entry']!(input, 0, { trackLines: false, _errors: execErrors } as unknown as ParseContext),
    assembled: tableRules(prog)['Entry']!(input, 0, { trackLines: false, _errors: assembledErrors } as unknown as ParseContext),
    execErrors,
    assembledErrors,
  }
}

describe('table lowering — recovery always lowered, still dormant', () => {
  it('a STRICT parse is unchanged by the recovery rows it never executes', () => {
    const r = strict(block, INPUT)
    // The interpreter, run without `_tolerant`, fails on the junk. Both drivers
    // must agree as WHOLE results — `expected` and `span` included, since a
    // half-active recovery path moves those before it moves `ok`.
    expect(r.interpreted.ok).toBe(false)
    expect(r.exec).toEqual(r.interpreted)
    expect(r.assembled).toEqual(r.interpreted)
    // …and nothing was recorded. This is what goes red if the `_tolerant` gate is
    // deleted: the list resyncs, the parse SUCCEEDS, and the sink fills.
    expect(r.execErrors).toEqual([])
    expect(r.assembledErrors).toEqual([])
  })

  it('the same table recovers the moment a parse asks for it', () => {
    const errors: ParseError[] = []
    const prog = encodeTable({ Entry: block })
    const ctx = {
      trackLines: false, _errors: errors, _tolerant: true, _rec: REC,
    } as unknown as ParseContext
    const r = tableRules(prog)['Entry']!(INPUT, 0, ctx)
    expect(r.ok).toBe(true)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('parseWithErrors() works on a parser built with NO options at all', () => {
    // The refusal this replaces was the whole reason recovery was optional.
    const r = compile(block).parseWithErrors(INPUT)
    expect(r.ok).toBe(true)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})
