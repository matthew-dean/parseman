#!/usr/bin/env node
/**
 * Executes every worked example in the guide and checks the shown output against
 * what the engine ACTUALLY produces.
 *
 * A documented output that was written by hand is a claim nobody checked. This
 * runs them: each `ts` fenced block tagged `// [verify]` becomes a real module,
 * every `expr` followed by a `// → expected` line is evaluated, and the rendered
 * value is compared to the text in the doc.
 *
 *   node scripts/verify-doc-examples.mjs           # check (exit 1 on any mismatch)
 *   node scripts/verify-doc-examples.mjs --fix     # rewrite the docs with real output
 *
 * `--fix` is how the outputs get into the docs in the first place — author the
 * expression, leave `// →`, run --fix, and the engine fills in the answer.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..')
// The scratch modules live INSIDE the repo so tsx resolves them as ESM under the
// package's own `"type": "module"` — a module in the OS temp dir is treated as CJS
// and cannot import the TS source at all.
const SCRATCH = join(ROOT, '.doc-verify')
const SRC_ENTRY = '../src/index.ts'
const FIX = process.argv.includes('--fix')

const DOCS = globSync('docs/**/*.md', { cwd: ROOT }).map(f => join(ROOT, f)).sort()

/** A fenced ```ts block carrying the `// [verify]` marker. */
const BLOCK_RE = /^```ts\n([\s\S]*?)^```$/gm

/** `<expr>` on one line, `// → <expected>` on the next. */
function splitChecks(code) {
  const lines = code.split('\n')
  const checks = []
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^\s*\/\/ → ?(.*)$/.exec(lines[i + 1] ?? '')
    if (!m) continue
    const expr = lines[i].trim()
    if (!expr || expr.startsWith('//')) continue
    // A checked statement must be ONE line: only that line is replaced by the emit,
    // so a continuation line would be left dangling.
    if (expr.startsWith('.') || /[,([{]$/.test(expr)) {
      checks.push({ line: i, exprLine: i, outLine: i + 1, expr, expected: '', multiline: true })
      continue
    }
    checks.push({ line: i, exprLine: i, outLine: i + 1, expr, expected: m[1].trim() })
  }
  return { lines, checks }
}

/** Compact JS-literal rendering — what a reader would write by hand, but real. */
function render(v, seen = new Set()) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const t = typeof v
  if (t === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'function') return `[fn ${v.name || 'anonymous'}]`
  if (t === 'symbol') return String(v)
  if (seen.has(v)) return '[circular]'
  seen.add(v)
  try {
    if (Array.isArray(v)) return `[${v.map(x => render(x, seen)).join(', ')}]`
    const entries = Object.entries(v)
    if (entries.length === 0) return '{}'
    return `{ ${entries.map(([k, val]) =>
      `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k}'`}: ${render(val, seen)}`).join(', ')} }`
  } finally {
    seen.delete(v)
  }
}

const results = []
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const tmp = SCRATCH

for (const file of DOCS) {
  const original = readFileSync(file, 'utf8')
  let out = original
  let blockIndex = 0
  const rewrites = []

  for (const m of original.matchAll(BLOCK_RE)) {
    const code = m[1]
    if (!code.includes('// [verify]')) continue
    const { lines, checks } = splitChecks(code)
    if (checks.length === 0) continue
    const id = `${file}#${blockIndex++}`

    // Build a runnable module from the block VERBATIM, with each checked statement
    // replaced IN PLACE by its emit. In-place matters three ways: the expression
    // runs exactly once (no doubled side effects), a deliberately-throwing example
    // is captured instead of killing the block, and a statement starting with `[`
    // can't be swallowed by ASI into the line above.
    const checkAt = new Map(checks.map(c => [c.exprLine, c]))
    const body = lines
      .map((l, i) => {
        if (l.includes('// [verify]')) return ''
        if (l.trim().startsWith('import ')) return ''
        const c = checkAt.get(i)
        return c ? `__emit(${checks.indexOf(c)}, () => (${c.expr}))` : l
      })
      .join('\n')
    const imports = lines.filter(l => l.trim().startsWith('import ')).join('\n')
      .replace(/from ['"]parseman['"]/g, `from ${JSON.stringify(SRC_ENTRY)}`)
    const mod = [
      imports,
      `const __out = []`,
      `function __emit(i, f) { try { __out.push([i, 'ok', f()]) } catch (e) { __out.push([i, 'throw', String(e && e.message || e)]) } }`,
      body,
      `console.log('@@JSON@@' + JSON.stringify(__out, (k, v) => typeof v === 'function' ? '[fn]' : v))`,
    ].join('\n')

    const modPath = join(tmp, `b${results.length}_${blockIndex}.ts`)
    writeFileSync(modPath, mod)
    let emitted
    try {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx/esm', modPath], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
      const line = stdout.split('\n').find(l => l.startsWith('@@JSON@@'))
      if (!line) throw new Error(`no output\n${stdout}`)
      emitted = JSON.parse(line.slice('@@JSON@@'.length))
    } catch (e) {
      results.push({ id, expr: '(whole block)', status: 'ERROR', detail: String(e.stderr || e.message).slice(0, 600) })
      continue
    }

    // JSON round-trip loses undefined; re-render from the raw values by re-running
    // the renderer on the parsed structure (adequate for doc-shaped data).
    const newLines = [...lines]
    for (const [i, kind, value] of emitted) {
      const c = checks[i]
      if (c.multiline) { results.push({ id, expr: c.expr, status: 'FAIL', detail: 'checked statement must be a single line' }); continue }
      const actual = kind === 'throw' ? `throws: ${value}` : render(value)
      if (actual === c.expected) {
        results.push({ id, expr: c.expr, status: 'PASS' })
      } else if (FIX) {
        results.push({ id, expr: c.expr, status: 'FIXED', detail: `${c.expected} → ${actual}` })
        newLines[c.outLine] = newLines[c.outLine].replace(/\/\/ →.*$/, `// → ${actual}`)
      } else {
        results.push({ id, expr: c.expr, status: 'FAIL', detail: `expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}` })
      }
    }
    if (FIX) rewrites.push({ from: m[1], to: newLines.join('\n') })
  }

  if (FIX && rewrites.length) {
    for (const r of rewrites) out = out.replace(r.from, r.to)
    if (out !== original) writeFileSync(file, out)
  }
}

rmSync(tmp, { recursive: true, force: true })

const by = s => results.filter(r => r.status === s)
for (const r of results) {
  if (r.status === 'PASS') continue
  console.log(`${r.status}  ${r.id}  ${r.expr}${r.detail ? `\n      ${r.detail}` : ''}`)
}
console.log(`\ndoc examples: ${by('PASS').length} pass, ${by('FIXED').length} fixed, ${by('FAIL').length} fail, ${by('ERROR').length} error`)
process.exit(by('FAIL').length + by('ERROR').length > 0 ? 1 : 0)
