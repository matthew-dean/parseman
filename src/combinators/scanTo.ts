import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { literal } from './literal.ts'
import { regex } from './regex.ts'
import { sequence } from './sequence.ts'
import { choice } from './choice.ts'
import { many } from './repeat.ts'
import { transform } from './map.ts'
import { expect } from './expect.ts'
import { createDetachedParseContext } from '../parse-context.ts'
import { any } from './first-set.ts'
import { ref } from './ref.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'
import { token } from './token.ts'
import { recordLineRangeFromContext } from '../line-index.ts'

export type ScanToOptions = {
  /**
   * Per-call opaque-unit skippers (balanced parens/brackets, dialect
   * interpolation, …). These EXTEND the grammar-level ambient default: ambient
   * trivia (comments/ws) and ambient `scanSkip` (strings) are applied too, unless
   * `raw`. So a site only needs to list the extra units its scan requires.
   */
  skip?: Combinator<unknown>[]
  /**
   * Hard opt-out: skip NOTHING ambiently — no trivia, no scanSkip, and (with no
   * per-call `skip`) a pure raw byte-walk. For the rare site that intends to scan
   * literally through comments/strings.
   */
  raw?: boolean
  /**
   * If true, reaching EOF without finding the sentinel is a success — returns
   * everything consumed so far. Default false (fail at EOF).
   */
  orEOF?: boolean
  /**
   * `balanced()` only. Make an unmatched close a genuine FAILURE instead of a
   * recovered one.
   *
   * By default `balanced()` wraps its close in `expect()`, which never fails: on
   * a miss it returns a ParseError, records it on `ctx._errors`, and reports a
   * zero-width span. So the combinator is UNFAILABLE once its opener is consumed
   * — the rejection is computed and recorded, but a caller cannot branch on it.
   * `choice()` cannot fall through to another arm, `not()` cannot negate it, and
   * a `sequence()` around it proceeds as if the group closed.
   *
   * With `strict: true` the close is required, so an unmatched or missing close
   * fails the whole group and rolls back to the opener — the ordinary combinator
   * contract. Nested groups inherit strictness (the interior recurses into the
   * same combinator).
   *
   * Opt-in: the default is unchanged, because recovery is what a tolerant
   * document parse wants, and existing grammars are built on it.
   */
  strict?: boolean
}

/**
 * Resolve the effective ordered skipper list for a scan, folding grammar-level
 * ambient trivia + scanSkip in FRONT of the per-call `skip` (explicit skip
 * EXTENDS the ambient default). Shared by the interpreter `scanTo`/`balanced`;
 * the compiled path bakes the identical list in codegen.
 *
 *   raw   → []                                  (no trivia, no scanSkip, no skip)
 *   else  → [ ...trivia?, ...scanSkip?, ...skip ]
 *
 * The ambient trivia (comments/ws) leads so a sentinel hidden in a comment is
 * never matched, then ambient strings, then the site's extra units. The sentinel
 * itself is still checked before any skipper, so a sentinel that also starts a
 * skip region wins (unchanged priority).
 */
export function resolveScanSkip(
  explicitSkip: Combinator<unknown>[],
  raw: boolean,
  ctx: ParseContext,
): Combinator<unknown>[] {
  if (raw) return []
  const trivia = ctx.trivia
  const ambient = ctx.scanSkip
  if (!trivia && !ambient) return explicitSkip
  const out: Combinator<unknown>[] = []
  if (trivia) out.push(trivia)
  if (ambient) out.push(...ambient)
  out.push(...explicitSkip)
  return out
}

/**
 * Consume input up to (but not including) the sentinel, skipping over any
 * "hole" patterns in order so their contents are never mistaken for the sentinel.
 *
 * Returns the consumed text as a string. The sentinel is NOT consumed.
 * Fails if the sentinel is never found (unless orEOF is true).
 *
 *   const selector = scanTo(literal('{'), {
 *     skip: [cssComment, stringLit, balanced('(', ')'), balanced('[', ']')],
 *   })
 */
