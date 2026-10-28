import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'
import { createDetachedParseContext } from '../parse-context.ts'

/**
 * One line of a run that `lines()` hands its body.
 *
 * The body parses the run's lines with their prefixes removed and joined by
 * `\n`. Each entry says where a line's content sits in that text (`offset`) and
 * in the run's own input (`source`), where its column count starts, and whether
 * it joined the run through `lazy`.
 */
export type RunLine = {
  /** Where the line's content starts in the body's input. */
  readonly offset: number
  /** Where the same content starts in the run's input. */
  readonly source: number
  /** Where the line ends in the run's input, before its newline. */
  readonly end: number
  /**
   * The column at `source`: tab stops every four columns, counted from the
   * start of the outermost input's line, through every enclosing run.
   */
  readonly column: number
  /**
   * Columns of the character at `source` that a prefix already took. A
   * `columns(n)` prefix that ends inside a tab leaves the tab in the content and
   * records the columns it took here, so the content keeps the tab's remainder.
   */
  readonly split: number
  /** The line joined through `lazy`, with nothing removed. */
  readonly lazy: boolean
}

/** The lines of the run whose body is parsing, and the run enclosing it. */
export type LineView = {
  readonly lines: readonly RunLine[]
  readonly parent: LineView | undefined
}

export type LinesOptions = {
  /** The prefix of the run's first line, when it differs from the others' (a list item's marker). */
  first?: Combinator<unknown>
  /**
   * A line the prefix does not match continues the run, whole, when `lazy`
   * matches at its start: Markdown's lazy continuation lines. Only the match
   * counts; what `lazy` consumes is not removed.
   */
  lazy?: Combinator<unknown>
}

type LinesContext = ParseContext

/** The index of the run line holding `offset` of the body's input, by binary search. */
function lineIndexAt(view: LineView, offset: number): number {
  const lines = view.lines
  let lo = 0, hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid]!.offset <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}
const lineAt = (view: LineView, offset: number): RunLine | undefined => view.lines[lineIndexAt(view, offset)]

/** Map an offset in a run body's input to the offset in the run's own input. */
export function sourceOffset(view: LineView, offset: number): number {
  const line = lineAt(view, offset)
  return line === undefined ? offset : line.source + (offset - line.offset)
}

/**
 * The column at `pos` and the columns of the character there already taken,
 * counting from the line start of the current input, or, inside a run's body,
 * from that run's line, whose column and split the enclosing runs supply.
 */
function columnAt(input: string, pos: number, ctx: LinesContext): { column: number; split: number } {
  const view = ctx.lineView
  let start: number, column: number, split: number
  const line = view === undefined ? undefined : lineAt(view, pos)
  if (line !== undefined && pos >= line.offset) { start = line.offset; column = line.column; split = line.split }
  else { start = input.lastIndexOf('\n', pos - 1) + 1; column = 0; split = 0 }
  for (let i = start; i < pos; i++) {
    if (input.charCodeAt(i) === 0x09) {
      // A tab reaches the next stop; one the prefix split has fewer columns left.
      const width = 4 - (column - (i === start ? split : 0)) % 4 - (i === start ? split : 0)
      column += width
    } else column++
    split = 0
  }
  return { column, split: pos === start ? split : 0 }
}

/**
 * `n` columns of indentation: spaces and tabs, a tab reaching the next stop of
 * four columns. When the `n`th column falls inside a tab, the match stops before
 * that tab, and a `lines()` prefix ending there leaves the tab's remaining
 * columns in the content (`RunLine.split`). Fails when the indentation is
 * narrower than `n`.
 */
export function columns(n: number): Combinator<string> {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`columns(n) needs a non-negative integer, got ${n}`)
  const expected = [`columns(${n})`]
  const meta: ParserMeta = {
    firstSet: n === 0 ? any() : { kind: 'ranges', ranges: [{ lo: 0x09, hi: 0x09 }, { lo: 0x20, hi: 0x20 }] },
    canMatchNewline: false,
    isTrivia: false,
  }
  return {
    _tag: 'columns',
    _meta: meta,
    _def: { tag: 'columns', n },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      const c = ctx as LinesContext
      let { column, split } = columnAt(input, pos, c)
      const goal = column + n
      let at = pos
      while (column < goal) {
        const code = input.charCodeAt(at)
        if (code === 0x20) { column++; split = 0; at++; continue }
        if (code !== 0x09) return { ok: false, expected, span: { start: at, end: at } }
        const width = 4 - (column - split) % 4 - split
        if (column + width > goal) {
          // The goal falls inside this tab: stop before it, and say how much of it is taken.
          c._columnsSplit = { at, split: split + (goal - column) }
          return { ok: true, value: input.slice(pos, at), span: { start: pos, end: at } }
        }
        column += width; split = 0; at++
      }
      return { ok: true, value: input.slice(pos, at), span: { start: pos, end: at } }
    },
  }
}

