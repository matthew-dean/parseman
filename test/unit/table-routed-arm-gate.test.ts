/**
 * A choice whose arms open with the token their `dispatch()` already routed
 * gates each arm on what follows that token (`OP_RGATE`), so the statement name
 * is read once and the next character decides: `(` a call, `:` a declaration,
 * `{` a ruleset. `routed()` has no first set of its own, so without the gate
 * every arm is entered at every statement. Results are the interpreter's in all
 * three table readers, accepting and failing inputs alike.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, dispatch, keywords, label, literal, node, optional, otherwise, regex, routed, rules, sepBy, sequence, word,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules, cfgKey } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_RGATE } from '../../src/table/ops.ts'

type Comb = Combinator<unknown>

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
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
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', tableRules({ ...prog, asm: precompiled })],
  ]
}

// The Less statement head: one identifier, then a call, a declaration or a ruleset.
const statements = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
  Sheet: sepBy(g.Statement!, literal(';')),
  Statement: dispatch(regex(/[a-z][-a-z0-9]*/), otherwise(choice(
    node('Call', sequence(routed(), literal('('), sepBy(regex(/[0-9]+/), literal(',')), literal(')')),
      children => ({ call: children[0] })),
    node('Declaration', sequence(routed(), literal(':'), regex(/[a-z0-9]+/)),
      children => ({ declaration: children[0], value: children[2] })),
    node('Ruleset', sequence(node('Selector', sequence(routed()), children => children[0]), literal('{'), literal('}')),
      children => ({ ruleset: children[0] })),
  ))),
})) as Record<string, Comb>

describe('a choice of routed arms gates on the character after the token', () => {
  it('wraps each routed arm in a gate on its next term', () => {
    const prog = encodeTable(statements)
    const gates = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE)
    expect(gates).toHaveLength(3)
  })

  it('parses and fails as the interpreter does in every reader', () => {
    const inputs = [
      'a(1,2)', 'a:b', 'a{}', 'a : b', 'a (1)', 'a {}', 'a(1);b:c;d{}',
      'a', 'a?', 'a(', 'a:', 'a{', 'a:b;c', 'a;b', '1', '', 'a(x)', 'a :', 'a ?',
    ]
    for (const [name, entries] of readers(encodeTable(statements))) {
      for (const input of inputs) {
        expect(digestValue(run(entries.Sheet!, input)), `${name} ${JSON.stringify(input)}`)
          .toBe(digestValue(run(statements.Sheet!, input)))
      }
    }
  })

  it('gates only an arm whose next term fails with its static expected set', () => {
    // A miss reports the next term's static expected set. A sequence over an
    // `optional` prefix names the prefix statically but not when it runs, and a
    // choice whose arms share an opener is not a terminal either: neither is gated.
    const shapes = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
      Sheet: sepBy(g.Statement!, literal(';')),
      Statement: dispatch(regex(/[a-z]+/), otherwise(choice(
        node('Prefixed', sequence(routed(), sequence(optional(literal('a')), literal('b'))), children => ({ prefixed: children[0] })),
        node('Shared', sequence(routed(), choice(sequence(literal('('), literal('x')), sequence(literal('('), literal('y')))), children => ({ shared: children[0] })),
        node('Plain', sequence(routed(), literal(':')), children => ({ plain: children[0] })),
      ))),
    })) as Record<string, Comb>
    const prog = encodeTable(shapes)
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE)).toHaveLength(1)
    const prefixed = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
      Sheet: sepBy(g.Statement!, literal(';')),
      Statement: dispatch(regex(/[a-z]+/), otherwise(choice(
        node('Prefixed', sequence(routed(), sequence(optional(literal('a')), literal('b'))), children => ({ prefixed: children[0] })),
        node('Plain', sequence(routed(), literal(':')), children => ({ plain: children[0] })),
      ))),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(prefixed))) {
      for (const input of ['k?', 'kab', 'kb', 'ka?', 'k:', 'k', 'k a', 'k ?', 'k:;kb']) {
        expect(digestValue(run(entries.Sheet!, input)), `${name} ${JSON.stringify(input)}`)
          .toBe(digestValue(run(prefixed.Sheet!, input)))
      }
    }
  })
  it('reports the set the next term fails with on a miss, not its derived set', () => {
    // `keywords()` and `word()` fail with `keyword`; `deriveExpected` lists each
    // word. A gate miss is that term failing at the token's end, so it reports what
    // the term reports there.
    const terms = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
      Sheet: sepBy(g.Statement!, literal(';')),
      Statement: dispatch(regex(/[a-z]+/), otherwise(choice(
        node('Word', sequence(routed(), word('is', 'a-z')), children => ({ word: children[0] })),
        node('Keywords', sequence(routed(), keywords(['as', 'of'])), children => ({ keywords: children[0] })),
        node('Label', sequence(routed(), label('number', regex(/[0-9]+/))), children => ({ label: children[0] })),
        node('Literal', sequence(routed(), literal('X', { caseInsensitive: true })), children => ({ literal: children[0] })),
      ))),
    })) as Record<string, Comb>
    const prog = encodeTable(terms)
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE)).toHaveLength(4)
    expect(run(terms.Sheet!, 'k').expected).toEqual(['keyword', 'keyword', 'number', '"X"'])
    for (const [name, entries] of readers(prog)) {
      for (const input of ['k', 'k?', 'k ?', 'k is', 'k of', 'k 9', 'k x', 'k;k', 'k is;k?']) {
        expect(digestValue(run(entries.Sheet!, input)), `${name} ${JSON.stringify(input)}`)
          .toBe(digestValue(run(terms.Sheet!, input)))
      }
    }
  })
})
