/**
 * Seeded random grammars and inputs, run through every reader of the same table.
 *
 * The readers must agree on everything a parse reports. Hand-written rows pin the shapes
 * someone thought of; this finds the ones nobody did, and a row here is one bug.
 *
 * The interpreter is not a leg by default: it disagrees with the tables on about a quarter of
 * these parses (#256, #258). `TABLE_FUZZ_INTERPRETER=1` adds it, for whoever closes those.
 * Tolerant parsing is not covered yet: #274 is changing it.
 *
 * `TABLE_FUZZ_SEEDS=from-to` runs another range. A failure prints what reproduces it.
 */
import { runInThisContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as api from '../../src/index.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { hybridReaders, readers, seeded } from '../helpers/table-readers.ts'

type Rng = (n: number) => number
/** A generated term: its source, how to write something it accepts, and whether that can be nothing. */
type Term = { src: string; gen: (r: Rng) => string[]; nullable?: boolean }
type Legs = Record<string, Record<string, unknown>>
type Grammar = { body: string; triviaKind: number; rules: number; derive: Term['gen'][] }

const pick = <X>(r: Rng, xs: readonly X[]): X => xs[r(xs.length)]!
const json = JSON.stringify
const LITERALS = ['a', 'b', 'x', 'ab', 'abc', 'if', '+', '-', ',', ';', ':', '(', ')', '=', '{', '}', 'é', '→', '😀']
const REGEXES: readonly (readonly [string, readonly string[]])[] = [
  ['/[a-z]+/', ['foo', 'q', 'bar', 'abc']],
  ['/[0-9]+/', ['1', '42']],
  ['/[+*-]/', ['+', '-']],
  ['/[α-ω]+/', ['αβ', 'ω']],
]
const WHITESPACE = 'regex(/[ \\t\\n]+/)'
const CLASSIFIED = `classifiedTrivia({ whitespace: ${WHITESPACE}, comment: regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//) })`
const TRIVIA = ['', `trivia: ${WHITESPACE}`, `trivia: ${CLASSIFIED}`]
const NAMES = ['parser', 'adjacent', 'notAdjacent', 'leaf', 'sourceLeaf', 'keepSeparator', 'attempt', 'choice', 'classifiedTrivia',
  'dispatch', 'expect', 'field', 'label', 'literal', 'many', 'node', 'not', 'oneOrMore', 'optional', 'otherwise', 'peek', 'regex',
  'routed', 'rules', 'sepBy', 'sequence', 'token', 'transform', 'when', 'withCtx'] as const

function term(r: Rng, depth: number, rule: number, rules: number, nodes: { n: number }): Term {
  const literal = (): Term => { const s = pick(r, LITERALS); return { src: `literal(${json(s)})`, gen: () => [s] } }
  const regex = (): Term => { const [re, xs] = pick(r, REGEXES); return { src: `regex(${re})`, gen: g => [pick(g, xs)] } }
  const atom = (): Term => r(3) === 0 ? regex() : literal()
  if (depth <= 0) return atom()
  const sub = (): Term => term(r, depth - 1, rule, rules, nodes)
  const solid = (): Term => { for (let i = 0; i < 6; i++) { const t = sub(); if (t.nullable !== true) return t } return atom() }
  const later = (): Term | undefined => {
    if (rule + 1 >= rules) return undefined
    const name = `R${rule + 1 + r(rules - rule - 1)}`
    return { src: `g.${name}`, gen: () => [], nullable: true }
  }
  const type = (): string => json(`N${nodes.n++}`)
  const reducer = (ty: string): string => pick(r, [`c => [${ty}, c]`, `(c, f) => [${ty}, c, f]`, `(c, f, s) => [${ty}, c, f, s]`,
    `(c, f, s, x) => [${ty}, c, f, s, x]`, `(c, f, s, x, t) => [${ty}, c, f, s, x, t]`])
  const pass = (src: string, t: Term): Term => ({ src, gen: t.gen, ...(t.nullable === true ? { nullable: true } : {}) })
  const times = (t: Term, least: number): Term['gen'] => g => Array.from({ length: least + g(3) }, () => t.gen(g)).flat()
  const list = (t: Term, sep: string, least: number): Term['gen'] => g => least === 0 && g(3) === 0
    ? []
    : Array.from({ length: Math.max(least, 1) + g(2) }, () => t.gen(g)).flatMap((x, i) => i === 0 ? x : [sep, ...x])
  switch (r(40)) {
    case 0: case 1: case 2: {
      const ts = Array.from({ length: 2 + r(3) }, sub)
      return { src: `sequence(${ts.map(t => t.src).join(', ')})`, gen: g => ts.flatMap(t => t.gen(g)), ...(ts.every(t => t.nullable) ? { nullable: true } : {}) }
    }
    case 3: case 4: {
      const ts = Array.from({ length: 2 + r(3) }, sub)
      return { src: `choice(${ts.map(t => t.src).join(', ')})`, gen: g => pick(g, ts).gen(g), ...(ts.some(t => t.nullable) ? { nullable: true } : {}) }
    }
    case 5: { const t = sub(); return { src: `optional(${t.src})`, gen: g => g(2) ? t.gen(g) : [], nullable: true } }
    case 6: { const t = solid(); return { src: `many(${t.src})`, gen: times(t, 0), nullable: true } }
    case 7: { const t = solid(); return { src: `oneOrMore(${t.src})`, gen: times(t, 1) } }
    case 8: {
      const t = solid(), s = pick(r, [',', ';', '+'])
      return { src: `sepBy(${t.src}, literal(${json(s)})${pick(r, ['', ", { trailing: 'allow' }"])})`, gen: list(t, s, 0), nullable: true }
    }
    case 9: { const t = sub(); return pass(`node(${type()}, ${t.src})`, t) }
    case 10: { const t = sub(), ty = type(); return pass(`node(${ty}, ${t.src}, ${reducer(ty)})`, t) }
    case 11: case 12: {
      const c = later() ?? solid(), op = pick(r, ['+', '-', ',']), ty = type()
      const next = `sequence(literal(${json(op)}), ${c.src})`
      return {
        src: `node(${ty}, sequence(${c.src}, ${r(2) ? `optional(${next})` : `many(${next})`}), ${reducer(ty)}, { collapse: true })`,
        gen: g => { const o = c.gen(g); if (g(2)) o.push(op, ...c.gen(g)); return o },
      }
    }
    case 13: { const t = sub(); return pass(`field(${json(pick(r, ['l', 'r', 'k']))}, ${t.src})`, t) }
    case 14: { const t = atom(), n = sub(); return pass(`sequence(not(${t.src}), ${n.src})`, n) }
    case 15: {
      const t = atom()
      return pass(r(2) ? `sequence(peek(${t.src}), ${t.src})` : `attempt(${t.src})`, t)
    }
    case 16: {
      const t = sub()
      return { src: `expect(${t.src}${r(2) ? ", 'want'" : ''})`, gen: g => g(3) ? t.gen(g) : [], nullable: true }
    }
    case 17: { const t = sub(); return pass(r(2) ? `label('lbl', ${t.src})` : `transform(${t.src}, v => [v])`, t) }
    case 18: { const a = literal(), b = atom(); return { src: `token(sequence(${a.src}, ${b.src}))`, gen: g => [[...a.gen(g), ...b.gen(g)].join('')] } }
    case 19: {
      const x = sub(), y = sub(), d = sub()
      const arm = (k: string, t: Term): string => `when(${json(k)}, sequence(routed(), ${t.src}))`
      return {
        src: `dispatch(regex(/[a-z]+/), ${arm('foo', x)}, ${arm('bar', y)}, otherwise(${d.src}${pick(r, ['', ', { commit: false }'])}))`,
        gen: g => { const w = g(3); return w === 0 ? ['foo', ...x.gen(g)] : w === 1 ? ['bar', ...y.gen(g)] : d.gen(g) },
        ...(d.nullable === true ? { nullable: true } : {}),
      }
    }
    case 20: { const t = sub(); return pass(`withCtx({ k: 1 }, ${t.src})`, t) }
    case 21: {
      const t = sub()
      return pass(`parser({ ${pick(r, ['captureTrivia: true', `trivia: ${WHITESPACE}`, `trivia: ${CLASSIFIED}, rootCapture: 'opaque'`, `trivia: ${CLASSIFIED}`])} }, ${t.src})`, t)
    }
    case 22: { const t = later() ?? sub(); return { src: `token(${t.src})`, gen: g => [t.gen(g).join('')], ...(t.nullable === true ? { nullable: true } : {}) } }
    case 23: { const t = sub(); return pass(`${pick(r, ['leaf', 'sourceLeaf'])}(${t.src}, (v, s) => [v, s])`, t) }
    case 24: { const t = solid(), s = pick(r, [',', ';']); return { src: `sepBy(${t.src}, keepSeparator(literal(${json(s)})))`, gen: list(t, s, 0), nullable: true } }
    case 25: { const a = atom(), b = atom(); return { src: `sequence(${a.src}, ${pick(r, ['adjacent()', 'notAdjacent()'])}, ${b.src})`, gen: g => [...a.gen(g), ...b.gen(g)] } }
    // A list that can fail with items kept, in a choice whose next arm then builds the tree.
    case 26: {
      const t = solid(), s = pick(r, [',', ';'])
      const least = 2 + r(2), other = atom()
      return { src: `choice(sepBy(${t.src}, literal(${json(s)}), { min: ${least} }), ${other.src})`, gen: g => g(2) ? list(t, s, least)(g) : other.gen(g) }
    }
    case 27: {
      const t = solid(), other = atom(), least = 2 + r(2)
      return { src: `choice(many(${t.src}, { min: ${least} }), ${other.src})`, gen: g => g(2) ? times(t, least)(g) : other.gen(g) }
    }
    // A selector left in the frame by a dispatch that can fail uncommitted.
    case 28: {
      const x = sub(), other = regex(), ty = type()
      const arm = `when('foo', sequence(routed(), ${x.src}))`
      return {
        src: `node(${ty}, choice(dispatch(regex(/[a-z]+/), ${arm}${pick(r, ['', `, otherwise(${atom().src}, { commit: false })`])}), ${other.src}))`,
        gen: g => g(2) ? ['foo', ...x.gen(g)] : other.gen(g),
      }
    }
    case 29: {
      const t = sub()
      return pass(`field(${json(pick(r, ['l', 'r']))}, ${t.src}, { ${pick(r, ['leadingTrivia: true', 'trailingTrivia: true', 'leadingTrivia: true, trailingTrivia: true'])} })`, t)
    }
    case 30: { const t = sub(); return pass(`transform(${t.src}, (v, s) => [v, s.start, s.end])`, t) }
    // A node with no direct builder, so an 'ast' table may still serve a CST host.
    case 31: { const a = solid(), b = sub(); return { src: `node(${type()}, sequence(${a.src}, ${b.src}), { project: 0 })`, gen: g => [...a.gen(g), ...b.gen(g)] } }
    // An opener under attempt, which a declined arm reports without entering it.
    case 32: { const a = atom(), b = sub(); return { src: `sequence(attempt(${a.src}), ${b.src})`, gen: g => [...a.gen(g), ...b.gen(g)] } }
    case 33: { const t = sub(); return pass(`expect(${t.src}, 'want')`, t) }
    // A dispatch at each place that may have to take its selector back.
    case 34: {
      const x = sub()
      const selector = pick(r, ['regex(/[a-z]+/)', 'g.Word', "label('sel', regex(/[a-z]+/))", "field('s', regex(/[a-z]+/))"])
      const fallback = pick(r, ['', `, otherwise(${atom().src}, { commit: false })`, `, otherwise(${atom().src})`, `, otherwise(sequence(routed(), ${atom().src}), { commit: false })`])
      const d = `dispatch(${selector}, when('foo', sequence(routed(), ${x.src}))${fallback})`
      const word = 'regex(/[a-z]+/)', ty = type()
      const words: Term['gen'] = g => g(2) ? ['foo', ...x.gen(g)] : [pick(g, ['q', 'bar'])]
      const shapes = [
        `choice(${d}, ${word})`, `choice(label('l', ${d}), ${word})`, `choice(choice(${d}, literal('1')), ${word})`, `choice(expect(${d}), ${word})`,
        `sequence(optional(${d}), ${word})`, `sequence(expect(${d}), ${word})`, `sequence(many(${d}), ${word})`,
        `sequence(not(${d}), ${word})`, `sequence(peek(${d}), ${word})`, `sepBy(${d}, literal(','))`,
      ]
      const k = r(shapes.length + 2)
      if (k < shapes.length) return { src: `node(${ty}, ${shapes[k]!})`, gen: words, nullable: true }
      // A repetition passes on the committed failure of an item that captured before
      // it; a contained attempt makes that failure ordinary, and the next arm reads the
      // same input again (issue #303).
      const a = atom(), rep = k === shapes.length ? 'optional' : 'many'
      return {
        src: `node(${ty}, choice(attempt(${rep}(sequence(${a.src}, ${d})), { contain: true }), sequence(${a.src}, ${word})))`,
        gen: g => [...a.gen(g), 'foo'],
        nullable: true,
      }
    }
    // A choice inside whatever must restore for it.
    case 35: {
      const a = solid(), b = atom(), other = atom(), inner = `choice(sequence(${a.src}, ${b.src}), ${other.src})`, next = atom()
      return {
        src: pick(r, [`choice(${inner}, ${next.src})`, `sequence(optional(${inner}), ${next.src})`, `choice(attempt(${inner}), ${next.src})`, `sepBy(${inner}, literal(','), { min: 2 })`]),
        gen: g => g(2) ? [...a.gen(g), ...b.gen(g)] : next.gen(g),
      }
    }
    // An expect() as what a lookahead, a repeat or a choice arm reads first.
    case 36: {
      const t = solid(), n = atom()
      return { src: `sequence(${pick(r, ['peek', 'not'])}(expect(${t.src})), ${n.src})`, gen: n.gen }
    }
    case 37: {
      const t = solid(), least = r(3)
      return { src: `many(${pick(r, [`expect(${t.src}, 'want')`, `node(${type()}, expect(${t.src}))`, `attempt(expect(${t.src}))`])}, { min: ${least} })`, gen: times(t, least), nullable: true }
    }
    case 38: {
      const c = later() ?? solid(), o = atom()
      return { src: `choice(${pick(r, [`expect(${c.src})`, `node(${type()}, expect(${c.src}))`])}, ${o.src})`, gen: g => g(2) ? c.gen(g) : o.gen(g), nullable: true }
    }
    default: return later() ?? atom()
  }
}

function grammarOf(seed: number): Grammar {
  const r = seeded(seed)
  const rules = 2 + r(6)
  const nodes = { n: 0 }
  const derive: Term['gen'][] = []
  const parts: string[] = []
  for (let i = 0; i < rules; i++) {
    const t = term(r, 2 + r(3), i, rules, nodes)
    derive.push(t.gen)
    parts.push(`R${i}: ${t.src}`)
  }
  parts.push('Word: regex(/[a-z]+/)')
  return { body: parts.join(',\n  '), triviaKind: r(3), rules, derive }
}

const declared = (g: Grammar, cst: boolean, lines: boolean): string =>
  [TRIVIA[g.triviaKind], cst ? "hostMode: 'cst'" : '', lines ? 'trackLines: true' : ''].filter(Boolean).join(', ')

function interpreted(body: string, options: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const make = new Function(...NAMES, `return rules({ ${options} }, g => ({\n  ${body}\n}))`) as (...a: unknown[]) => Record<string, unknown>
  return make(...NAMES.map(n => (api as Record<string, unknown>)[n]))
}

/** The macro's output for the same source, or `undefined` where it keeps the runtime path. */
function macroLeg(body: string, options: string): Record<string, unknown> | undefined {
  const src = `import { ${NAMES.join(', ')} } from 'parseman' with { type: 'macro' }\nexport const g = rules({ ${options} }, g => ({\n  ${body}\n}))\n`
  const out = transformMacro(src, 'fuzz.ts', new Set(['parseman']))
  if (out === null || !out.code.includes('parseman/table')) return undefined
  const code = out.code
    .replace(/^[ \t]*import\b[^\n]*\n/gm, '')
    .replace(/^[ \t]*export[ \t]*\{[^}]*\}[^\n]*\n?/gm, '')
    .replace(/^[ \t]*export[ \t]+(?=(?:const|let|var|function|class|async)\b)/gm, '')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return (new Function('tableRules', `${code}\nreturn g`) as (t: typeof tableRules) => Record<string, unknown>)(tableRules)
}