/**
 * Parse `body` over a run of lines with a prefix removed from each.
 *
 * The run starts at `pos`, where `first` (default `prefix`) must match. Each
 * following line joins while `prefix` matches at its start, or, failing that,
 * while `lazy` does; the run ends at the first line that joins neither way or
 * at the end of the input. A prefix never reaches past its own line.
 *
 * `body` parses the lines' contents joined by `\n`, starting at 0. While it
 * runs, `ctx.lineView` describes the lines (`RunLine`), so nested `columns()`
 * and `lines()` count tab stops from the right column. The result spans from
 * `pos` to where the body stopped, mapped back to this input: a run ends after
 * the last line the body consumed, so lines it leaves are the enclosing
 * grammar's. Spans inside the body's value are offsets in the body's input;
 * `sourceOffset(view, offset)` maps them back.
 */
export function lines<T>(prefix: Combinator<unknown>, body: Combinator<T>, options: LinesOptions = {}): Combinator<T> {
  const { first, lazy } = options
  const opening = first ?? prefix
  const meta: ParserMeta = {
    firstSet: opening._meta.firstSet,
    canMatchNewline: true,
    isTrivia: false,
  }
  return {
    _tag: 'lines',
    _meta: meta,
    _def: { tag: 'lines', prefix, body: body as Combinator<unknown>, ...(first === undefined ? {} : { first }), ...(lazy === undefined ? {} : { lazy }) },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const c = ctx as LinesContext
      // Prefixes and lazy checks are probes: they run detached, so they leave
      // no leaves, trivia or errors in the parse that encloses the run.
      const probe = createDetachedParseContext(false, ctx.state) as LinesContext
      probe.lineView = c.lineView
      const run: RunLine[] = []
      const parts: string[] = []
      let offset = 0
      for (let start = pos; start < input.length || start === pos;) {
        let end = input.indexOf('\n', start)
        if (end < 0) end = input.length
        probe._columnsSplit = undefined
        const head = (run.length === 0 ? opening : prefix).parse(input, start, probe)
        let content: number
        let joined: 'prefix' | 'lazy' | undefined
        if (head.ok && head.span.end <= end) { content = head.span.end; joined = 'prefix' }
        else if (run.length === 0) {
          // A prefix is a probe: its failure is the run's, never a commitment.
          return { ok: false, expected: head.ok ? ['line prefix'] : head.expected, span: { start, end: start } }
        } else if (lazy !== undefined && lazy.parse(input, start, probe).ok) { content = start; joined = 'lazy' }
        else break
        const mark = probe._columnsSplit as { at: number; split: number } | undefined
        const here = columnAt(input, content, c)
        const split = joined === 'prefix' && mark !== undefined && mark.at === content ? mark.split : here.split
        run.push({ offset, source: content, end, column: here.column + (split - here.split), split, lazy: joined === 'lazy' })
        const text = input.slice(content, end)
        const newline = end < input.length
        parts.push(newline ? `${text}\n` : text)
        offset += text.length + (newline ? 1 : 0)
        start = end + 1
        if (!newline) break
      }
      const view: LineView = { lines: run, parent: c.lineView }
      const saved = c.lineView
      c.lineView = view
      let result: ParseResult<T>
      try { result = body.parse(parts.join(''), 0, ctx) }
      finally { c.lineView = saved }
      if (!result.ok) {
        const at = sourceOffset(view, result.span.start)
        return { ...result, span: { start: at, end: at } }
      }
      // The body's end maps to the end of its line: a body that consumed a
      // whole line, newline included, ends at the next line's start.
      const stop = result.span.end
      const index = lineIndexAt(view, stop)
      const line = run[index]!
      const end = stop === line.offset && index > 0 ? run[index - 1]!.end + 1
        : stop - line.offset > line.end - line.source ? line.end + 1
        : line.source + (stop - line.offset)
      return { ok: true, value: result.value, span: { start: pos, end } }
    },
  }
}
