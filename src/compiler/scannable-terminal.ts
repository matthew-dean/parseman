/**
 * Lower scannable regex shapes to tight `charCodeAt` scan loops for terminal
 * `regex()` combinators (PERF_IDEAS §8). Trivia uses the SAME match core via
 * `scannable-run.ts` (`emitShapeMatch`); this module is just the terminal
 * wrapper: run the shared match, fail when it doesn't match, then slice the
 * value. Keeping one match core means terminal and trivia can never disagree on
 * what an incomplete token (unclosed string/comment) means.
 */
import { type ScanShape, emitShapeMatch } from './scannable-run.ts'

export type ScanEmitCtx = {
  ind: string
  pos: string
  valueVar: string
  /** Emit `if (cond) { failLine }` lines (no trailing blank). */
  failIf: (cond: string) => string[]
  fresh: (prefix?: string) => string
}

/** Emit stmts for one terminal regex match, or null when the shape is unsupported. */
export function emitScannableTerminal(
  shape: ScanShape,
  c: ScanEmitCtx,
): { stmts: string[]; endVar: string } | null {
  const m = emitShapeMatch(shape, c.pos, c.fresh, c.ind)
  const stmts = [...m.setup]
  // `chars*` matches unconditionally (possibly empty) — no failure branch needed.
  if (m.ok !== 'true') stmts.push(...c.failIf(`!(${m.ok})`))
  stmts.push(`${c.ind}const ${c.valueVar} = input.slice(${c.pos}, ${m.end})`)
  return { stmts, endVar: m.end }
}
