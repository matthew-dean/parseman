import type { FoldedProgram, TableProgram } from './program.ts'
import { resolveTable } from './program.ts'
import { EMITTED_PARAMS, Unemittable, emitAssemblySource } from './emit-assembly.ts'
import { cfgKey, type RunCfg } from './assemble.ts'

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
  // A PLAIN OBJECT whose values are those primitives (or arrays of them)
  // round-trips exactly too, by the same criterion that admitted arrays above.
  // `withCtx(extra, …)` parks one here — `{ inFn: true }` and the like — and
  // refusing it made every withCtx-bearing grammar unemittable for no reason the
  // guard supports. Only a null-prototype-safe plain object qualifies: anything
  // with a class, a function value, or nesting beyond one array level refuses.
  if (
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof RegExp)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
    && Object.values(v).every(x =>
      x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
      || (Array.isArray(x) && x.every(y => y === null || typeof y === 'string' || typeof y === 'number' || typeof y === 'boolean')))
  ) {
    const entries = Object.entries(v).map(([key, val]) => `${jsString(key)}:${
      typeof val === 'string' ? jsString(val)
      : Array.isArray(val) ? `[${val.map(y => (typeof y === 'string' ? jsString(y) : JSON.stringify(y))).join(',')}]`
      : JSON.stringify(val)}`)
    return `{${entries.join(',')}}`
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
  if (t.alts !== undefined) {
    const alts = t.alts.map(a => `[${jsString(a[0])},${jsString(a[1])}]`).join(',')
    return `{arms:[],alts:[${alts}],min:${t.min ?? 1}}`
  }
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

/**
 * THE OPTION SETS A BUILD PRE-COMPILES, by default.
 *
 * `hostCst` and `trackLines` are ENCODE settings (`TableSettings`), so a program
 * already fixes them — a table encoded for `hostMode: 'ast'` has no CST rows to
 * select. `tolerant` is a per-CALL option (`run({ tolerant })`), so both answers
 * are live for one artifact and both are emitted.
 *
 * `coverage` is never emitted: `emitAssemblySource` refuses a coverage assembly
 * outright, so there is nothing to pre-compile and the closure engine is the
 * correct answer. `probe` (`completionsAt`) is not emitted by default either —
 * it is a language-service path, cold, and doubling every artifact for it is a
 * cost with no reader. Both fall to the closure engine, which is OBSERVABLE on
 * `Assembly.emitRefusal` rather than silent.
 *
 * Overgeneration is deliberate: an emitted variant nobody selects costs bytes
 * and zero runtime.
 */
export function defaultAssemblyCfgs(prog: TableProgram): RunCfg[] {
  const hostCst = prog.hostMode === 'cst'
  const trackLines = prog.lines === 1
  return [false, true].map(tolerant => ({
    hostCst, trackLines, tolerant, coverage: false, probe: false,
  }))
}

/**
 * Print the assemblies a build pre-compiled, as the `a:` field of the program
 * literal — see `TableProgram.asm`.
 *
 * THE FACTORY IS A REAL FUNCTION LITERAL. That is the whole point: `assemble.ts`
 * used to build the identical text at RUN TIME and hand it to `new Function`,
 * which a Content-Security-Policy without `unsafe-eval` forbids — so the two
 * shipped statements that a macro build is the CSP answer were false. Emitting
 * it here is not a new engine; it is the SAME emitter, called at the only time
 * the answer is actually a constant.
 *
 * A refusal is not an error. `Unemittable` names a construct the emitter does
 * not lower; that option set simply gets no entry, and `assemble.ts` runs the
 * closure engine for it and RECORDS why on `Assembly.emitRefusal`.
 */
function emitAssemblies(prog: TableProgram, cfgs: readonly RunCfg[]): string[] {
  /**
   * `a:[]` IS NOT `a` ABSENT, and the difference is the whole property.
   *
   * The field's PRESENCE is the artifact saying "a build produced me". That is
   * what switches the runtime `Function` constructor off (`assemble.ts`), and it
   * costs four bytes. Its CONTENTS are the assemblies the build chose to
   * pre-compile; with none, the artifact runs the closure engine — no eval, no
   * size growth, and the refusal readable on `Assembly.emitRefusal`.
   *
   * Pre-compiling is therefore a SPEED option, not a correctness one, and it is
   * priced: two assemblies take json's module from 1,382 B to 58,823 B (42.6x)
   * and css's from 8,987 B to 341,517 B (38.0x). That is the emitted engine's
   * source, which the runtime used to build with `new Function` on every load
   * instead of carrying. Defaulting it ON would hand back the 14x size win the
   * table lowering exists for, so the default is OFF and `defaultAssemblyCfgs`
   * is the one-liner for a consumer who wants emitted speed under a CSP.
   *
   * THE DEFAULT IS A MEASUREMENT, NOT A COMMITMENT. It rests on two numbers —
   * the size cost above, and the absence of a demonstrated speed gap the
   * pre-compiled path closes — and only the first of those is settled. A macro
   * artifact measured ~29% slower than `tableRules` over the same grammar
   * during 0.47 (36.0 vs 27.8 ms, 0/16 wins, -0.1% control, identical trees);
   * that is being diagnosed as an emitted-PROGRAM difference, not an engine
   * one, but if pre-compiling turns out to close it the default is an owner
   * decision to reopen. Do not harden this into a design rule.
   */
  if (cfgs.length === 0) return ['a:[],']
  const t = resolveTable(prog)
  // The scan pool and the scan-skip sets are linked from subtrees, so their
  // sites need emitted names too — same list `assemble.ts` builds.
  const extraIps: number[] = []
  for (const s of prog.scans ?? []) {
    for (const r of s.skip) extraIps.push(r[0])
    if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
  }
  for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])

  const out: string[] = []
  const seen = new Set<number>()
  for (const cfg of cfgs) {
    const key = cfgKey(cfg)
    if (seen.has(key)) continue
    seen.add(key)
    let em
    try {
      em = emitAssemblySource(t, prog, cfg, extraIps)
    } catch (e) {
      if (e instanceof Unemittable) continue
      throw e
    }
    const plan = em.plan
    out.push('{'
      + `key:${key},`
      + `factory:function(${EMITTED_PARAMS.join(',')}){${em.source}\n},`
      + 'plan:{'
      + `classes:[${plan.classes.map(r => `[${r.join(',')}]`).join(',')}],`
      + `armExpected:[${plan.armExpected.map(r => `[${r.join(',')}]`).join(',')}],`
      + `masks:[${plan.masks.join(',')}]`
      + '},'
      + `reached:[${[...em.reached].join(',')}]`
      + '}')
  }
  return [`a:[${out.join(',')}],`]
}

