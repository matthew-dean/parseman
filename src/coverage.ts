import { run, type RunOptions, type RunResult, type Runnable } from './functional/run.ts'
import type { Combinator, DispatchCase, DispatchMatcherCase, ParseContext, ParseResult } from './types.ts'
import { choice } from './combinators/choice.ts'
import { dispatch, endsWith, matches, otherwise, startsWith, when, type DispatchArm, type DispatchStringMatcher } from './combinators/dispatch.ts'
import { attempt } from './combinators/attempt.ts'
import { getCoreLiteralValue } from './combinators/choice.ts'
import { not } from './combinators/not.ts'
import { peek } from './combinators/peek.ts'
import { node } from './combinators/node.ts'
import { parser as grammarParser } from './combinators/grammar.ts'
import { expect } from './combinators/expect.ts'
import { gate } from './combinators/gate.ts'
import { label, field, skip, transform, trivia } from './combinators/map.ts'
import { many, oneOrMore, optional, sepBy } from './combinators/repeat.ts'
import { scanTo } from './combinators/scanTo.ts'
import { sequence } from './combinators/sequence.ts'
import { token } from './combinators/token.ts'
import { leaf } from './combinators/token.ts'
import { withCtx } from './combinators/withCtx.ts'
import { composedCoverageRules } from './compiler/linker.ts'
import { buildGrammarPlan, type GrammarCoverageDefinition, type GrammarCoveragePlan } from './compiler/grammar-coverage-ids.ts'

export type { GrammarCoverageDefinition } from './compiler/grammar-coverage-ids.ts'

function dispatchMatcher(entry: DispatchMatcherCase): DispatchStringMatcher {
  switch (entry.kind) {
    case 'startsWith':
      return startsWith(entry.value)
    case 'endsWith':
      return endsWith(entry.value)
    case 'matches':
      return matches(new RegExp(entry.value, entry.flags))
  }
}


export type GrammarCoverageSnapshot = {
  definitions: readonly GrammarCoverageDefinition[]
  hits: readonly string[]
  unhit: readonly string[]
  /**
   * Hit fraction, or `NaN` when there was NOTHING TO MEASURE.
   *
   * An empty definition set is not full coverage. This used to report `1` for it, so a
   * grammar whose definitions failed to load — the exact case
   * `'coverage-definitions-unavailable'` exists for — presented as 100% covered, and any
   * consumer gate of the shape `ratio >= threshold` passed on zero evidence. `NaN`
   * compares false against every threshold, so the gate now FAILS CLOSED by default
   * instead of passing by default. Read `measurable` to tell "nothing to measure" from a
   * genuine 0%.
   */
  ratio: number
  /** False when the definition set was empty, i.e. `ratio` is not a measurement. */
  measurable: boolean
}

export type GrammarCoverageCollector = {
  hit(id: string): void
  snapshot(): GrammarCoverageSnapshot
  reset(): void
}

/** Metadata emitted only by a coverage-enabled macro grammar. It is attached to
 * the grammar map, rather than each rule function, so a caller chooses the
 * explicit public start rule before collecting results. */
export const GRAMMAR_COVERAGE_DEFINITIONS: symbol = Symbol.for('parseman.grammarCoverageDefinitions')

export function compiledGrammarCoverageDefinitions(grammar: Record<string, unknown>): readonly GrammarCoverageDefinition[] {
  const definitions = (grammar as Record<symbol, unknown>)[GRAMMAR_COVERAGE_DEFINITIONS]
  // `definitions.length === 0` is checked EXPLICITLY. `[].every(...)` is vacuously true,
  // so an empty array sailed through this guard and was returned as a valid definition
  // set — the one input whose name the error message spells out was the one input it let
  // past, and it went on to report 100% coverage downstream.
  if (!Array.isArray(definitions)
    || definitions.length === 0
    || !definitions.every((definition): definition is GrammarCoverageDefinition => typeof definition === 'object'
      && definition !== null
      && typeof definition.id === 'string'
      && (definition.kind === 'rule' || definition.kind === 'choice-arm' || definition.kind === 'dispatch-arm' || definition.kind === 'label'))) {
    throw new TypeError('grammar has no coverage definitions; enable grammarCoverage for this macro build')
  }
  return definitions
}

export type GrammarTracePhase = 'enter' | 'attempt' | 'selected' | 'success' | 'failure' | 'backtrack' | 'rollback'
export type GrammarTraceEvent = { id: string; phase: GrammarTracePhase; offset: number; end?: number }
export type GrammarTraceSnapshot = { events: readonly GrammarTraceEvent[]; truncated: boolean; dropped: number }
export type GrammarTraceSink = { write(event: GrammarTraceEvent): void; snapshot(): GrammarTraceSnapshot }
/** Typed context for a coverage-enabled compiled or macro-generated parser. */
export type GrammarInstrumentationContext = ParseContext & {
  _grammarCoverage?: (id: string) => void
  _grammarTrace?: GrammarTraceSink
}

