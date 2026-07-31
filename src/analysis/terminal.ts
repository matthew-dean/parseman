/**
 * The ONLY module in parseman that talks to a terminal.
 *
 * Everything above it produces DATA — rows of text with a semantic style — and this
 * file turns rows into bytes. That split is not tidiness; it is what makes the
 * rendering diffable. A renderer that emits escape sequences inline has two outputs
 * (styled and plain) that can drift apart, and the plain one is the one a snapshot,
 * a CI log and `docs/samples/` all read.
 *
 * WHY LINECRAFT AND NOT HAND-ROLLED ANSI
 * --------------------------------------
 * The first cut of this CLI carried its own `ANSI` constant table. Writing that file
 * silently dropped the ESC bytes, so colour was dead for an entire session and nothing
 * said so — the output still looked structured, because `[2m` prints as `[2m`. That is
 * the whole argument: escape sequences are invisible failure surface, and a library that
 * owns them removes the surface. jess already renders its diagnostics through
 * linecraft (`packages/compiler/src/diagnostics.ts`, `packages/lint/src/index.ts`), so
 * following the same idiom also means a jess user and a parseman user see the same shape
 * of output rather than two parallel inventions. The version is pinned to `0.2.6`,
 * exactly matching jess's two pins; a compiler and its consumer disagreeing about their
 * renderer is its own problem.
 *
 * THE IDIOM (from `packages/lint/src/index.ts:562`)
 * ------------------------------------------------
 *   - build `LineContent[]` — `{ text, style }`, one style per row;
 *   - NO colour: `rows.map(r => r.text)`. No escape byte is ever produced, so the
 *     plain output is byte-stable by construction rather than by stripping;
 *   - colour: hand the rows to a `Region({ disableRendering: true, width })` and read
 *     the lines back. The region never touches the terminal.
 *
 * DETERMINISM
 * -----------
 * `width` is passed explicitly and defaults to 80 off-TTY, so a piped run cannot vary
 * with the terminal it was piped from. Only the coloured path consults the environment
 * (linecraft resolves semantic colours against the terminal theme), and the coloured
 * path is never the one that gets diffed.
 */
import { CodeDebug, Region, type LineContent, type TextStyle } from 'linecraft'

/** One rendered row: the text, and how it should be emphasised. */
export type Row = LineContent

export type RowStyle = TextStyle

/** Semantic styles, named once so the two renderers cannot drift apart. */
export const TONE = {
  /** A heading, a count, the thing being named. */
  strong: { bold: true } as RowStyle,
  /** Supporting detail — never the finding itself. */
  quiet: { color: 'brightBlack' } as RowStyle,
  /** This row IS the problem. */
  bad: { color: 'red' } as RowStyle,
  /** Real, but not blocking. */
  warn: { color: 'yellow' } as RowStyle,
  /** A location or an identifier the reader will search for. */
  ident: { color: 'cyan' } as RowStyle,
  /** Clean. */
  good: { color: 'green' } as RowStyle,
} as const

export type RenderTarget = {
  /** Emit ANSI. Default false — never sniffed here; the CLI decides. */
  color?: boolean
  /** Columns. Default 80, which is also what an off-TTY stream reports as nothing. */
  width?: number
}

export const DEFAULT_WIDTH = 80

const row = (text: string, style?: RowStyle): Row => (style === undefined ? { text } : { text, style })
export { row }

/** Plain text of a row list — the byte-stable form, produced without a terminal. */
export const plain = (rows: readonly Row[]): string => rows.map(r => r.text).join('\n')

/**
 * Rows → a string. Without colour this never constructs a Region at all, so nothing in
 * the diffable path depends on linecraft's environment detection.
 */
export function render(rows: readonly Row[], target: RenderTarget = {}): string {
  if (target.color !== true) return plain(rows)
  const region = Region({ disableRendering: true, width: target.width ?? DEFAULT_WIDTH })
  region.set(rows as LineContent[])
  const out: string[] = []
  for (let line = 1; line <= region.height; line++) out.push(region.getLine(line))
  region.destroy(false)
  // A styled row is padded to the region width; trailing spaces are noise in a log and
  // make an otherwise-identical rendering compare unequal.
  return out.map(l => l.replace(/\s+$/, '')).join('\n')
}

// linecraft's own escapes, for the one component whose plain form is not otherwise
// reachable. Mirrors `packages/compiler/src/diagnostics.ts:246`.
// eslint-disable-next-line no-control-regex
const OSC8 = /\u001b\]8;;.*?\u001b\\/g
// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[[0-9;]*m/g

export type CodeFrame = {
  /** Path as the reader should see it — relative, so no absolute path can be diffed. */
  path: string
  /** Absolute path, used ONLY for the terminal hyperlink, which the plain form strips. */
  fullPath: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  lineBefore?: string | null
  lineText: string
  lineAfter?: string | null
  message: string
  /** Short label attached to the underline — the one sentence the caret is making. */
  shortMessage?: string
  type?: 'error' | 'warning' | 'info'
}

/**
 * A source frame with the caret under the offending span — linecraft's `CodeDebug`, the
 * same component jess renders its compiler errors with.
 *
 * Returned as ROWS of pre-rendered text rather than `{ text, style }`, because the
 * component styles per token and a `LineContent` carries one style per line. The plain
 * form is recovered by stripping, which is the one place in this file that has to;
 * `plainFrame` is asserted escape-free and absolute-path-free by test.
 */
export function codeFrame(frame: CodeFrame, target: RenderTarget = {}, indent = ''): Row[] {
  const region = Region({ disableRendering: true, width: (target.width ?? DEFAULT_WIDTH) - indent.length })
  region.set(CodeDebug({
    startLine: frame.line,
    startColumn: frame.column,
    ...(frame.endLine === undefined ? {} : { endLine: frame.endLine }),
    ...(frame.endColumn === undefined ? {} : { endColumn: frame.endColumn }),
    errorLine: frame.lineText,
    lineBefore: frame.lineBefore ?? null,
    lineAfter: frame.lineAfter ?? null,
    message: frame.message,
    ...(frame.shortMessage === undefined ? {} : { shortMessage: frame.shortMessage }),
    filePath: frame.path,
    fullPath: target.color === true ? frame.fullPath : frame.path,
    type: frame.type ?? 'error',
  }))
  const out: Row[] = []
  for (let line = 1; line <= region.height; line++) {
    const text = region.getLine(line)
    const body = target.color === true ? text : text.replace(OSC8, '').replace(SGR, '').replace(/\s+$/, '')
    out.push({ text: body === '' ? '' : indent + body })
  }
  region.destroy(false)
  return out
}

/** Deterministic thousands grouping — `toLocaleString()` differs between machines. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return (n < 0 ? '-' : '') + out
}

export const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))

/** Hard-wrap on spaces at `width`, prefixing every line with `indent`. */
export function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(w => w !== '')) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else { out.push(indent + line); line = word }
    }
    out.push(indent + line)
  }
  return out
}
