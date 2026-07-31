/**
 * The ONLY module in parseman that talks to a terminal.
 *
 * Everything above it produces DATA — lines made of spans, each span carrying text and a
 * semantic tone — and this file turns lines into bytes. That split is not tidiness; it is
 * what makes the rendering diffable. A renderer that emits escape sequences inline has
 * two outputs (styled and plain) that can drift apart, and the plain one is what a
 * snapshot, a CI log and `docs/samples/` all read.
 *
 * WHY LINECRAFT AND NOT HAND-ROLLED ANSI
 * --------------------------------------
 * The first cut of this CLI carried its own `ANSI` constant table. Writing that file
 * silently dropped the ESC bytes, so colour was dead for an entire session and nothing
 * said so — the output still looked structured, because an escape-less `[2m` prints as
 * `[2m`. Escape sequences are invisible failure surface, and a library that owns them
 * removes the surface. jess already renders its diagnostics through linecraft
 * (`packages/compiler/src/diagnostics.ts`, `packages/lint/src/index.ts`), so following
 * the same idiom also means a jess user and a parseman user see the same shape of output
 * rather than two parallel inventions. Pinned to `0.2.6`, exactly matching jess's pins.
 *
 * SPANS, NOT WHOLE-LINE STYLES
 * ----------------------------
 * jess's lint table styles a whole row at a time, which is right for a table of one
 * thing per line. A grammar finding is not that: within one line the arm index, the
 * production, its first set and the annotation all mean different things, and the
 * annotation is the part that should be shouting. So a line here is a list of SPANS, and
 * a styled line is a linecraft `Grid` of `Styled` cells — which also gives the columns
 * their alignment for free.
 *
 * THE INVARIANT THAT MUST NOT BREAK
 * ---------------------------------
 * Padding happens in ONE place, before either path sees it, and the plain form is the
 * concatenation of the padded span texts. So the two paths differ in styling and in
 * nothing else — not in width, not in alignment, not in content. No escape byte is
 * produced at all when colour is off, so the diffable output is byte-stable by
 * construction rather than by stripping. `width` is passed explicitly and defaults to 80
 * off-TTY, so a piped run cannot vary with the terminal it was piped from.
 */
import { CodeDebug, Region, Styled, type TextStyle } from 'linecraft'

export type Tone = TextStyle

/**
 * Semantic tones, named once so the two renderers cannot drift apart.
 *
 * The ladder matters more than the individual colours: within a finding, exactly one
 * thing should be the brightest, and provenance / accept keys / byte costs should
 * recede. A report where everything is emphasised is a report where nothing is.
 */
export const TONE = {
  /** The single most important thing in its block. */
  loud: { color: 'brightRed', bold: true } as Tone,
  /** A heading, a count, the thing being named. */
  strong: { bold: true } as Tone,
  /** Supporting detail — never the finding itself. */
  quiet: { color: 'brightBlack' } as Tone,
  /** Recedes furthest: provenance, snapshot keys, byte costs. */
  faint: { color: 'brightBlack', dim: true } as Tone,
  /** This span IS the problem. */
  bad: { color: 'red' } as Tone,
  /** Real, but not blocking. */
  warn: { color: 'yellow' } as Tone,
  /** A location or an identifier the reader will search for. */
  ident: { color: 'cyan', bold: true } as Tone,
  /** Clean, or the thing to do. */
  good: { color: 'green' } as Tone,
  /** Structure: rules, box drawing, group frames. */
  frame: { color: 'blue' } as Tone,
} as const

/** One styled run of text. `width` pads it, in BOTH paths, so columns line up. */
export type Span = {
  text: string
  style?: Tone
  /** Pad to this column width. Applied once, before either path renders. */
  width?: number
  /** Text that ALREADY contains escapes (a linecraft component's own output). */
  raw?: boolean
  /**
   * Absolute path this span points at. In the STYLED path it becomes a clickable
   * terminal hyperlink; the plain path ignores it entirely, which is what keeps the
   * diffable output free of escapes and of absolute paths.
   */
  link?: string
}

/** A line is its spans. An empty array is a blank line. */
export type Line = Span[]

export const t = (text: string, style?: Tone, width?: number): Span =>
  ({ text, ...(style === undefined ? {} : { style }), ...(width === undefined ? {} : { width }) })

