import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { any } from './first-set.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

/**
 * Computes a regex terminal's first-set (for choice-dispatch fast paths). The
 * only implementation — `firstSetFromRegex` in `./regex-analyze.ts` — is backed
 * by `regexp-tree` (~264 KB) and is registered by the interpreter/library entry
 * (`index.ts`) via `registerRegexAnalyzer`. It is injected rather than imported
 * so that consumers who ship only compiled grammars (or import `regex` directly
 * from this subpath) never pull `regexp-tree` into their bundle. When no
 * analyzer is registered, `regex()` uses the permissive `PERMISSIVE_FIRST_SET`
 * below — this only disables the dispatch fast paths, never changing matches.
 */
export type RegexFirstSetAnalyzer = (pattern: string) => { firstSet: FirstSet; canMatchNewline: boolean }

let firstSetAnalyzer: RegexFirstSetAnalyzer | null = null

export function registerRegexAnalyzer(analyzer: RegexFirstSetAnalyzer): void {
  firstSetAnalyzer = analyzer
}

/** Fallback when no analyzer is registered: "could start with any char / could
 * match a newline" — the same conservative value `firstSetFromRegex` returns on
 * an unparseable pattern, so a missing analyzer degrades to "no fast path", not
 * a wrong one. */
const permissiveFirstSet: RegexFirstSetAnalyzer = () => ({ firstSet: any(), canMatchNewline: true })

export function regex(pattern: string | RegExp, flags = ''): Combinator<string> {
  const source = typeof pattern === 'string' ? pattern : pattern.source
  const resolvedFlags = typeof pattern === 'string' ? flags : pattern.flags

  const anchored = new RegExp(source, 'y' + resolvedFlags.replace(/[gy]/g, ''))

  const { firstSet, canMatchNewline } = (firstSetAnalyzer ?? permissiveFirstSet)(source)
  const meta: ParserMeta = { firstSet, canMatchNewline, isTrivia: false }

  return {
    _tag: 'regex',
    _meta: meta,
    _def: { tag: 'regex', source, flags: resolvedFlags },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      anchored.lastIndex = pos
      const m = anchored.exec(input)
      if (m === null) {
        return failAt(ctx, [`/${source}/`], pos)
      }
      const span = { start: pos, end: pos + m[0]!.length }
      const leaf = { _tag: 'leaf', value: m[0]!, span }
      if (cstCaptureActive(ctx)) pushCstLeaf(ctx, leaf)
      return { ok: true, value: m[0]!, span }
    },
  }
}