export function scanTo(
  sentinel: Combinator<unknown>,
  { skip, raw = false, orEOF = false }: ScanToOptions = {},
): Combinator<string> {
  const meta: ParserMeta = {
    firstSet: any(),
    canMatchNewline: true,
    isTrivia: false,
  }
  const explicitSkip = skip ?? []

  return {
    _tag: 'scanTo',
    _meta: meta,
    _def: { tag: 'scanTo', sentinel, skip: explicitSkip, raw, orEOF },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      let cur = pos
      // Fold grammar-level ambient trivia + scanSkip into the effective skippers.
      const skip = resolveScanSkip(explicitSkip, raw, ctx)

      // Sentinel checks and skip scans must not emit CST children of their own —
      // scanTo represents the whole scanned span as one leaf. Probe them with a
      // collector-free context so their internal literal()/regex() don't push.
      // The error channel IS forwarded, so a committed skipper (e.g. balanced()
      // whose open delimiter was consumed) can still report an unmatched close.
      const probeCtx = createDetachedParseContext(false, ctx.state)
      probeCtx._errors = ctx._errors

      // Record the scanned text as a CSTLeaf so buildNode-driven grammars can
      // see it in children/rawChildren (it would otherwise be lost — only the
      // returned value carries it). Skipped when no collector is active.
      const emit = (end: number) => {
        if (end > pos && cstCaptureActive(ctx)) {
          const leaf = { _tag: 'leaf', value: input.slice(pos, end), span: { start: pos, end } }
          pushCstLeaf(ctx, leaf)
        }
      }

      while (cur < input.length) {
        // Check sentinel — if it matches here, stop and return consumed text.
        const s = sentinel.parse(input, cur, probeCtx)
        if (s.ok) {
          if (ctx.trackLines) recordLineRangeFromContext(ctx, input, pos, cur)
          emit(cur)
          return { ok: true, value: input.slice(pos, cur), span: { start: pos, end: cur } }
        }

        // Try each skipper in order; take first that advances.
        let advanced = false
        for (const skipper of skip) {
          const r = skipper.parse(input, cur, probeCtx)
          if (r.ok && r.span.end > cur) {
            cur = r.span.end
            advanced = true
            break
          }
        }

        // Nothing matched — consume one character and continue.
        if (!advanced) cur++
      }

      // Reached EOF without finding sentinel.
      if (orEOF) {
        if (ctx.trackLines) recordLineRangeFromContext(ctx, input, pos, cur)
        emit(cur)
        return { ok: true, value: input.slice(pos, cur), span: { start: pos, end: cur } }
      }
      const sentDef = sentinel._def
      const expected = sentDef.tag === 'literal' ? [JSON.stringify(sentDef.value)] : ['sentinel']
      return { ok: false, expected, span: { start: pos, end: cur } }
    },
  }
}

/** Codegen marker: a balanced combinator that must re-resolve ambient scanSkip
 * into its interior at emit time (the compiled mirror of the interpreter wrapper). */
export type BalancedAmbient = Combinator<string> & {
  _balancedAmbient?: { open: string; close: string; ownSkip: Combinator<unknown>[]; strict?: boolean }
}

/**
 * Marker: this combinator IS a balanced interior — its delimiters, and the fact
 * that everything between them is a scan rather than authored structure.
 *
 * Set by `buildBalancedInterior`, so EVERY balanced carries it: the ambient one,
 * the `raw` one, and each interior the ambient cache rebuilds. `_balancedAmbient`
 * cannot serve this purpose — it is absent on `raw`, and it means "re-resolve
 * ambient scanSkip", which is a different claim.
 *
 * Read by the spec/railroad emitter, which renders a balanced as its delimiters
 * around an opaque interior. That is not a simplification: the delimiters are
 * FIXED at construction and the interior genuinely is a delimiter scan, so the
 * rendering states exactly what the construct is. Expanding the lowered shape
 * instead would print the content-run regex and the `self` back-edge, which are
 * emitter machinery, not language.
 */
export type BalancedMarked = Combinator<string> & {
  _balanced?: { open: string; close: string }
}

/**
 * The table lowering's marker, on the object `balanced()` RETURNS.
 *
 * Deliberately not `_balancedAmbient`, and deliberately on the OUTER combinator.
 * `_balancedAmbient` means "rebuild my interior with the ambient scanSkip", which
 * is false for `raw`, and it sits on the INNER combinator because that is the one
 * codegen's dedup and the interior `self` back-edge address. Reading `_def` (or
 * the ambient marker) off the outer object gets the wrong thing — a structural
 * encoder made exactly that mistake and lowered the wrong parser, silently.
 *
 * This marker instead records the CONSTRUCTOR ARGUMENTS, so an encoder can carry
 * a `balanced()` as data and let `balanced()` itself rebuild it. It is present on
 * every `balanced()`, `raw` included.
 */
