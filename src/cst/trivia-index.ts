import type { Span } from '../types.ts'

/** One captured trivia token (a whitespace run or a comment) with its source span. */
export type TriviaToken = { readonly value: string; readonly span: Span }

/**
 * Before/after offset index of captured trivia. Built from a tree whose nodes
 * carry a `triviaLog` property (the flat `[start, end, insertIdx, ...]` array
 * produced by parseman when `_captureTrivia` is enabled on a `Parser` grammar).
 *
 *   index.before.get(node.span.start)  // trivia immediately before a node
 *   index.after.get(node.span.end)     // trivia immediately after a node
 *
 * A given trivia entry is registered under BOTH the following item's start
 * (`before`) and the preceding item's end (`after`), so either lookup finds it.
 */
export type TriviaIndex = {
  readonly before: Map<number, TriviaToken[]>
  readonly after: Map<number, TriviaToken[]>
}

type Spanned = { readonly span: Span }
type NodeWithTrivia = {
  readonly span?: Span
  readonly children?: ReadonlyArray<unknown>
  readonly rawChildren?: ReadonlyArray<Spanned>
  readonly triviaLog?: readonly number[]
}

function merge(map: Map<number, TriviaToken[]>, key: number, run: TriviaToken[]): void {
  if (run.length === 0) return
  const existing = map.get(key)
  if (existing) existing.push(...run)
  else map.set(key, [...run])
}

/**
 * Options for trailing/leading trivia at the document boundary. A repeating root
 * (e.g. `many()`) rolls back the trivia after its last item — it's "trailing" and
 * belongs to the enclosing context, which at the document root is the document
 * itself. Pass `{ trivia }` to re-scan and register that boundary trivia,
 * so a round-trippable trivia map isn't missing the run before EOF.
 */
export type TriviaIndexOptions = {
  /**
   * A regex matching ONE trivia token (a whitespace run or a comment). Applied
   * repeatedly to tokenize the boundary trivia. Each match becomes one token, so
   * write it to match a maximal run, e.g.
   * `/[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//`.
   */
  trivia: RegExp
}

/**
 * Walk a tree produced by a parseman `Parser` grammar (with `_captureTrivia`
 * enabled) and build a before/after trivia index. Each node must carry a
 * `triviaLog: readonly number[]` property (flat `[start, end, insertIdx, …]` —
 * three numbers per entry) and a `rawChildren` property (structural items
 * with `.span`). `input` is the source string used to materialize trivia values.
 *
 * With `opts`, also captures leading trivia (before the root's content) and
 * trailing trivia (after it, up to EOF) — the document boundaries a repeating
 * root rolls back.
 */
export function buildTriviaIndex(root: unknown, input = '', opts?: TriviaIndexOptions): TriviaIndex {
  const before = new Map<number, TriviaToken[]>()
  const after = new Map<number, TriviaToken[]>()

  const visit = (node: NodeWithTrivia): void => {
    const log = node.triviaLog
    const raw = node.rawChildren

    if (log && log.length && raw) {
      for (let i = 0; i < log.length; i += 3) {
        const tStart = log[i]!, tEnd = log[i + 1]!, insertIdx = log[i + 2]!
        if (tEnd <= tStart) continue
        const run: TriviaToken[] = [{ value: input.slice(tStart, tEnd), span: { start: tStart, end: tEnd } }]
        const next = raw[insertIdx]
        if (next) merge(before, next.span.start, run)
        const prev = insertIdx > 0 ? raw[insertIdx - 1] : undefined
        if (prev) merge(after, prev.span.end, run)
      }
    }

    const ch = node.children
    if (ch) {
      for (const c of ch) {
        if (typeof c === 'object' && c !== null && (c as NodeWithTrivia).children !== undefined) {
          visit(c as NodeWithTrivia)
        }
      }
    }
  }

  if (root) visit(root as NodeWithTrivia)

  // Document-boundary trivia: re-scan leading (offset 0) and trailing (root end
  // → EOF) trivia that a repeating root rolled back.
  if (opts && input) {
    const rootSpan = (root as NodeWithTrivia | null)?.span
    const re = new RegExp(opts.trivia.source, opts.trivia.flags.replace(/[gy]/g, '') + 'y')
    const scanFrom = (from: number): TriviaToken[] => {
      const run: TriviaToken[] = []
      let pos = from
      re.lastIndex = pos
      let m = re.exec(input)
      while (m && m.index === pos && m[0].length > 0) {
        run.push({ value: m[0], span: { start: pos, end: pos + m[0].length } })
        pos += m[0].length
        re.lastIndex = pos
        m = re.exec(input)
      }
      return run
    }

    if (rootSpan && rootSpan.start > 0) {
      const lead = scanFrom(0)
      if (lead.length) merge(before, rootSpan.start, lead)
    }
    const end = rootSpan ? rootSpan.end : 0
    if (end < input.length) {
      const trail = scanFrom(end)
      if (trail.length) {
        merge(after, end, trail)
        merge(before, end + trail.reduce((n, t) => n + (t.span.end - t.span.start), 0), trail)
      }
    }
  }

  return { before, after }
}