/** Create the opt-in context consumed by coverage-enabled compiled output. */
export function createGrammarInstrumentationContext(options: {
  collector?: GrammarCoverageCollector
  trace?: GrammarTraceSink
  trackLines?: boolean
  state?: unknown
} = {}): GrammarInstrumentationContext {
  return {
    trackLines: options.trackLines ?? false,
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.collector === undefined ? {} : { _grammarCoverage: (id: string) => options.collector!.hit(id) }),
    ...(options.trace === undefined ? {} : { _grammarTrace: options.trace }),
  }
}

/** Bounded first-N trace sink. Exceptions and a false callback detach without
 * changing parser results; post-detach events count as dropped. */
export function createGrammarTraceSink(options: { capacity: number; write?: (event: GrammarTraceEvent) => boolean | void }): GrammarTraceSink {
  if (!Number.isInteger(options.capacity) || options.capacity < 0) throw new TypeError('trace capacity must be a finite non-negative integer')
  const events: GrammarTraceEvent[] = []
  let detached = false
  let truncated = false
  let dropped = 0
  return {
    write(event) {
      if (detached || events.length >= options.capacity) {
        detached = true; truncated = true; dropped++; return
      }
      events.push(Object.freeze({ ...event }))
      try {
        if (options.write?.(event) === false) { detached = true; truncated = true }
      } catch { detached = true; truncated = true }
    },
    snapshot() { return Object.freeze({ events: Object.freeze([...events]), truncated, dropped }) },
  }
}

export function createGrammarCoverageCollector(definitions: readonly GrammarCoverageDefinition[]): GrammarCoverageCollector {
  const ordered = [...definitions].sort((a, b) => a.id.localeCompare(b.id))
  const known = new Set(ordered.map(definition => definition.id))
  const hits = new Set<string>()
  return {
    hit(id) { if (known.has(id)) hits.add(id) },
    snapshot() {
      const hitList = [...hits].sort()
      const unhit = ordered.map(definition => definition.id).filter(id => !hits.has(id))
      // No `ordered.length === 0 ? 1` default. 0/0 is NaN, which is the honest answer and
      // fails every `>=` threshold; reporting 1 asserted total coverage of nothing.
      return {
        definitions: ordered,
        hits: hitList,
        unhit,
        ratio: hitList.length / ordered.length,
        measurable: ordered.length > 0,
      }
    },
    reset() { hits.clear() },
  }
}

export function grammarCoverageDefinitions(entry: Combinator<unknown>, winners?: Record<string, Combinator<unknown>>): readonly GrammarCoverageDefinition[] {
  return buildGrammarPlan(entry, winners).definitions
}

/** Definitions for a runtime `compose()` result, normalized through its final
 * IR winner map. Opaque precompiled pieces intentionally fail rather than
 * reporting source-piece identities as though they were final grammar IDs. */
export function composedGrammarCoverageDefinitions(grammar: Record<string, unknown>, startRule: string): readonly GrammarCoverageDefinition[] {
  const winners = composedCoverageRules(grammar)
  if (!winners) throw new TypeError('semantic coverage needs re-lowerable composed IR; this composition contains an opaque artifact')
  const entry = winners[startRule]
  if (!entry) throw new TypeError(`semantic coverage start rule ${JSON.stringify(startRule)} is not a final winner`)
  return grammarCoverageDefinitions(entry, winners)
}

type CoverageMaps = Pick<GrammarCoveragePlan, 'choices' | 'dispatches' | 'attempts' | 'labels' | 'rules'>

/**
 * Build a separate interpreter graph for the coverage run. It never mutates the
 * source grammar and ordinary Parseman combinators never branch on coverage.
 *
 * Every structural ParserDef is rebuilt from coverage-aware children. Terminal
 * recognizers are safely shared because they contain no child execution.
 */