export type BalancedSpec = Combinator<string> & {
  _balancedSpec?: {
    open: string
    close: string
    ownSkip: Combinator<unknown>[]
    strict: boolean
    raw: boolean
  }
}

function markSpec(
  outer: Combinator<string>,
  open: string, close: string, ownSkip: Combinator<unknown>[], strict: boolean, raw: boolean,
): Combinator<string> {
  ;(outer as BalancedSpec)._balancedSpec = { open, close, ownSkip, strict, raw }
  return outer
}

/**
 * Match a balanced open/close pair, skipping over any holes inside.
 * Returns the full matched text including delimiters.
 *
 *   const parenGroup = balanced('(', ')', { skip: [comment, stringLit] })
 *
 * With no per-call `skip`, a balanced under a grammar that declares
 * `rules({ scanSkip })` consults that ambient opaque-unit set in its INTERIOR too,
 * so a delimiter hidden inside a string/bracket run never closes the balance
 * early — the same footgun closure `scanTo` gets. `raw: true` opts out.
 *
 * By DEFAULT an unmatched close is RECOVERED, not failed: the close is wrapped in
 * `expect()`, so the group always succeeds and records a ParseError instead. Pass
 * `strict: true` to make it fail and roll back — see `ScanToOptions.strict`.
 */
export function balanced(
  open: string,
  close: string,
  options: ScanToOptions = {},
): Combinator<string> {
  const ownSkip = options.skip ?? []
  const strict = options.strict ?? false
  const combi = buildBalancedInterior(open, close, ownSkip, strict)
  // `raw` keeps the pre-ambient behavior: the eager interior (per-call skip only).
  if (options.raw) return markSpec(token(combi), open, close, ownSkip, strict, true)

  // Ambient-aware in place — the returned combinator KEEPS its identity (its own
  // interior `self` ref points back to it, and ir-serialize / codegen dedup rely
  // on that), so we override `parse` rather than wrapping. `_def`/`_meta` are
  // unchanged, so every static analysis sees the eager interior; only PARSING and
  // codegen EMIT re-resolve `ctx.scanSkip`. Interiors are cached by the ambient
  // array's identity (stable per grammar). Balanced consults ambient `scanSkip`
  // (opaque units) but NOT trivia — its delimiters are structural and its content
  // regex already spans whitespace, so adding trivia would perturb every existing
  // balanced; the footgun is a delimiter hidden in opaque-unit content.
  const eagerParse = combi.parse.bind(combi)
  const cache = new Map<readonly Combinator<unknown>[], Combinator<string>>()
  ;(combi as BalancedAmbient)._balancedAmbient = { open, close, ownSkip, strict }
  combi.parse = (input: string, pos: number, ctx: ParseContext): ParseResult<string> => {
    const amb = ctx.scanSkip
    if (!amb || amb.length === 0) return eagerParse(input, pos, ctx)
    let interior = cache.get(amb)
    if (!interior) {
      interior = buildBalancedInterior(open, close, [...amb, ...ownSkip], strict)
      cache.set(amb, interior)
    }
    return interior.parse(input, pos, ctx)
  }
  /**
   * ONE LEAF, like `scanTo` — the sibling in this file that has always got this
   * right.
   *
   * `balanced` is declared `Combinator<string>` and its interior callback
   * reassembles the whole match into exactly that one string. But the interior is
   * spelled `transform(sequence(literal(open), many(...), expect(literal(close))))`
   * and `transform` is TRANSPARENT to CST capture, so the reassembled string never
   * reached the parent's `children`: `balanced('(', ')')` over `"(a(b)c)"`
   * contributed SEVEN children while `scanTo` in the same file contributed one.
   * The declared type and the emitted arity disagreed, and nothing checked.
   *
   * `token()` is the fix rather than a bespoke wrapper because both engines
   * already understand `tag: 'token'` — the interpreter suppresses the interior
   * collectors and pushes one leaf, and codegen emits the mirror. Identity is
   * preserved where it matters: `_balancedAmbient` and the interior `self`
   * back-edge stay on the INNER combinator, which is what codegen's ambient
   * `scanSkip` rebuild reads and what nested opens recurse into — so a nested
   * balanced still contributes nothing of its own, and only the outermost match
   * becomes a leaf.
   *
   * This is the same rule the separated-list change enforces: a combinator may
   * collapse only what its construction makes recoverable. `balanced`'s
   * delimiters are FIXED at construction, so collapsing to one string is
   * legitimate here — which is exactly why it must actually collapse.
   */
  return markSpec(token(combi), open, close, ownSkip, strict, false)
}