export type EmitOptions = {
  /** Name of the exported binding. */
  readonly name?: string
  /**
   * Optional experimental emitted factories — see `defaultAssemblyCfgs`.
   *
   * The normal compiler and macro both emit `a:[]`: that is the canonical
   * compact closure artifact and it never reaches the `Function` constructor.
   * Supplying factories here is a low-level serialization experiment, not a
   * second normal compilation path; it is not used by the macro plugin.
   */
  readonly assemblies?: readonly RunCfg[]
  /**
   * Sources for the author callbacks, in `prog.fns` order. A build has these
   * from the module it is lowering; pass `undefined` to emit a placeholder and
   * measure only the machinery.
   */
  readonly fnSources?: readonly string[]
  /** Import specifier for the shared driver. */
  readonly runtime?: string
  /**
   * NAME of the driver export to import from `runtime`, defaulting to the
   * shipped one.
   *
   * `runtime` alone was not enough to say which engine a module binds, and that
   * gap was load-bearing: `parseman/table` exports the ASSEMBLER as `tableRules`
   * while `src/table/exec.ts` exports the reference INTERPRETER under a name
   * that used to be identical. Pointing `runtime` at `exec.ts` therefore emitted
   * a module that read as the shipped artifact and ran the reference engine.
   * The reference export is now `execRules`, and a differential that wants it
   * has to SAY so here — which is the whole point of separating the names.
   */
  readonly runtimeRef?: string
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
function programFields(prog: TableProgram, fns: readonly string[], opts: EmitOptions = {}): string[] {
  return [
    ...emitAssemblies(prog, opts.assemblies ?? []),
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
    // Without this a recovery table's MODULE loads as a strict one: the extra
    // operands are still in `c`, but nothing selects the pieces that read them,
    // so a tolerant parse of the emitted artifact silently collects no errors.
    ...(prog.rec === 1 ? ['rv:1,'] : []),
    // The coverage DENOMINATOR travels with the counter rows or not at all. An
    // emitted module whose `c` stream holds `OP_COV` rows and whose `cv` pool went
    // missing has no ids to credit and no definitions to divide by — the
    // "no measurement reported as full coverage" shape, one hop downstream, which
    // is why `assemble` throws on that combination rather than counting nothing.
    ...(prog.cov === undefined ? [] : [`cv:[${prog.cov.map(([id, kind]) => `[${jsString(id)},${kind}]`).join(',')}],`]),
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
  const ref = opts.runtimeRef ?? 'tableRules'
  return [
    `import { ${ref} } from ${jsString(runtime)}`,
    `export const ${name} = /* @__PURE__ */ ${ref}({`,
    ...programFields(prog, fns, opts),
    `})`,
  ].join('\n')
}

export type ExpressionEmitOptions = EmitOptions & {
  /**
   * Which rule the expression evaluates to, or `null` for THE WHOLE RULE MAP.
   *
   * `null` is what a `rules()` call site needs: its initialiser evaluates to the
   * `{ name: fn, … }` object, exactly what `tableRules(…)` already returns, so
   * the map form is the expression WITHOUT the trailing index — not a second
   * emitter. `compileRuleMap`'s replacement has the same shape and the same
   * splice point, which is what makes the two lowerings interchangeable there.
   */
  readonly entry?: string | null
  /** Static metadata object passed to `tableRules` as its second argument. */
  readonly metadataSource?: string
}

/**
 * The table as an EXPRESSION rather than a module — for an inliner that replaces
 * a grammar's initialiser in place.
 *
 * It references `tableRules` by name instead of carrying the driver, so it is
 * not self-contained. That is deliberate and it is not a cost: the reference
 * resolves to `parseman/table`, a package the consumer already depends on for
 * `run()`. The alternative — inlining the driver per grammar — is precisely the
 * 2.10 MB that this lowering exists to replace with 0.56 MB.
 *
 * The caller owns the import. `emitTableModule` writes its own; an inliner
 * splicing this into existing source must ensure the binding is in scope.
 */
export function emitTableExpression(prog: TableProgram, opts: ExpressionEmitOptions = {}): string {
  assertPrintable(prog, 'emitTableExpression')
  const entry = opts.entry === undefined ? 'grammar' : opts.entry
  const ref = opts.runtimeRef ?? 'tableRules'
  const fns = opts.fnSources ?? prog.fns.map(() => '() => {}')
  const close = `}${opts.metadataSource === undefined ? '' : `,${opts.metadataSource}`})`
  return [
    `/* @__PURE__ */ ${ref}({`,
    ...programFields(prog, fns, opts),
    entry === null ? close : `${close}[${jsString(entry)}]`,
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
    `import { expandCompactFolded, tableVariants } from ${jsString(runtime)}`,
    `const _t = /* @__PURE__ */ expandCompactFolded({`,
    `b:{`,
    ...base,
    `},`,
    `v:{${variants.join(',')}}`,
    `})`,
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
