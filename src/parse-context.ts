import type { ParseContext } from './types.ts'

/**
 * THE canonical `ParseContext` literal — the only place in the runtime where one
 * is constructed from scratch.
 *
 * `ctx` is threaded through every combinator call, so it is the single most
 * megamorphism-sensitive object in the system: every `ctx.<field>` load in
 * `choice`/`sequence`/`regex`/`node`/… is an inline cache keyed on its hidden
 * class. Historically the entry points built `ctx` with CONDITIONAL SPREADS
 * (`...(cond ? { x } : {})`), which is a shape hazard, not a cost-free idiom:
 *
 *   - `run()` had SIX of them (root trivia, grammar trivia, scan-skip, capture
 *     mask, tolerant, instrumentation) — up to 2^6 distinct hidden classes for
 *     `ctx` across configurations, all landing on the same ICs.
 *   - Fields that appear only inside a spread are ABSENT from the map on the
 *     paths that don't take the branch. That is why `ctx._triviaLog = undefined`
 *     is not free there: it is a property ADD (a map transition), not a store.
 *     And it is why `delete ctx._triviaLog` is expensive on the paths where the
 *     field IS present: a transition to dictionary mode.
 *
 * Declaring every field unconditionally — `undefined` when unset — collapses
 * that to ONE realised map. Clearing a field is then a plain in-object store to
 * an existing slot on every path, so `delete` is never needed and neither
 * operation can transition the map.
 *
 * This is safe because absence and `undefined` are already interchangeable
 * throughout the runtime: every reader tests `!== undefined` or truthiness, and
 * none uses `in`, `hasOwnProperty`, or `Object.keys` on a `ParseContext`.
 * `recovery/scan.ts` already restores these exact fields by assigning the saved
 * value, which is `undefined` when the field was absent.
 *
 * Callers assign what they need AFTER construction; because every slot already
 * exists those are in-object stores, and the shape is preserved. Do NOT
 * reintroduce a conditional spread, and do NOT add a field here without also
 * declaring it on `ParseContext`.
 *
 * Key ORDER matters as much as the key set — two literals with the same keys in
 * a different order are two different maps — which is why there is one literal
 * and not one per call site. It follows the declaration order of `ParseContext`.
 */
export function createParseContext(): ParseContext {
  return {
    trivia: undefined,
    scanSkip: undefined,
    triviaKindLabels: undefined,
    captureTrivia: undefined,
    _triviaCaptureMask: undefined,
    trackLines: false,
    state: undefined,
    build: undefined,
    _errors: undefined,
    _tolerant: undefined,
    _sync: undefined,
    _rec: undefined,
    _fe: undefined,
    _fx: undefined,
    _fc: undefined,
    _sv: undefined,
    _probe: undefined,
    _cstChildren: undefined,
    _cstLeaves: undefined,
    _cstRawChildren: undefined,
    _triviaLog: undefined,
    _rootTriviaLog: undefined,
    _rootTriviaKindIndex: undefined,
    _rootTriviaStrictScopes: undefined,
    _rootTriviaCapture: undefined,
    _cstTriviaLog: undefined,
    _fields: undefined,
    _cstBuf: undefined,
    _routed: undefined,
    _lineStarts: undefined,
    _lineIndex: undefined,
    _lineScannedTo: undefined,
    _grammarCoverage: undefined,
    _grammarTrace: undefined,
  }
}

/**
 * A `ctx` for a THROWAWAY sub-parse that must not inherit or pollute any sink —
 * the trailing-trivia probe in `run()`/`doc()`, the trivia-kind classifier, and
 * the no-capture trivia parses in `trivia-skip`. Identical shape to
 * `createParseContext()`; only `trackLines`/`state` are seeded.
 */
export function createDetachedParseContext(trackLines: boolean, state: unknown): ParseContext {
  const ctx = createParseContext()
  ctx.trackLines = trackLines
  ctx.state = state
  return ctx
}