/** Build a balanced open/close interior for a FIXED skip set (no ambient). */
export function buildBalancedInterior(
  open: string,
  close: string,
  skips: Combinator<unknown>[],
  strict = false,
): Combinator<string> {
  // The interior scan must skip NESTED same-delimiter pairs so depth is counted —
  // otherwise `{{x}}` stops at the first `}`. `self` references this balanced
  // combinator; added to the interior scan's skip list, a nested `open` is
  // consumed intact (recursively) before the scan looks for the matching `close`.
  const self = ref<string>()
  // PREDICTIVE interior — no char-walk. The body is `many(choice(self, …skips,
  // contentRun))`, where contentRun is a regex of chars that are NOT this pair's
  // delimiters and NOT the start of any skip (so a string/comment arm still wins
  // its position). At any other character — a stray close, or a *different* bracket
  // type — no arm matches, `many` stops, and the required close (expect()) reports
  // "expected <close>". So an unmatched open, a cross-type close `(a]`, and a stray
  // close all surface as errors; nothing is silently swallowed. Well-formed input
  // is consumed identically.
  const stop = new Set<string>([open, close])
  let bounded = true
  for (const sk of skips) {
    const cs = firstSetClassChars(sk)
    if (cs === null) { bounded = false; break }
    for (const ch of cs) stop.add(ch)
  }
  const cls = [...stop].map(escapeClassChar).join('')
  // A run when every skip's start is bounded (fast); else one char at a time so a
  // skip arm always gets the chance to match at its position.
  const content = bounded
    ? regex(new RegExp(`[^${cls}]+`))
    : regex(new RegExp(`[^${escapeClassChar(open)}${escapeClassChar(close)}]`))
  const inner = many(choice(self, ...skips, content))
  // The close is the ONLY thing strict mode changes. `expect()` recovers — it
  // returns a ParseError and lets the group succeed anyway — so the default
  // balanced can never fail past its opener. A bare `literal(close)` fails the
  // sequence instead, which rolls the whole group back to the opener and lets an
  // enclosing choice()/not()/attempt() actually see the rejection. Everything
  // else (first-set gating, trivia, the skip set, the content run, the interior
  // recursion through `self`) is shared, so strict and tolerant differ in
  // failure behaviour only, never in what they accept.
  const closer = strict ? literal(close) : expect(literal(close))
  const combi = transform(
    sequence(literal(open), inner, closer),
    // parts: strings (content/self) or arrays (a sequence-shaped skip) or a
    // ParseError (recovered close). `c` is the close string or a ParseError.
    ([o, parts, c]) => o + (parts as unknown[]).map(p => typeof p === 'string' ? p : Array.isArray(p) ? p.join('') : '').join('') + (typeof c === 'string' ? c : ''),
  )
  // Provide the callback source so the macro can inline this library-internal
  // transform (codegen derives map-fn sources from def.fnSrc).
  if (combi._def.tag === 'transform') {
    combi._def.fnSrc = '([o, parts, c]) => o + parts.map(p => typeof p === "string" ? p : Array.isArray(p) ? p.join("") : "").join("") + (typeof c === "string" ? c : "")'
    // This is Parseman's structural delimiter reconstruction, not a grammar
    // semantic reduction. It must remain eligible for recognition-only
    // composeLeaf artifacts while user-authored transform() remains excluded.
    combi._def.recognitionOnly = true
  }
  // Record what this interior IS, before the self-ref closes the cycle. Any walker
  // that would otherwise descend through `self` forever can stop here and render
  // the construct instead of its lowering.
  ;(combi as BalancedMarked)._balanced = { open, close }
  self.define(combi as Combinator<string>)
  return combi
}

/**
 * The characters a combinator can START with, as char-class members — or null if
 * its first set is unbounded ('any') or too broad to be a delimiter. Used by
 * balanced() to keep a content run from eating the start of a skip.
 */
function firstSetClassChars(c: Combinator<unknown>): string[] | null {
  const fs = c._meta.firstSet
  if (fs.kind === 'empty') return []
  if (fs.kind !== 'ranges') return null
  const out: string[] = []
  for (const { lo, hi } of fs.ranges) {
    if (hi - lo > 8) return null
    for (let cp = lo; cp <= hi; cp++) out.push(String.fromCodePoint(cp))
  }
  return out
}

function escapeClassChar(ch: string): string {
  return ch.replace(/[\\\]^-]/g, '\\$&')
}