function coverageEntry(entry: Combinator<unknown>, collector: GrammarCoverageCollector, maps: CoverageMaps, trace?: GrammarTraceSink): Combinator<unknown> {
  const cache = new WeakMap<Combinator<unknown>, Combinator<unknown>>()
  const build = (parser: Combinator<unknown>): Combinator<unknown> => {
    const existing = cache.get(parser)
    if (existing) return existing
    const rule = maps.rules.get(parser)
    const wrap = (parse: (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>): Combinator<unknown> => {
      const wrapped: Combinator<unknown> = {
        _tag: parser._tag,
        _meta: parser._meta,
        _def: parser._def,
        parse(input, pos, ctx) {
          if (rule) { collector.hit(rule); trace?.write({ id: rule, phase: 'enter', offset: pos }) }
          const result = parse(input, pos, ctx)
          if (rule) trace?.write(result.ok ? { id: rule, phase: 'success', offset: pos, end: result.span.end } : { id: rule, phase: 'failure', offset: result.span.end })
          return result
        },
      }
      cache.set(parser, wrapped)
      return wrapped
    }
    const def = parser._def
    if (def.tag === 'lazy') {
      return wrap((input, pos, ctx) => build(def.thunk()).parse(input, pos, ctx))
    }
    if (def.tag === 'label') {
      const base = label(def.label, build(def.parser))
      return wrap((input, pos, ctx) => {
        const result = base.parse(input, pos, ctx)
        if (result.ok) for (const id of maps.labels.get(parser) ?? []) { collector.hit(id); trace?.write({ id, phase: 'success', offset: pos, end: result.span.end }) }
        return result
      })
    }
    if (def.tag === 'choice') {
      const ids = maps.choices.get(parser) ?? []
      type ChoiceState = { lastSuccessfulArm: number | undefined; successfulArms: number[] }
      const invocations: ChoiceState[] = []
      const arms = def.parsers.map((arm, index) => {
        const child = build(arm)
        return {
          _tag: child._tag,
          _meta: child._meta,
          _def: child._def,
          parse(input: string, pos: number, ctx: ParseContext) {
            const id = ids[index]
            if (id) trace?.write({ id, phase: 'attempt', offset: pos })
            const result = child.parse(input, pos, ctx)
            if (result.ok) {
              // Greedy classification runs its super arm as an implementation
              // detail, then chooses the final semantic arm below. Only that
              // final arm belongs in coverage.
              if (def.strategy.tag !== 'greedyClassify') collector.hit(ids[index]!)
              const invocation = invocations[invocations.length - 1]
              if (invocation) { invocation.lastSuccessfulArm = index; invocation.successfulArms.push(index) }
            }
            else if (id) { trace?.write({ id, phase: 'failure', offset: result.span.end }); trace?.write({ id, phase: 'backtrack', offset: pos }) }
            return result
          },
        } satisfies Combinator<unknown>
      })
      const args = arms.map((arm, index) => def.gates[index] ? { combinator: arm, gate: def.gates[index]! } : arm)
      const unsafeChoice = choice as unknown as (...items: unknown[]) => Combinator<unknown>
      const baseChoice = unsafeChoice(...args)
      return wrap((input, pos, ctx) => {
        const invocation: ChoiceState = { lastSuccessfulArm: undefined, successfulArms: [] }
        invocations.push(invocation)
        const result = baseChoice.parse(input, pos, ctx)
        const strategy = def.strategy
        if (result.ok && strategy.tag === 'greedyClassify') {
          const text = input.slice(pos, result.span.end)
          const classified = def.parsers.findIndex((arm, index) => index !== strategy.superIndex && getCoreLiteralValue(arm) === text)
          if (classified !== -1) invocation.lastSuccessfulArm = classified
          else invocation.lastSuccessfulArm = strategy.superIndex
        }
        if (result.ok && invocation.lastSuccessfulArm !== undefined) {
          const id = ids[invocation.lastSuccessfulArm]
          for (const rejected of invocation.successfulArms) {
            if (rejected !== invocation.lastSuccessfulArm) {
              const rejectedId = ids[rejected]
              if (rejectedId) { trace?.write({ id: rejectedId, phase: 'failure', offset: pos }); trace?.write({ id: rejectedId, phase: 'backtrack', offset: pos }) }
            }
          }
          if (id) {
            collector.hit(id)
            trace?.write({ id, phase: 'selected', offset: pos, end: result.span.end })
            trace?.write({ id, phase: 'success', offset: pos, end: result.span.end })
          }
        }
        invocations.pop()
        return result
      })
    }
    const base: Combinator<unknown> = (() => {
      switch (def.tag) {
        case 'sequence': {
          const unsafeSequence = sequence as unknown as (...items: Combinator<unknown>[]) => Combinator<unknown>
          return unsafeSequence(...def.parsers.map(build))
        }
        case 'dispatch': {
          const ids = maps.dispatches.get(parser) ?? []
          let armIndex = 0
          const dispatchStarts: number[] = []
          const wrapArm = (arm: Combinator<unknown>, id: string | undefined): Combinator<unknown> => {
            const child = build(arm)
            return {
              _tag: child._tag,
              _meta: child._meta,
              _def: child._def,
              parse(input: string, pos: number, ctx: ParseContext) {
                const dispatchStart = dispatchStarts[dispatchStarts.length - 1] ?? pos
                if (id) trace?.write({ id, phase: 'attempt', offset: dispatchStart })
                const result = child.parse(input, pos, ctx)
                if (result.ok) {
                  if (id) {
                    collector.hit(id)
                    trace?.write({ id, phase: 'selected', offset: dispatchStart, end: result.span.end })
                    trace?.write({ id, phase: 'success', offset: dispatchStart, end: result.span.end })
                  }
                } else if (id) {
                  trace?.write({ id, phase: 'failure', offset: result.span.end })
                }
                return result
              },
            } satisfies Combinator<unknown>
          }
          const arms: DispatchArm<unknown>[] = def.cases.map((entry: DispatchCase) =>
            when(entry.keys, wrapArm(entry.parser, ids[armIndex++]), entry.caseInsensitive ? { caseInsensitive: true } : undefined)
          )
          if (def.matchers) {
            for (const entry of def.matchers) {
              arms.push(when(dispatchMatcher(entry), wrapArm(entry.parser, ids[armIndex++]), entry.caseInsensitive ? { caseInsensitive: true } : undefined))
            }
          }
          if (def.otherwise) arms.push(otherwise(wrapArm(def.otherwise, ids[armIndex++])))
          const unsafeDispatch = dispatch as (selector: Combinator<string>, ...items: DispatchArm<unknown>[]) => Combinator<unknown>
          const base = unsafeDispatch(build(def.selector) as Combinator<string>, ...arms)
          return {
            ...base,
            parse(input, pos, ctx) {
              dispatchStarts.push(pos)
              try {
                return base.parse(input, pos, ctx)
              } finally {
                dispatchStarts.pop()
              }
            },
          }
        }
        case 'many': return many(build(def.parser))
        case 'oneOrMore': return oneOrMore(build(def.parser))
        case 'optional': return optional(build(def.parser))
        case 'attempt': {
          const base = attempt(build(def.parser))
          const id = maps.attempts.get(parser)
          return id === undefined ? base : {
            ...base,
            parse(input, pos, ctx) {
              const result = base.parse(input, pos, ctx)
              if (!result.ok) trace?.write({ id, phase: 'rollback', offset: pos })
              return result
            },
          }
        }
        case 'sepBy': return sepBy(build(def.parser), build(def.separator), { min: def.min, ...(def.max === undefined ? {} : { max: def.max }), ...(def.trailing === undefined ? {} : { trailing: def.trailing }) })
        case 'transform': return transform(build(def.parser), def.fn)
        case 'skip': return skip(build(def.main), build(def.skipped))
        case 'trivia': return trivia(build(def.parser))
        case 'token': return token(build(def.parser))
        case 'leaf': return leaf(build(def.parser), def.fn)
        case 'field': return field(def.name, build(def.parser))
        case 'grammar': return grammarParser({
          ...(def.triviaParser === undefined ? (def.clearTrivia ? { trivia: null } : {}) : { trivia: build(def.triviaParser) }),
          ...(def.captureTrivia ? { captureTrivia: true } : {}),
          ...(def.trackLines ? { trackLines: true } : {}),
        }, build(def.parser))
        case 'not': return not(build(def.parser))
        case 'peek': return peek(build(def.parser))
        case 'node': {
          const opts = { ...(def.unwrap ? { unwrap: true } : {}), ...(def.collapse ? { collapse: true } : {}), ...(def.project !== undefined ? { project: def.project } : {}), ...(def.captureTrivia ? { captureTrivia: true } : {}), ...(def.trailingTrivia ? { trailingTrivia: true } : {}) }
          return def.type === undefined ? node(build(def.parser), def.build, opts) : node(def.type, build(def.parser), def.build, opts)
        }
        case 'guard': return gate(def.predicate)
        case 'withCtx': return withCtx(def.extra, build(def.parser))
        case 'expect': return expect(build(def.parser), def.label)
        case 'scanTo': return scanTo(build(def.sentinel), { skip: def.skip.map(build), orEOF: def.orEOF })
        case 'literal': case 'regex': case 'keywords': return parser
        case 'recover': case 'unknown': throw new TypeError(`runWithGrammarCoverage does not yet support ${def.tag}`)
        default: return parser
      }
    })()
    return wrap((input, pos, ctx) => base.parse(input, pos, ctx))
  }
  return build(entry)
}

export function runWithGrammarCoverage(entry: Runnable, input: string, options: RunOptions & { collector?: GrammarCoverageCollector; trace?: GrammarTraceSink } = {}): { result: RunResult; coverage: GrammarCoverageSnapshot } {
  if (typeof entry === 'function') throw new TypeError('runWithGrammarCoverage currently requires an interpreter combinator entry')
  const plan = buildGrammarPlan(entry)
  const definitions = plan.definitions
  const collector = options.collector ?? createGrammarCoverageCollector(definitions)
  const { collector: _collector, trace, ...runOptions } = options
  return { result: run(coverageEntry(entry, collector, plan, trace), input, runOptions), coverage: collector.snapshot() }
}
