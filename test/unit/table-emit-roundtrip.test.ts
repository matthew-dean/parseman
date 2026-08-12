import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableModule, emitTableOnly } from '../../src/table/emit.ts'
import { execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { baseNodes, dispatchNodes, fieldNodes, hostNodes, jsonRules, jsonWs, rootTriviaNodes, selectNodes } from '../../bench/table-grammars.ts'
import { balanced, choice, literal, many, node, optional, regex, rules, scanTo, sepBy, sequence, token, type Combinator } from '../../src/index.ts'
import type { TableProgram } from '../../src/table/program.ts'

/**
 * THE EMITTED MODULE, LOADED AND PARSED WITH.
 *
 * Emitting is the whole point of the lowering, and until this file the only
 * assertion on `emitTableModule` read the output STRING — that it contains
 * `tableRules(` and no `function`. A module can satisfy both and still be
 * unloadable, or load and drop half the table: the string says nothing about
 * whether the artifact parses. Everything here therefore writes the module to
 * disk, imports it, and parses with the result.
 *
 * The comparison is three-way on purpose. The loaded module and the in-memory
 * table share `exec.ts`, so agreeing with each other only proves the emission
 * carried the data; the INTERPRETER is the independent oracle that says the data
 * was right. Every case below asserts against both.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const EXEC = pathToFileURL(path.resolve(DIR, '../../src/table/exec.ts')).href

/** Emit a program as a real module, write it, import it, hand back its rules. */
async function loadEmitted(prog: TableProgram, tag: string, preamble = ''): Promise<Record<string, unknown>> {
  // The author's reducers are emitted from their own source. `() => {}`
  // placeholders would make every reducer-bearing rule return `undefined` and
  // the round-trip vacuous — the grammars here are chosen closure-free so
  // `String(fn)` is a faithful source.
  // `runtimeRef` NAMES the engine this round-trip binds. `runtime: EXEC` aims the
  // emitted import at the REFERENCE interpreter — deliberately, it is the oracle
  // here — and before the two engines had distinct names that aim was invisible
  // from the emitted source, which read exactly like a shipped artifact.
  const src = emitTableModule(prog, { name: 'g', runtime: EXEC, runtimeRef: 'execRules', fnSources: prog.fns.map(f => String(f)) })
  const dir = mkdtempSync(path.join(tmpdir(), `pm-table-emit-${tag}-`))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  // `preamble` is the surrounding scope a real build already has: reducers that
  // call module-level helpers need those helpers in the emitted module's scope.
  writeFileSync(file, preamble === '' ? src : `${preamble}\n${src}`)
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as { g: Record<string, unknown> }
  return mod.g
}

/** The parse facts a consumer can observe, as one comparable string. */
function outcome(rule: unknown, input: string, opts?: Record<string, unknown>): string {
  const r = run(rule as never, input, opts as never)
  return JSON.stringify({
    ok: r.ok, value: r.value, span: r.span, expected: r.expected, unconsumedFrom: r.unconsumedFrom,
  })
}

describe('table lowering — the EMITTED module round-trips', () => {
  it('a RECOVERY table stays a recovery table across emit', async () => {
    // `rec` selects the pieces that read the sync operands. Emitted without it,
    // the operands are still in `c` and nothing reads them: the module LOADS,
    // PARSES, and silently collects no errors — a strict artifact wearing a
    // tolerant one's shape, which is why the emitted form is asserted here and
    // not only the in-memory one.
    const g = sequence(literal('{'), sepBy(sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/)), literal(';')), literal('}'))
    const prog = encodeTable({ Entry: g as Combinator<unknown> }, { recovery: true })
    const emitted = await loadEmitted(prog, 'recovery')
    const input = '{a:1;$$;b:2}'
    const opts = { tolerant: true }
    expect(outcome(emitted.Entry, input, opts)).toBe(outcome(g as Combinator<unknown>, input, opts))
    expect(run(emitted.Entry as never, input, opts).errors)
      .toEqual(run(g as never, input, opts).errors)
    expect(run(emitted.Entry as never, input, opts).errors).toHaveLength(1)
  })

  it('baseNodes: emitted, loaded, and parse-identical to the table AND the interpreter', async () => {
    const prog = encodeTable(baseNodes)
    const emitted = await loadEmitted(prog, 'base')
    const memory = execRules(prog)

    expect(Object.keys(emitted).sort()).toEqual(Object.keys(memory).sort())

    for (const input of ['abc', '(a,b,12)', '(a,1)zz(b)7', '', '(a,b', '(a,)', '###', '12']) {
      const fromEmitted = outcome(emitted.Doc, input)
      expect(fromEmitted, `emitted vs table on ${JSON.stringify(input)}`).toBe(outcome(memory.Doc, input))
      expect(fromEmitted, `emitted vs interpreter on ${JSON.stringify(input)}`).toBe(outcome(baseNodes.Doc, input))
    }

    // …and the agreed-on value is a real tree, not three engines agreeing on
    // nothing. A module whose rules all returned `undefined` would satisfy every
    // comparison above.
    const doc = run(emitted.Doc as never, '(a,b,12)').value as { t: string; c: Array<{ t: string; c: unknown[] }> }
    expect(doc.t).toBe('Doc')
    expect(doc.c[0]!.t).toBe('List')
    // '(' and ')' are captured leaves; the three items sit between them, and the
    // separators are demoted (a list contributes its ITEMS and nothing else).
    expect(doc.c[0]!.c.map(x => (x as { t?: string; value?: string }).t ?? (x as { value: string }).value))
      .toEqual(['(', 'Atom', 'Atom', 'Atom', ')'])
    const first = doc.c[0]!.c[1] as { c: Array<{ t: string; c: Array<{ value: string }> }> }
    expect(first.c[0]!.t).toBe('Word')
    expect(first.c[0]!.c[0]!.value).toBe('a')
  })

  it('a failing parse reports the SAME expected set and position through the emitted module', async () => {
    // `e:` is the expected-set pool. Dropping or reordering it changes nothing a
    // success-only comparison can see — every accepting case still passes.
    const prog = encodeTable(baseNodes)
    const emitted = await loadEmitted(prog, 'fail')
    const memory = execRules(prog)
    for (const input of ['(a,b', '(', '(,)']) {
      const a = run(emitted.List as never, input)
      const b = run(memory.List as never, input)
      const c = run(baseNodes.List as never, input)
      expect(a.ok).toBe(false)
      expect(a.expected, input).toEqual(b.expected)
      expect(a.expected, input).toEqual(c.expected)
      expect(a.span, input).toEqual(c.span)
      // Not vacuous: the set names the token the parse wanted.
      expect(a.expected.length).toBeGreaterThan(0)
    }
  })

  it('the const-pool regexes keep their STICKY flag across emission', async () => {
    // A regex emitted without `y` still matches — just anywhere. `re.lastIndex =
    // pos` is then ignored, so `Word` would match at offset 3 of '###abc' and the
    // parse would succeed at the wrong place instead of failing.
    const prog = encodeTable(baseNodes)
    const src = emitTableModule(prog, { name: 'g', fnSources: [] })
    expect(src).toMatch(/\/y[,\]]/)
    const emitted = await loadEmitted(prog, 'sticky')
    expect(run(emitted.Word as never, '###abc').ok).toBe(false)
    expect(run(emitted.Word as never, 'abc').ok).toBe(true)
  })

  it('emits a multi-class pool as one delimiter-split string and still round-trips', async () => {
    const prog = encodeTable(baseNodes)
    const src = emitTableModule(prog, { name: 'g', fnSources: prog.fns.map(f => String(f)) })
    const classLine = src.split('\n').find(line => line.startsWith('x:'))

    expect(prog.cc.length).toBeGreaterThan(1)
    expect(classLine).toMatch(/^x:".*"\.split\("."\),$/)

    const emitted = await loadEmitted(prog, 'class-pool-split')
    for (const input of ['abc', '12', '(a,b,12)', '###']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(baseNodes.Doc, input))
    }
  })

  it('field() maps survive emission, populated and not merely present', async () => {
    const prog = encodeTable(fieldNodes)
    const emitted = await loadEmitted(prog, 'field')
    const memory = execRules(prog)
    for (const input of ['ab=12', '[ab=1,cd=2,ef=3]', '[ab=1;zz]', '[ab=1', '']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(memory.Doc, input))
      expect(outcome(emitted.Doc, input), input).toBe(outcome(fieldNodes.Doc, input))
    }
    const fields = (input: string): Record<string, unknown> =>
      ((run(emitted.Doc as never, input).value as { c: Array<{ f: Record<string, unknown> }> }).c[0]!).f
    expect(Object.keys(fields('ab=12')).sort()).toEqual(['key', 'val'])
    expect((fields('[ab=1,cd=2,ef=3]').tag as unknown[]).length).toBe(3)
  })

  it('collapse / unwrap / project pick the same child through the emitted module', async () => {
    // `project: 1` is an OPERAND, not a flag: emitted one slot off, the module
    // still parses and still returns a child — the wrong one.
    const prog = encodeTable(selectNodes)
    const emitted = await loadEmitted(prog, 'select')
    const kids = (input: string): unknown[] =>
      (run(emitted.Doc as never, input).value as { c: unknown[] }).c
    expect(kids('abc')[0]).toBe('b')
    expect(kids('123')[0]).toBe('123')
    expect(typeof kids('123')[0]).toBe('string')
    for (const input of ['abc', '123', 'abc123', '', '###']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(selectNodes.Doc, input))
    }
  })

  it('trackLines survives as `l:1`, and the loaded module reports real line numbers', async () => {
    // `l` is the one field the emitter writes CONDITIONALLY. Omitted, the module
    // loads and parses and every span silently loses its line fields.
    //
    // A grammar that spans lines WITHOUT declaring trivia, because a trivia scope
    // is not emittable at all (see the gap below).
    const lined = rules<Record<string, Combinator<unknown>>>(g => ({
      Line: node('Line', sequence(regex(/[a-z]+/), optional(literal('\n'))), (c, _f, span) => ({ t: 'Line', span })),
      Doc: node('Doc', many(g.Line!), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>

    const tracked = encodeTable(lined, { trackLines: true })
    expect(emitTableModule(tracked, { fnSources: [] })).toContain('l:1,')
    expect(emitTableModule(encodeTable(lined), { fnSources: [] })).not.toContain('l:1,')

    const emitted = await loadEmitted(tracked, 'lines')
    const spans = (run(emitted.Doc as never, 'ab\ncd').value as { c: Array<{ span: Record<string, number> }> }).c
    // The SECOND line starts on line 2 at column 1 — a module that lost `l:1`
    // gives `{start,end}` only, and one that tracked nothing gives line 1 twice.
    expect(spans[0]!.span.startLine).toBe(1)
    expect(spans[1]!.span.startLine).toBe(2)
    expect(spans[1]!.span.startColumn).toBe(1)
    expect(outcome(emitted.Doc, 'ab\ncd')).toBe(outcome(execRules(tracked).Doc, 'ab\ncd'))
    // The plain module is the control: same grammar, no line fields at all.
    const plainEmitted = await loadEmitted(encodeTable(lined), 'lines-plain')
    const plainSpans = (run(plainEmitted.Doc as never, 'ab\ncd').value as { c: Array<{ span: Record<string, number> }> }).c
    expect(Object.keys(plainSpans[1]!.span)).toEqual(['start', 'end'])
  })

  it('a literal carrying quotes and backslashes round-trips through the module text', async () => {
    // `emitConst` writes strings with JSON.stringify. An unescaped quote makes the
    // module a syntax error; a lost backslash makes it parse the wrong input.
    const tricky = rules<Record<string, Combinator<unknown>>>(g => ({
      Odd: node('Odd', sequence(literal('"'), literal('a\\b'), literal('\n')), c => ({ t: 'Odd', c })),
      Doc: node('Doc', many(g.Odd!), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(tricky)
    const emitted = await loadEmitted(prog, 'escape')
    expect(run(emitted.Doc as never, '"a\\b\n').ok).toBe(true)
    expect(outcome(emitted.Doc, '"a\\b\n')).toBe(outcome(tricky.Doc, '"a\\b\n'))
    expect(run(emitted.Doc as never, '"ab\n').ok).toBe(true) // `many` matches zero
    expect((run(emitted.Doc as never, '"ab\n').value as { c: unknown[] }).c).toEqual([])
  })

  it('emitTableOnly is the same table with an EMPTY reducer pool', () => {
    const prog = encodeTable(baseNodes)
    const only = emitTableOnly(prog)
    const full = emitTableModule(prog, { fnSources: prog.fns.map(f => String(f)) })
    expect(only).toContain('f:[]')
    expect(prog.fns.length).toBeGreaterThan(0)
    // Machinery is identical; only the reducer pool differs — that is the claim
    // that makes its byte count comparable to codegen's per-rule cost.
    const machinery = (s: string): string => s.slice(0, s.indexOf('\nf:['))
    expect(machinery(only)).toBe(machinery(full))
    expect(only.length).toBeLessThan(full.length)
  })

  it('the default fnSources are PLACEHOLDERS, so a size probe is not a parser', () => {
    // `fnSources: undefined` emits `() => {}` per reducer. Cheap to assert, and it
    // is the difference between a module that measures and a module that works.
    const prog = encodeTable(baseNodes)
    const src = emitTableModule(prog)
    expect(src.match(/\(\) => \{\}/g)).toHaveLength(prog.fns.length)
  })
})

/**
 * WHAT THE EMITTER COULD NOT EMIT, AND NOW CAN.
 *
 * Every test in this block was a PIN on a defect. The lane that owns
 * `src/table/` has since fixed four of them (`dsp`/`labels`/`classified` are
 * serialised, `emitConst` accepts arrays of primitives, `rules({ trivia })`
 * lowers to data), so each pin is now a positive assertion of the fixed
 * behaviour — asserted through a LOADED module, because "the emitter no longer
 * throws" is not evidence that what it wrote is right.
 *
 * One did not go away: `balanced()`/`scanTo()` still park a live combinator, so
 * the grammar is still unemittable. It is re-pinned in its new form below.
 */
describe('table lowering — the emitted module carries every side table', () => {
  it('a dispatch() grammar emits `p:` and picks the RIGHT arm through the loaded module', async () => {
    // WAS: `prog.dsp` was never written, so the module loaded and threw
    // "Cannot read properties of undefined (reading 'byKey')" on every input.
    //
    // Asserting the module merely LOADS AND PARSES would pass on an emitter that
    // wrote empty key/fold arrays: '@media' would miss every arm and fall into
    // `otherwise()`, which matches. Each arm returns a distinct marker and each
    // marker is read back, so a mis-serialised `keyArm` is visible.
    const prog = encodeTable(dispatchNodes)
    expect(prog.dsp.length).toBe(1)
    const src = emitTableModule(prog, { fnSources: prog.fns.map(f => String(f)) })
    expect(src).toContain('p:[')

    const emitted = await loadEmitted(prog, 'dispatch')
    const memory = execRules(prog)
    const armFor = (rules_: Record<string, unknown>, input: string): unknown =>
      (run(rules_.Doc as never, input).value as [string, unknown])[1]
    expect(armFor(emitted, '@media')).toBe('K:media')        // exact key
    expect(armFor(emitted, '@IMPORT')).toBe('CI:import')     // ASCII-folded key
    expect(armFor(emitted, '@-webkit-x')).toBe('M:vendor')   // startsWith matcher
    expect(armFor(emitted, '@whatever')).toBe('O:@whatever') // otherwise + routed
    // routed() ownership survives too: the fallback consumed the token.
    expect(run(emitted.Doc as never, '@whatever').unconsumedFrom).toBe(null)
    for (const input of ['@media', '@IMPORT', '@-webkit-x', '@whatever', 'nope', '']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(memory.Doc, input))
      expect(outcome(emitted.Doc, input), input).toBe(outcome(dispatchNodes.Doc, input))
    }
  })

  it('node({ tags }) emits, and the tags reach the host through the loaded module', async () => {
    // WAS: `emitConst` refused arrays outright, so every tags-bearing grammar —
    // which is every jess CST grammar — was unemittable.
    //
    // "It emits without throwing" would pass on an emitter that wrote `[]`, and
    // "the module parses" would pass on one that dropped the tags OPERAND. The
    // host is the only reader of that pool entry, so the assertion runs one and
    // reads the 8th argument back off the node.
    const prog = encodeTable(hostNodes, { hostMode: 'cst' })
    expect(emitTableModule(prog, { fnSources: [] })).toContain('["decl"]')
    const emitted = await loadEmitted(prog, 'tags')
    const host = cstBuildHost({ tags: true })
    const root = run(emitted.Doc as never, 'abc', { build: host as never }).value as Record<string, unknown>
    const kid = (root.children as Array<Record<string, unknown>>)[0]!
    expect(kid.type).toBe('Marked')
    expect(kid.tags).toEqual(['decl'])
    expect(JSON.stringify(root))
      .toBe(JSON.stringify(run(execRules(prog).Doc! as never, 'abc', { build: host as never }).value))
  })

  it('the emitted module carries its HOST MODE, and refuses the wrong pairing', async () => {
    // The stamp is what makes `run()` reject a hostless 'cst' parse. Emitted and
    // not stamped, the artifact would quietly return AST — the very defect that
    // was fixed in the in-memory table, one hop downstream.
    const cst = await loadEmitted(encodeTable(hostNodes, { hostMode: 'cst' }), 'mode-cst')
    const ast = await loadEmitted(encodeTable(hostNodes), 'mode-ast')
    expect(emitTableModule(encodeTable(hostNodes, { hostMode: 'cst' }), { fnSources: [] })).toContain('h:"cst"')
    expect(emitTableModule(encodeTable(hostNodes), { fnSources: [] })).not.toContain('h:')
    expect(() => run(cst.Doc as never, 'abc')).toThrow(/host mode "cst"/)
    expect(() => run(ast.Doc as never, 'abc', { build: cstBuildHost({ tags: true }) as never })).toThrow(/host mode "ast"/)
    // …and the pairing that IS valid still works, so this is not a module that
    // simply throws on everything.
    expect(run(ast.Doc as never, 'abc').ok).toBe(true)
  })

  it('a grammar with SCOPED TRIVIA emits, and the loaded module skips the trivia itself', async () => {
    // WAS: `rules({ trivia })` pooled the trivia COMBINATOR, so jsonRules, the
    // Less workload and all four jess dialects were emit-blocked. Trivia is now
    // lowered to `tv:` specs and rebuilt at load.
    //
    // The discriminating input is whitespace: a module that emitted no `tv:` (or
    // an empty one) parses '{"a":1}' perfectly and fails the moment a space
    // appears. `run()` is given NO trivia option, so the only trivia in play is
    // the one the table carried.
    const prog = encodeTable(jsonRules as never)
    expect(emitTableModule(prog, { fnSources: [] })).toContain('tv:[')
    // jsonRules' reducers call two module-level helpers, so the module they are
    // emitted into has to carry them — exactly as a build's own module does.
    const helpers = `
function unescapeJsonString(inner) {
  if (!inner.includes('\\\\')) return inner
  return inner
    .replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\').replace(/\\\\\\//g, '/')
    .replace(/\\\\b/g, '\\b').replace(/\\\\f/g, '\\f').replace(/\\\\n/g, '\\n')
    .replace(/\\\\r/g, '\\r').replace(/\\\\t/g, '\\t')
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
function objectFromPairs(pairs) {
  const obj = {}
  for (const [k, v] of pairs) obj[k] = v
  return obj
}`
    const emitted = await loadEmitted(prog, 'json', helpers)
    // No LEADING trivia: no engine skips trivia before the entry rule, so an
    // input starting with a space fails everywhere and would prove nothing.
    const spaced = '{  "a" :  [ 1 , 2 ]  ,  "b" : null  }'
    const parsed = run(emitted.Value as never, spaced)
    expect(parsed.ok).toBe(true)
    expect(parsed.value).toEqual({ a: [1, 2], b: null })
    expect(parsed.unconsumedFrom).toBe(null)
    // The grammar's own trivia is ambient, so the interpreter needs no option
    // either — both sides are being asked the same question.
    expect(jsonWs._meta.isTrivia).toBe(true)
    for (const input of [spaced, '{"a":{"b":[{"c":[[[]]]}]},"d":[]}', '{ }']) {
      expect(outcome(emitted.Value, input), input).toBe(outcome(jsonRules.Value, input))
    }
    // Rejected input compared on WHAT WAS PARSED, not on the failure report: the
    // table's failure position and expected set differ from both shipped engines
    // on ordinary JSON (pinned in table-encode-refusals.test.ts). The emitted
    // module must still reject exactly what the in-memory table rejects.
    const memory = execRules(prog)
    for (const input of ['[1,2,]', '{"a":', '@@@']) {
      expect(outcome(emitted.Value, input), input).toBe(outcome(memory.Value, input))
      expect(run(emitted.Value as never, input).ok, input).toBe(false)
      expect(run(jsonRules.Value as never, input).ok, input).toBe(false)
    }
  })

  it('CLASSIFIED trivia survives emission: root-trivia rows come back exact', async () => {
    // `lb`/`rc` were read by `expandCompact` and never written. Without them the
    // entries carry no `_meta`, and `run({ rootTrivia })` rejects a grammar that
    // plainly has labels. Asserting "it has rows" would pass on a module that
    // recorded the surrounding GAP instead of the comment; the exact offsets are
    // the only proof the right run was logged.
    const prog = encodeTable(rootTriviaNodes)
    const src = emitTableModule(prog, { fnSources: prog.fns.map(f => String(f)) })
    expect(src).toContain('lb:["space","comment"]')
    expect(src).toContain('rc:1')
    const emitted = await loadEmitted(prog, 'roottrivia')
    const input = 'aa /* keep me */ bb'
    const opts = { rootTrivia: { select: ['comment'] } } as never
    const fromEmitted = run(emitted.Doc as never, input, opts)
    expect(fromEmitted.ok).toBe(true)
    // [gapStart, gapEnd, markerStart, markerEnd, selectedKindIndex]
    expect([...fromEmitted.rootTrivia!.rows]).toEqual([2, 17, 3, 16, 0])
    expect(input.slice(3, 16)).toBe('/* keep me */')
    expect([...fromEmitted.rootTrivia!.rows])
      .toEqual([...run(rootTriviaNodes.Doc! as never, input, opts).rootTrivia!.rows])
  })

  it('token() is no longer runtime-only: it emits and round-trips', async () => {
    // It used to reach OP_CALL and park a live combinator with `balanced()`.
    // It has its own row now, so only the scanning constructs remain unemittable.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: node('Doc', token(sequence(literal('a'), many(literal('b')))), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    expect(prog.runtimeOnly).toBeUndefined()
    const emitted = await loadEmitted(prog, 'token')
    // `token` flattens its sequence to ONE string — a module that lost the row
    // would return the sequence's array instead, and still parse.
    expect((run(emitted.Doc as never, 'abb').value as { c: Array<{ value: string }> }).c[0]!.value).toBe('abb')
    for (const input of ['abb', 'a', 'zz', '']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(g.Doc, input))
    }
  })

  it('balanced() emits, and the module distinguishes ACCEPTANCE from RECOVERY', async () => {
    // WAS unemittable: `balanced()` parked a live combinator, so no grammar using
    // it could be printed. It is now `sc:` data rebuilt through `balanced()`
    // itself.
    //
    // A CONSUMPTION-ONLY PROBE PROVES NOTHING HERE. `balanced()` does not fail on
    // a crossed closure — its close is an `expect()`, so `([a)]` succeeds, spans
    // the same text a well-formed group would, AND records one error. Asserting
    // ok/value/span alone therefore passes on a lowering that dropped the
    // `expect()` entirely. The error COUNT is what separates the two, so it is
    // asserted against the interpreter on both a clean and a crossed input.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: node('Doc', balanced('(', ')'), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    expect(prog.runtimeOnly).toBeUndefined()
    expect(emitTableModule(prog, { fnSources: [] })).toContain('sc:[{kind:1')
    const emitted = await loadEmitted(prog, 'balanced')

    for (const input of ['(a(b)c)', '([a)]', '(a', '', 'zz', '(a"b)c")']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(g.Doc, input))
    }
    const errs = (rule: unknown, input: string): number =>
      (run(rule as never, input, { recover: true } as never).errors ?? []).length
    // `(a` is the RECOVERED case: ok, span to EOF, and one recorded error. It is
    // indistinguishable from acceptance by ok/value/span, and a lowering that
    // kept the `expect()` but lost its error channel reads as clean input.
    expect([errs(emitted.Doc, '(a(b)c)'), errs(emitted.Doc, '([a)]'), errs(emitted.Doc, '(a')])
      .toEqual([0, 0, 1])
    expect(run(emitted.Doc as never, '(a').ok, 'recovery is a SUCCESS, which is the point').toBe(true)
    for (const input of ['(a(b)c)', '([a)]', '(a']) {
      expect(errs(emitted.Doc, input), input).toBe(errs(g.Doc, input))
    }

    // ONE child, not seven — release/0.47.0 `#3`. A lowering that lost the
    // `token()` wrapper would still parse, still span the same text, and
    // contribute the interior's seven pieces instead.
    const kids = (run(emitted.Doc as never, '(a(b)c)').value as { c: unknown[] }).c
    expect(kids).toHaveLength(1)
    expect((kids[0] as { value: string }).value).toBe('(a(b)c)')
  })

  it('balanced({ strict }) keeps FAILING through the emitted module', async () => {
    // `strict` rides in the spec's flags. Dropped, the group would recover and
    // the choice below would take the balanced arm instead of the fallback —
    // a different tree behind a parse that still succeeds.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: node('Doc', choice(balanced('(', ')', { strict: true }), regex(/[^]*/)), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    expect(prog.scans![0]!.flags & 4, 'strict is carried').toBe(4)
    const emitted = await loadEmitted(prog, 'strict')
    for (const input of ['(a)', '(a', '((a)']) {
      expect(outcome(emitted.Doc, input), input).toBe(outcome(g.Doc, input))
    }
    // Not vacuous: the unterminated input really did fall through to the other arm.
    expect((run(emitted.Doc as never, '(a').value as { c: Array<{ value: string }> }).c[0]!.value).toBe('(a')
    expect(run(emitted.Doc as never, '(a', { recover: true } as never).errors).toEqual([])
  })

  it('scanTo() emits, keeps its skip list, its orEOF and its expected set', async () => {
    // Three separable facts, each with its own discriminating input:
    //   - the SKIP list: `{` inside the quoted run must not stop the scan;
    //   - `orEOF`: no sentinel at all is a success for Tail and a failure for Doc;
    //   - the SENTINEL's expected set: `["{"]`, which is carried as `sent` and
    //     would read `["sentinel"]` if the subtree reference lost its literal.
    const str = token(sequence(literal('"'), regex(/[^"]*/), literal('"')))
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: node('Doc', scanTo(literal('{'), { skip: [str as Combinator<unknown>] }), c => ({ t: 'Doc', c })),
      Tail: node('Tail', scanTo(literal('{'), { orEOF: true }), c => ({ t: 'Tail', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    expect(prog.runtimeOnly).toBeUndefined()
    const emitted = await loadEmitted(prog, 'scanto')
    const memory = execRules(prog)
    for (const input of ['a "b{c" d{', 'ab{', '{', '']) {
      expect(outcome(emitted.Doc, input), `Doc ${input}`).toBe(outcome(g.Doc, input))
      expect(outcome(emitted.Tail, input), `Tail ${input}`).toBe(outcome(g.Tail, input))
    }
    expect((run(emitted.Doc as never, 'a "b{c" d{').value as { c: Array<{ value: string }> }).c[0]!.value)
      .toBe('a "b{c" d')
    // A REJECTING input is compared to the in-memory table, not to the
    // interpreter: the table reports a failure at a zero-width position where the
    // interpreter reports the span it scanned. That divergence is the driver's
    // failure protocol and predates this lowering (`ctx._fe` carries a position,
    // not a span) — it is pinned in table-encode-refusals.test.ts, not smuggled
    // into a pass here. The EXPECTED SET is compared to the interpreter, because
    // that is what `sent` carries and what would read `["sentinel"]` if it were
    // lost.
    expect(outcome(emitted.Doc, 'no brace here')).toBe(outcome(memory.Doc, 'no brace here'))
    expect(run(emitted.Doc as never, 'no brace here').ok).toBe(false)
    expect(run(emitted.Doc as never, 'no brace here').expected)
      .toEqual(run(g.Doc as never, 'no brace here').expected)
    expect(run(emitted.Doc as never, 'no brace here').expected).toEqual(['"{"'])
    expect(run(emitted.Tail as never, 'no brace here').ok).toBe(true)
  })

  it('ambient scanSkip survives emission, PER RULE, and a raw scan still ignores it', async () => {
    // `ss:`/`so:`. The set is a property of the rule, not the program: `run()`
    // installs the ENTRY rule's own set. Emitting one program-wide set gave rules
    // that have none — 67 of jess's 195 css rules — a skip list the interpreter
    // never gives them.
    const str = token(sequence(literal('"'), regex(/[^"]*/), literal('"')))
    const g = rules<Record<string, Combinator<unknown>>>({ scanSkip: [str as Combinator<unknown>] }, () => ({
      Doc: node('Doc', balanced('(', ')'), c => ({ t: 'Doc', c })),
      Raw: node('Raw', balanced('(', ')', { raw: true }), c => ({ t: 'Raw', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    const src = emitTableModule(prog, { fnSources: [] })
    expect(src).toContain('ss:[[[')
    expect(src).toContain('so:[0,0]')
    const emitted = await loadEmitted(prog, 'scanskip')
    // THE DISCRIMINATING INPUT: the `)` inside the string must not close the
    // group. A module that emitted no `ss:` parses this happily and stops early —
    // ok, no error, shorter span. Both engines are asked the same question.
    const tricky = '("a)b")'
    expect((run(emitted.Doc as never, tricky).value as { c: Array<{ value: string }> }).c[0]!.value).toBe(tricky)
    expect(outcome(emitted.Doc, tricky)).toBe(outcome(g.Doc, tricky))
    // …and `raw` opts out, so it DOES stop inside the string. Same table, same
    // ambient set, opposite answer — which is what makes the pair evidence.
    expect((run(emitted.Raw as never, tricky).value as { c: Array<{ value: string }> }).c[0]!.value).toBe('("a)')
    expect(outcome(emitted.Raw, tricky)).toBe(outcome(g.Raw, tricky))
  })

  it('emitConst accepts arrays and plain objects of primitives, and still refuses everything else', () => {
    // The array refusal was never really the defect: an array of primitives
    // round-trips through JSON.stringify exactly as a string does, so it belonged
    // on the accept side by the guard's own criterion. A PLAIN OBJECT of the same
    // primitives round-trips identically, and `withCtx(extra, …)` parks one in
    // the pool — refusing it made every withCtx-bearing grammar unemittable for
    // no reason the criterion supports.
    //
    // The refusal itself is unchanged and still asserted — writing the TEXT
    // `undefined` into a module is the failure it exists to prevent — and it
    // still catches what a JSON round-trip would silently mangle: a class
    // instance loses its prototype, a function value vanishes.
    const withPool = (k: readonly unknown[]): TableProgram =>
      ({ code: [], k, fns: [], cc: [], fx: [], disp: [], dsp: [], rules: {} })
    class Rich { x = 1 }
    for (const bad of [() => 0, undefined, Symbol('x'), 1n, [[1]], [{}], [undefined],
      new Rich(), { fn: () => 0 }, { nested: { a: 1 } }, new Map()]) {
      expect(() => emitTableModule(withPool([bad])), String(bad?.toString?.() ?? bad)).toThrow(TypeError)
    }
    const ok = emitTableModule(withPool(['s\n"', 1, true, null, /a[b]c/giy, ['decl', 'x'], [], [1, true, null], {}, { inFn: true, tags: ['a'] }]))
    expect(ok).toContain('k:["s\\n\\"",1,true,null,/a[b]c/giy,["decl","x"],[],[1,true,null],{},{"inFn":true,"tags":["a"]}]')
  })
})