function damaged(r: Rng, s: string): string {
  const at = s.length > 0 ? r(s.length + 1) : 0
  switch (r(5)) {
    case 0: return s.slice(0, at)
    case 1: return s.slice(0, at) + pick(r, LITERALS) + s.slice(at)
    case 2: return s.slice(0, at) + s.slice(at + 1)
    case 3: return s + pick(r, LITERALS)
    default: return pick(r, LITERALS) + s
  }
}

function inputsOf(g: Grammar, rule: number, r: Rng): Set<string> {
  const inputs = new Set(['', ' '])
  for (let k = 0; k < 14; k++) {
    const gap = (): string => g.triviaKind === 0 ? '' : pick(r, ['', '', ' ', '  ', '\n', ...(g.triviaKind === 2 ? ['/*c*/', ' /*c*/ '] : [])])
    const s = g.derive[rule]!(r).map(t => t + gap()).join('')
    inputs.add(k % 2 === 1 ? damaged(r, s) : s)
  }
  return inputs
}

/** A CST host that also keeps each node's trivia log, which `cstBuildHost` drops. */
const host = Object.assign((...a: Parameters<typeof cstBuildHost>) => {
  const n = cstBuildHost(...a) as unknown as Record<string, unknown>
  const log = a[5]
  if (log !== undefined && log.length > 0) n.triviaLog = [...log]
  return n
}, { _parsemanCstOutput: true })

