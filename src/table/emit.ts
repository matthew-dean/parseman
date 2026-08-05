import type { FoldedProgram, TableProgram } from './program.ts'

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

function emitTriviaSpec(t: import('./program.ts').TriviaSpec): string {
  if (t.plain !== undefined) return `{arms:[],plain:[${jsString(t.plain[0])},${jsString(t.plain[1])}]}`
  return `{arms:[${t.arms.map(a => `[${jsString(a[0])},${jsString(a[1])},${jsString(a[2])}]`).join(',')}]}`
}

function emitRef(r: import('./program.ts').SubtreeRef): string {
  return `[${r[0]},${r[1]}]`
}

function emitScanSpec(s: import('./program.ts').ScanSpec): string {
  const parts = [`kind:${s.kind}`, `flags:${s.flags}`, `skip:[${s.skip.map(emitRef).join(',')}]`]
  if (s.sentinel !== undefined) parts.push(`sentinel:${emitRef(s.sentinel)}`)
  if (s.sent !== undefined) parts.push(`sent:${s.sent === null ? 'null' : jsString(s.sent)}`)
  if (s.open !== undefined) parts.push(`open:${jsString(s.open)}`)
  if (s.close !== undefined) parts.push(`close:${jsString(s.close)}`)
  return `{${parts.join(',')}}`
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

/** Refuse a program the printer cannot express, naming the CONSTRUCT. */
function assertPrintable(prog: TableProgram, who: string): void {
  // Fail with the CONSTRUCT, not with a type name from inside the printer.
  // Every one of these is expressible as data and simply not expressed yet, so
  // the message says which one to go and lower.
  if (prog.runtimeOnly !== undefined && prog.runtimeOnly.length > 0) {
    throw new TypeError(
      `${who}: this grammar is RUNTIME-ONLY — it parses correctly but cannot be `
      + `printed as a module. Unlowered constructs: ${prog.runtimeOnly.join(', ')}. `
      + `Each parks a live combinator in the const pool; each is expressible as table rows.`,
    )
  }
}

/**
 * The program's fields as `key:value,` lines — the body of the object literal
 * `tableRules` reads. Shared with the folded emitter, which prints exactly these
 * for its ONE base table.
 */
function programFields(prog: TableProgram, fns: readonly string[]): string[] {
  return [
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
    ...(prog.triviaSpecs === undefined ? [] : [`tv:[${prog.triviaSpecs.map(emitTriviaSpec).join(',')}],`]),
    ...(prog.scans === undefined ? [] : [`sc:[${prog.scans.map(emitScanSpec).join(',')}],`]),
    // Both halves or neither: `scanSkipOf` without `scanSkip` installs nothing,
    // and `scanSkip` without `scanSkipOf` installs it nowhere. Either way the
    // module parses and silently skips a different set than the table it came
    // from — the failure shape this lowering exists to remove.
    ...(prog.scanSkip === undefined ? [] : [
      `ss:[${prog.scanSkip.map(set => `[${set.map(emitRef).join(',')}]`).join(',')}],`,
      `so:[${(prog.scanSkipOf ?? []).join(',')}],`,
    ]),
    `f:[${fns.join(',')}]`,
  ]
}

export function emitTableModule(prog: TableProgram, opts: EmitOptions = {}): string {
  assertPrintable(prog, 'emitTableModule')
  const name = opts.name ?? 'grammar'
  const runtime = opts.runtime ?? 'parseman/table'
  const fns = opts.fnSources ?? prog.fns.map(() => '() => {}')
  return [
    `import { tableRules } from ${jsString(runtime)}`,
    `export const ${name} = /* @__PURE__ */ tableRules({`,
    ...programFields(prog, fns),
    `})`,
  ].join('\n')
}

export type FoldedEmitOptions = EmitOptions & {
  /**
   * Exported binding per variant name. A variant with no entry is still carried
   * in the table and simply not given a name of its own.
   */
  readonly names?: Readonly<Record<string, string>>
}

/**
 * Print a FOLDED program: one base table, plus the row edits per variant.
 *
 * This is G4's deliverable. The four `trackLines` x `hostMode` artifacts a
 * dialect ships stop being four near-copies of one table and become one table
 * and three short lists of `(offset, word)` pairs — which is what the measured
 * difference between them actually is. The reducer pool, the const pool, the
 * char classes, the expected sets, the dispatch tables and the rule index are
 * printed ONCE, because they are byte-identical in every variant.
 *
 * The base's own `l`/`h` scalars are NOT printed: every variant, base included,
 * carries its own on its delta, so no variant inherits the base's line-tracking
 * or host mode by accident.
 */
export function emitFoldedModule(folded: FoldedProgram, opts: FoldedEmitOptions = {}): string {
  assertPrintable(folded.base, 'emitFoldedModule')
  const runtime = opts.runtime ?? 'parseman/table'
  const fns = opts.fnSources ?? folded.base.fns.map(() => '() => {}')
  const base = programFields(folded.base, fns).filter(l => !l.startsWith('l:') && !l.startsWith('h:'))
  const variants = Object.keys(folded.variants).map(n => {
    const d = folded.variants[n]!
    const parts = [
      ...(d.at.length === 0 ? [] : [`a:[${d.at.join(',')}]`, `t:[${d.to.join(',')}]`]),
      ...(d.lines === undefined ? [] : [`l:${d.lines}`]),
      ...(d.hostMode === undefined ? [] : [`h:${jsString(d.hostMode)}`]),
    ]
    return `${jsString(n)}:{${parts.join(',')}}`
  })
  const names = opts.names ?? {}
  return [
    `import { tableVariants } from ${jsString(runtime)}`,
    `const _t = {`,
    `b:{`,
    ...base,
    `},`,
    `v:{${variants.join(',')}}`,
    `}`,
    ...Object.keys(names).map(n =>
      `export const ${names[n]!} = /* @__PURE__ */ tableVariants(_t, ${jsString(n)})`),
  ].join('\n')
}

/**
 * The part of the emitted module that is MACHINERY — the table, excluding the
 * author's reducers, which every lowering must emit alike. This is the number
 * that is comparable to codegen's per-rule cost.
 */
export function emitTableOnly(prog: TableProgram): string {
  return emitTableModule(prog, { fnSources: [] })
}
