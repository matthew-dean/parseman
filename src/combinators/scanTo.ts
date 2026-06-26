import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { literal } from './literal.ts'
import { sequence } from './sequence.ts'
import { transform } from './map.ts'
import { expect } from './expect.ts'
import { any } from './first-set.ts'
import { ref } from './ref.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

export type ScanToOptions = {
  /** Parsers that match "container" regions to skip over intact (balanced parens, strings, comments…) */
  skip?: Combinator<unknown>[]
  /**
   * If true, reaching EOF without finding the sentinel is a success — returns
   * everything consumed so far. Default false (fail at EOF).
   */
  orEOF?: boolean
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
  { skip = [], orEOF = false }: ScanToOptions = {},
): Combinator<string> {
  const meta: ParserMeta = {
    firstSet: any(),
    canMatchNewline: true,
    isTrivia: false,
  }

  return {
    _tag: 'scanTo',
    _meta: meta,
    _def: { tag: 'scanTo', sentinel, skip, orEOF },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      let cur = pos

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
  // Once `open` is consumed, the pair is COMMITTED: the interior scans to `close`
  // OR end-of-input (orEOF), and the close is required via expect(). A truly
  // unmatched `open` therefore reports "expected <close>" (into ctx._errors) and
  // recovers, instead of failing silently and letting the caller treat the stray
  // open as ordinary content. Well-formed input finds `close` before EOF, so this
  // is behaviourally identical there.
  const inner = scanTo(literal(close), {
    ...options,
    orEOF: true,
    skip: [self, ...(options.skip ?? [])],
  })
  const combi = transform(
    sequence(literal(open), inner, expect(literal(close), close)),
    // `c` is the close string, or a ParseError when expect() recovered an unmatched open.
    ([o, content, c]) => o + content + (typeof c === 'string' ? c : ''),
  )
  // Provide the callback source so the macro can inline this library-internal
  // transform (codegen derives map-fn sources from def.fnSrc).
  if (combi._def.tag === 'transform') {
    combi._def.fnSrc = '([o, content, c]) => o + content + (typeof c === "string" ? c : "")'
  }
  self.define(combi as Combinator<string>)
  return combi
}