/** Run under a clock, so a parse that never returns is a row and not a hung suite. */
function bounded<R>(f: () => R): R {
  const slot = globalThis as unknown as { tableFuzzRun?: () => R }
  slot.tableFuzzRun = f
  return runInThisContext('tableFuzzRun()', { timeout: 5000 }) as R
}

type Outcome = { threw: string } | { ok: boolean; digest: string; shown: string }
function outcome(entry: unknown, input: string, options: object): Outcome {
  try {
    const r = bounded(() => run(entry as never, input, options as never))
    const fields = {
      ok: r.ok,
      unconsumedFrom: r.unconsumedFrom,
      value: r.value,
      span: r.span,
      expected: [...(r.expected ?? [])].sort(),
      errors: r.errors,
      rootTrivia: (r.rootTrivia as { rows?: unknown } | undefined)?.rows,
    }
    return { ok: r.ok, digest: digestValue(fields), shown: json(fields) }
  } catch (e) {
    return { threw: thrown(e) }
  }
}

/** Why a parse threw, short enough to compare across readers. */
function thrown(e: unknown): string {
  const m = String((e as Error).message).split('\n')[0]!
  return /Maximum call stack/.test(m) ? 'stack' : /timed out/.test(m) ? 'timeout' : m
}

/**
 * What a caller-installed leaf sink holds after a parse, which `run()` cannot show,
 * under the leg's host and line tracking.
 */
