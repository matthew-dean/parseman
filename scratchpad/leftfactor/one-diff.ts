import { realpathSync } from 'node:fs'
const P = realpathSync('/Users/matthew/git/worktrees/pm-leftfactor/examples/css/parser.ts')
const mod = (await import(P)) as { parseCss(i: string): unknown; parseCssCompiled(i: string): unknown }
const input = ':is(.replace.replace'
const a = mod.parseCss(input)
const b = mod.parseCssCompiled(input)

function diff(x: unknown, y: unknown, at = 'root'): string | null {
  if (JSON.stringify(x) === JSON.stringify(y)) return null
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>
    for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
      const d = diff(xo[k], yo[k], `${at}.${k}`)
      if (d) return d
    }
  }
  return `${at}:\n    interp   ${JSON.stringify(x)?.slice(0, 200)}\n    compiled ${JSON.stringify(y)?.slice(0, 200)}`
}
console.log('top-level keys:', Object.keys(a as object))
console.log(diff(a, b) ?? 'IDENTICAL')
