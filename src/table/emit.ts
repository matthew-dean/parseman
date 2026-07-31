import type { TableProgram } from './program.ts'

/**
 * Print a program as the module a build emits.
 *
 * Everything here is DATA plus the author's own reducers. The recognizer is not
 * in this string — it is `exec.ts`, imported from the runtime, shared by every
 * grammar in the bundle and by every variant of each.
 */

function jsString(s: string): string {
  return JSON.stringify(s)
}

function emitConst(v: unknown): string {
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`
  if (typeof v === 'string') return jsString(v)
  return JSON.stringify(v)
}

export type EmitOptions = {
  /** Name of the exported binding. */
  readonly name?: string
  /**
   * Sources for the author callbacks, in `prog.fns` order. A build has these
   * from the module it is lowering; pass `undefined` to emit a placeholder and
   * measure only the machinery.
   */
  readonly fnSources?: readonly string[]
  /** Import specifier for the shared driver. */
  readonly runtime?: string
}

export function emitTableModule(prog: TableProgram, opts: EmitOptions = {}): string {
  const name = opts.name ?? 'grammar'
  const runtime = opts.runtime ?? 'parseman/table'
  const fns = opts.fnSources ?? prog.fns.map(() => '() => {}')
  const lines = [
    `import { tableRules } from ${jsString(runtime)}`,
    `export const ${name} = /* @__PURE__ */ tableRules({`,
    `c:[${prog.code.join(',')}],`,
    `k:[${prog.k.map(emitConst).join(',')}],`,
    `x:[${prog.cc.map(jsString).join(',')}],`,
    `e:[${prog.fx.map(f => `[${f.map(jsString).join(',')}]`).join(',')}],`,
    `d:[${prog.disp.map(a => `[${a.join(',')}]`).join(',')}],`,
    `r:${JSON.stringify(prog.rules)},`,
    ...(prog.lines === 1 ? ['l:1,'] : []),
    `f:[${fns.join(',')}]`,
    `})`,
  ]
  return lines.join('\n')
}

/**
 * The part of the emitted module that is MACHINERY — the table, excluding the
 * author's reducers, which every lowering must emit alike. This is the number
 * that is comparable to codegen's per-rule cost.
 */
export function emitTableOnly(prog: TableProgram): string {
  return emitTableModule(prog, { fnSources: [] })
}