function sunk(entry: unknown, input: string, cst: boolean, lines: boolean): string {
  const ctx = createParseContext() as unknown as { _cstLeaves?: { value: unknown; span: { start: number; end: number } }[]; build?: unknown; trackLines: boolean }
  const leaves: NonNullable<typeof ctx._cstLeaves> = []
  ctx._cstLeaves = leaves
  if (cst) ctx.build = host
  ctx.trackLines = lines
  try {
    const rule = entry as { parse?: (i: string, p: number, c: unknown) => unknown } & ((i: string, p: number, c: unknown) => unknown)
    bounded(() => typeof rule.parse === 'function' ? rule.parse(input, 0, ctx) : rule(input, 0, ctx))
  } catch (e) { return `threw ${thrown(e)}` }
  return digestValue(leaves.map(l => [l.value, l.span.start, l.span.end]))
}

const key = (o: Outcome): string => 'threw' in o ? `threw ${o.threw}` : o.digest

type Tally = {
  grammars: number; macro: number; parses: number; ok: number; failed: number; allThrew: number; hostRefused: number; timedOut: number; sinkThrew: number; rows: string[]
  /** Per `table/cst/lines` configuration: its parses, those refused for the host, and those some reader answered. */
  configs: Record<string, { parses: number; hostRefused: number; usable: number }>
}

