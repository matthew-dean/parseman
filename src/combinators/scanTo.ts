import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { literal } from './literal.ts'
import { regex } from './regex.ts'
import { sequence } from './sequence.ts'
import { choice } from './choice.ts'
import { many } from './repeat.ts'
import { transform } from './map.ts'
import { expect } from './expect.ts'
import { any } from './first-set.ts'
import { ref } from './ref.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

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
      const probeCtx: ParseContext = {
        trackLines: ctx.trackLines,
        state: ctx.state,
        ...(ctx._errors !== undefined ? { _errors: ctx._errors } : {}),
      }

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
        emit(cur)
        return { ok: true, value: input.slice(pos, cur), span: { start: pos, end: cur } }
      }
      const sentDef = sentinel._def
      const expected = sentDef.tag === 'literal' ? [JSON.stringify(sentDef.value)] : ['sentinel']
      return { ok: false, expected, span: { start: pos, end: cur } }
    },
  }
}

/**
 * Match a balanced open/close pair, skipping over any holes inside.
 * Returns the full matched text including delimiters.
 *
 *   const parenGroup = balanced('(', ')', { skip: [comment, stringLit] })
 */
export function balanced(
  open: string,
  close: string,
  options: ScanToOptions = {},
): Combinator<string> {
  // The interior scan must skip NESTED same-delimiter pairs so depth is counted —
  // otherwise `{{x}}` stops at the first `}`. `self` references this balanced
  // combinator; added to the interior scan's skip list, a nested `open` is
  // consumed intact (recursively) before the scan looks for the matching `close`.
  const self = ref<string>()
  const skips = options.skip ?? []
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
  const combi = transform(
    sequence(literal(open), inner, expect(literal(close))),
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