export const blank = (): Line => []

/** A horizontal rule. Segmentation is what turns eighty undifferentiated lines into a
 *  handful of blocks a reader can skip between. */
export const rule = (width: number, style: Tone = TONE.frame, char = '─'): Line =>
  [{ text: char.repeat(Math.max(0, width)), style }]

export type RenderTarget = {
  /** Emit ANSI. Default false — never sniffed here; the CLI decides. */
  color?: boolean
  /** Columns. Default 80, which is also what an off-TTY stream reports as nothing. */
  width?: number
  /**
   * Emit OSC-8 terminal hyperlinks on file locations. Only meaningful with `color`,
   * since both are escape sequences. Default: on when colouring. A terminal without
   * OSC-8 support prints the URL as visible junk, so this is the escape hatch.
   */
  links?: boolean
}

export const DEFAULT_WIDTH = 80

const padTo = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))

/** The one place padding happens. Both render paths consume the result of this. */
const spanText = (s: Span): string => (s.width === undefined ? s.text : padTo(s.text, s.width))

/**
 * The padded, trailing-trimmed spans of one line — the SINGLE source both paths read.
 *
 * Both `plain` and `render` consume exactly this, so they cannot disagree about content,
 * padding or alignment. Only what wraps each span differs.
 */
function cellsOf(line: Line): Span[] {
  const cells = line.map(s => ({ ...s, text: spanText(s) })).filter(s => s.text !== '')
  // Trailing whitespace is noise in a log and makes two otherwise-identical renderings
  // compare unequal. Trim it off the END of the line, span by span.
  for (let i = cells.length - 1; i >= 0; i--) {
    const trimmed = cells[i]!.text.replace(/ +$/, '')
    cells[i]!.text = trimmed
    if (trimmed !== '') break
    cells.pop()
  }
  return cells
}

/** Plain text of a line list — the byte-stable form, produced without a terminal. */
export const plain = (lines: readonly Line[]): string =>
  lines.map(l => cellsOf(l).map(c => c.text).join('')).join('\n')

/**
 * The escape codes linecraft emits for a tone, learned FROM linecraft and cached.
 *
 * The alternative — a `Grid` of `Styled` cells — loses to the component's own layout:
 * `Styled` left-trims its content and the grid re-flows a long cell, so the styled line
 * ended up disagreeing with the plain one in CONTENT, which is the one divergence this
 * module exists to prevent. Asking the library what a tone looks like and wrapping
 * UNCHANGED text in it makes parity structural rather than something a test has to
 * catch: the text between the codes is byte-identical to the plain form because it is
 * the same string.
 *
 * This is not hand-rolled ANSI. No escape sequence is written down anywhere in parseman;
 * every byte of styling comes out of linecraft, once per distinct tone.
 */
const CODE_CACHE = new Map<string, { pre: string; post: string }>()

function codesFor(style: Tone | undefined): { pre: string; post: string } {
  if (style === undefined) return { pre: '', post: '' }
  const key = JSON.stringify(style)
  const hit = CODE_CACHE.get(key)
  if (hit !== undefined) return hit
  const region = Region({ disableRendering: true, width: 8 })
  region.set(Styled(style, 'X'))
  const line = region.getLine(1)
  region.destroy(false)
  const at = line.indexOf('X')
  const codes = at === -1
    ? { pre: '', post: '' }
    : { pre: line.slice(0, at), post: line.slice(at + 1).replace(/ /g, '') }
  CODE_CACHE.set(key, codes)
  return codes
}

/**
 * The OSC-8 hyperlink wrapper, also learned FROM linecraft rather than written down.
 *
 * linecraft has `fileLink()`, but its package `exports` map publishes only `.` and
 * `./components`, so it cannot be imported. `CodeDebug` DOES emit one for its file
 * header, so the sequence is recovered the same way tone codes are: render the component
 * once with sentinel values and read back what it wrapped them in. If the shape ever
 * changes — or is not found — links are simply not emitted, which degrades to plain text
 * rather than to garbage on screen.
 */
let LINK_TEMPLATE: { pre: string; mid: string; post: string } | null | undefined