function sweep(seed: number, tally: Tally): void {
  const g = grammarOf(seed)
  const r = seeded(seed ^ 0x5bd1e995)
  const inputs = Array.from({ length: g.rules }, (_, i) => inputsOf(g, i, r))
  for (const [cst, table, lines] of [
    [false, 'ast', false], [false, 'ast', true], [true, 'cst', false], [true, 'cst', true], [true, 'ast', false],
  ] as const) {
    const options = declared(g, table === 'cst', lines)
    const config = `${table}/${cst}/${lines}`
    const where = `seed ${seed} ${config}\n  ${options}\n  ${g.body}`
    // No grammar this generator builds is refused, so a throw here is a defect, not a skip.
    let legs: Legs
    try {
      const prog = encodeTable(interpreted(g.body, options) as never, { ...(table === 'cst' ? { hostMode: 'cst' } : {}), ...(lines ? { trackLines: true } : {}) })
      legs = { ...Object.fromEntries([...readers(prog), ...hybridReaders(prog)]), bare: tableRules(prog) } as Legs
      const m = macroLeg(g.body, options)
      if (m !== undefined) { legs.macro = m; tally.macro++ }
    } catch (e) { throw new Error(`${where}\n  building the readers threw: ${String((e as Error).message).split('\n')[0]}`) }
    const seen = tally.configs[config] ??= { parses: 0, hostRefused: 0, usable: 0 }
    if (process.env.TABLE_FUZZ_INTERPRETER === '1') legs.interpreter = interpreted(g.body, options) as Record<string, unknown>
    tally.grammars++
    const names = Object.keys(legs)
    const rootTrivia = g.triviaKind === 2 && seed % 2 === 0 ? { rootTrivia: { select: ['comment'] } } : {}
    const opts = { ...(cst ? { build: host } : {}), ...rootTrivia }
    for (let i = 0; i < g.rules; i++) {
      for (const input of inputs[i]!) {
        const res = names.map(n => outcome(legs[n]![`R${i}`], input, opts))
        const sinks = names.map(n => sunk(legs[n]![`R${i}`], input, cst, lines))
        tally.parses++
        seen.parses++
        if (res.some(o => 'threw' in o && o.threw === 'timeout') || sinks.includes('threw timeout')) { tally.timedOut++; continue }
        const first = res[0]!
        if (res.every(o => 'threw' in o)) {
          // An `ast` table refuses a CST host; that refusal is expected, and counted apart.
          if (key(first).includes('compiled for host mode')) { tally.hostRefused++; seen.hostRefused++ }
          else tally.allThrew++
        } else {
          seen.usable++
          // A parse some reader answers must leave a sink to compare, not one shared throw.
          if (sinks.every(x => x.startsWith('threw '))) tally.sinkThrew++
          if ('ok' in first && first.ok) tally.ok++
          else tally.failed++
        }
        if (new Set(res.map(key)).size > 1 || new Set(sinks).size > 1) {
          tally.rows.push(`seed ${seed} R${i} table=${table} cst=${cst} lines=${lines} input=${json(input)}\n  ${options}\n  ${g.body}\n`
            + names.map((n, j) => `  ${n}: ${'threw' in res[j]! ? key(res[j]!) : (res[j] as { shown: string }).shown}${sinks[j] === undefined ? '' : ` sink ${sinks[j]}`}`).join('\n'))
        }
      }
    }
  }
}

