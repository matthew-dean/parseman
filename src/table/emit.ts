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

/**
 * Serialise one const-pool entry, or REFUSE it.
 *
 * The fallthrough was `JSON.stringify(v)`, which returns the VALUE `undefined`
 * — not a string — for a function, a symbol, or `undefined` itself. Template
 * interpolation then wrote the text `undefined` into the module, producing an
 * artifact that loads and misbehaves rather than one that fails to build. A
 * combinator object reaching here would emit `{}` for the same reason.
 *
 * Fail closed: the pool must only ever hold what the driver can read back.
 */
function emitConst(v: unknown): string {
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`
  if (typeof v === 'string') return jsString(v)
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v)
  // An ARRAY of those primitives round-trips exactly, so it belongs on the
  // accept side of this guard rather than the refuse side. `node(tags)` parks a
  // `readonly string[]` in the pool and the host reads it as its 8th argument;
  // refusing it made every tags-bearing grammar unemittable for no reason the
  // guard's own criterion supports. Nested arrays and objects still refuse.
  if (Array.isArray(v) && v.every(x => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
    return `[${v.map(x => (typeof x === 'string' ? jsString(x) : JSON.stringify(x))).join(',')}]`
  }
  const shown = typeof v === 'object' ? Object.prototype.toString.call(v) : typeof v
  throw new TypeError(
    `emitConst: cannot serialise a const-pool entry of type ${shown}. ` +
      'Only strings, numbers, booleans, null and RegExp round-trip through the emitted module; ' +
      'anything else must be carried in prog.fns or refused at encode time.',
  )
}

function emitDispatchSpec(d: import('./program.ts').DispatchSpec): string {
  return '{'
    + `key:[${d.key.map(jsString).join(',')}],`
    + `keyArm:[${d.keyArm.join(',')}],`
    + `fold:[${d.fold.map(jsString).join(',')}],`
    + `foldArm:[${d.foldArm.join(',')}],`
    + `match:[${d.match.map(m => `[${m[0]},${jsString(m[1])},${jsString(m[2])},${m[3]}]`).join(',')}],`
    + `routed:[${d.routed.join(',')}],`
    + `expected:[${d.expected.map(jsString).join(',')}]`
    + '}'
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
  // Fail with the CONSTRUCT, not with a type name from inside the printer.
  // Every one of these is expressible as data and simply not expressed yet, so
  // the message says which one to go and lower.
  if (prog.runtimeOnly !== undefined && prog.runtimeOnly.length > 0) {
    throw new TypeError(
      `emitTableModule: this grammar is RUNTIME-ONLY — it parses correctly but cannot be `
      + `printed as a module. Unlowered constructs: ${prog.runtimeOnly.join(', ')}. `
      + `Each parks a live combinator in the const pool; each is expressible as table rows.`,
    )
  }
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
    // EVERY FIELD `expandCompact` READS MUST BE WRITTEN HERE. `p`/`lb`/`rc`
    // were read but never emitted: a dispatching grammar's module threw
    // "Cannot read properties of undefined (reading 'byKey')" on every input,
    // and a labelled-trivia grammar's entries carried no `_meta`, so
    // `run({ rootTrivia })` rejected a grammar that plainly has labels — the
    // exact failure the root-trivia work exists to prevent, one hop downstream.
    ...(prog.dsp.length === 0 ? [] : [`p:[${prog.dsp.map(emitDispatchSpec).join(',')}],`]),
    ...(prog.labels === undefined ? [] : [`lb:[${prog.labels.map(jsString).join(',')}],`]),
    ...(prog.classified === 1 ? ['rc:1,'] : []),
    ...(prog.hostMode === undefined ? [] : [`h:${jsString(prog.hostMode)},`]),
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
