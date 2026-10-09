import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { rollbackCstCapture, saveCstMark } from '../cst/capture-buffer.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'

export type AttemptOptions = {
  /**
   * Also contain COMMITMENT. A failure committed inside the transaction — a
   * `dispatch()` whose selected branch failed — is reported as an ordinary
   * failure at the attempt's entry, so an enclosing `choice()` still tries its
   * next arm. For two readings of one prefix that only a later token decides.
   */
  contain?: boolean
}

function containOption(options: AttemptOptions | undefined): boolean {
  if (options === undefined) return false
  for (const key of Object.keys(options)) {
    if (key !== 'contain') throw new TypeError(`attempt(): unknown option ${JSON.stringify(key)}`)
  }
  if (options.contain !== undefined && typeof options.contain !== 'boolean') {
    throw new TypeError('attempt(): `contain` must be a boolean')
  }
  return options.contain === true
}

/**
 * Transactional ordered-choice arm. On failure it restores Parseman's
 * structural capture/trivia/error sinks and reports failure at its entry point;
 * user-owned `ctx.state` is intentionally not cloned or mutated by Parseman.
 * A committed failure keeps its commitment unless `contain` is set.
 */
export function attempt<T>(parser: Combinator<T>, options?: AttemptOptions): Combinator<T> {
  const contain = containOption(options)
  // First-set fail-fast (mirrors emitAttempt's codegen guard): a non-nullable inner
  // whose first set can't start here can only fail, so reject BEFORE taking the six
  // transaction rollback marks, re-anchoring at `pos` and reporting the same static
  // `expected` the inner start-fail would. Skipped under a completions probe /
  // tolerant recovery, where the swallowed failure still feeds the probe.
  const guardable = parser._meta.firstSet.kind !== 'any' && !matchesEmpty(parser)
  let failExpected: string[] | undefined
  return {
    _tag: 'attempt', _meta: parser._meta, _def: contain ? { tag: 'attempt', parser, contain: true } : { tag: 'attempt', parser },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      if (guardable && ctx._probe === undefined && !ctx._tolerant && !startsFirstSet(parser, input, pos)) {
        if (failExpected === undefined) {
          const e = deriveExpected(parser)
          failExpected = e.length > 0 ? e : [parser._tag]
        }
        return { ok: false, expected: failExpected, span: { start: pos, end: pos } }
      }
      const mark = saveCstMark(ctx)
      const log = ctx._triviaLog?.length
      const rootLog = ctx._rootTriviaLog?.length
      const result = parser.parse(input, pos, ctx)
      if (result.ok) return result
      rollbackCstCapture(ctx, mark)
      if (log !== undefined && ctx._triviaLog && ctx._triviaLog.length !== log) ctx._triviaLog.length = log
      if (rootLog !== undefined && ctx._rootTriviaLog && ctx._rootTriviaLog.length !== rootLog) ctx._rootTriviaLog.length = rootLog
      if (result.committed && !contain) return result
      return { ok: false, expected: result.expected, span: { start: pos, end: pos } }
    },
  }
}