const range = /^(\d+)-(\d+)$/.exec(process.env.TABLE_FUZZ_SEEDS ?? '1-61')!
const from = Number(range[1]), to = Number(range[2])

describe('every reader of a table gives one answer', () => {
  it(`on the grammars and inputs of seeds ${from} to ${to}`, () => {
    const tally: Tally = { grammars: 0, macro: 0, parses: 0, ok: 0, failed: 0, allThrew: 0, hostRefused: 0, timedOut: 0, sinkThrew: 0, rows: [], configs: {} }
    for (let seed = from; seed < to; seed++) sweep(seed, tally)
    const { rows, ...counts } = tally
    console.log(`table fuzz: ${json(counts)}`)
    expect(rows.slice(0, 5).join('\n\n'), `${rows.length} rows differ`).toBe('')
    // A sweep that compared almost nothing has not passed.
    const seeds = to - from
    expect(tally.grammars).toBeGreaterThan(seeds)
    expect(tally.macro).toBeGreaterThan(seeds / 2)
    expect(tally.ok).toBeGreaterThan(tally.parses / 20)
    expect(tally.failed).toBeGreaterThan(tally.parses / 20)
    expect(tally.allThrew).toBeLessThan(tally.parses / 10)
    expect(tally.timedOut).toBe(0)
    expect(tally.sinkThrew).toBe(0)
    // Every configuration compared something, not only the sweep as a whole. A grammar
    // with a direct builder rightly refuses a CST host on an ast table, so the floor is
    // over the parses a configuration could answer: a narrowed seed range may have none.
    expect(Object.keys(tally.configs)).toHaveLength(5)
    for (const [config, c] of Object.entries(tally.configs)) {
      const answerable = c.parses - c.hostRefused
      if (answerable > 0) expect(c.usable, config).toBeGreaterThan(answerable / 10)
    }
  }, 600_000)
})