function linkTemplate(): { pre: string; mid: string; post: string } | null {
  if (LINK_TEMPLATE !== undefined) return LINK_TEMPLATE
  const URL_SENTINEL = '/PM_LINK_URL'
  const TEXT_SENTINEL = 'PM_LINK_TEXT'
  const region = Region({ disableRendering: true, width: 120 })
  region.set(CodeDebug({
    startLine: 1, startColumn: 1, errorLine: 'x', message: 'm',
    filePath: TEXT_SENTINEL, fullPath: URL_SENTINEL, type: 'info',
  }))
  let found: { pre: string; mid: string; post: string } | null = null
  for (let i = 1; i <= region.height && found === null; i++) {
    const line = region.getLine(i)
    const u = line.indexOf(URL_SENTINEL)
    const x = line.indexOf(TEXT_SENTINEL)
    if (u === -1 || x === -1 || x < u) continue
    // Everything from the last ESC before the URL, so the whole introducer is captured.
    const start = line.lastIndexOf(ESC, u)
    if (start === -1) continue
    const after = x + TEXT_SENTINEL.length
    const endEsc = line.indexOf(ESC, after)
    if (endEsc === -1) continue
    // The closing OSC-8 runs to the terminator after the empty URL.
    const close = line.indexOf('\\', line.indexOf(ESC, endEsc + 1))
    if (close === -1) continue
    found = {
      pre: line.slice(start, u),
      mid: line.slice(u + URL_SENTINEL.length, x),
      post: line.slice(after, close + 1),
    }
  }
  region.destroy(false)
  LINK_TEMPLATE = found
  return found
}

/** Wrap `text` as a hyperlink to `path`. Zero-width: the visible text is unchanged, so
 *  every width and alignment calculation upstream stays correct. */
function linked(text: string, path: string): string {
  const tpl = linkTemplate()
  if (tpl === null) return text
  // Link the VISIBLE text only; column padding stays outside the link so a reader is
  // not clicking on empty space.
  const body = text.replace(/ +$/, '')
  const trail = text.slice(body.length)
  return `${tpl.pre}${path}${tpl.mid}${body}${tpl.post}${trail}`
}

/**
 * Lines → a string. Without colour this never constructs a Region at all, so nothing on
 * the diffable path depends on linecraft's environment detection.
 */
export function render(lines: readonly Line[], target: RenderTarget = {}): string {
  if (target.color !== true) return plain(lines)
  const wantLinks = target.links !== false
  return lines.map((line) => {
    // A pre-rendered component line (a code frame) already carries its own escapes.
    if (line.length === 1 && line[0]!.raw === true) return line[0]!.text
    return cellsOf(line).map((c) => {
      const { pre, post } = codesFor(c.style)
      const body = wantLinks && c.link !== undefined ? linked(c.text, c.link) : c.text
      return `${pre}${body}${post}`
    }).join('')
  }).join('\n')
}

// linecraft's own escapes, for the one component whose plain form is not otherwise
// reachable. Mirrors `packages/compiler/src/diagnostics.ts:246`. Built from a char code
// so the ESC byte cannot be lost in transit the way the old constant table's was.
const ESC = String.fromCharCode(27)
const OSC8 = new RegExp(`${ESC}\\]8;;.*?${ESC}\\\\`, 'g')
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

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
 * Its lines come back as RAW spans: the component styles per token, which a span list
 * cannot describe, and it is already the shape a reader wants. The plain form is
 * recovered by stripping — the one place in this file that has to — and is asserted
 * escape-free and absolute-path-free by test.
 */
export function codeFrame(frame: CodeFrame, target: RenderTarget = {}, indent = ''): Line[] {
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
    // The component links its own header. Without colour (or with links off) it is
    // handed the relative path, so no absolute path can reach the diffable output.
    fullPath: target.color === true && target.links !== false ? frame.fullPath : frame.path,
    type: frame.type ?? 'error',
  }))
  const out: Line[] = []
  for (let line = 1; line <= region.height; line++) {
    const text = region.getLine(line)
    const body = target.color === true ? text : text.replace(OSC8, '').replace(SGR, '').replace(/\s+$/, '')
    out.push(body === '' ? [] : [{ text: indent + body, raw: target.color === true }])
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

export const pad = padTo

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
