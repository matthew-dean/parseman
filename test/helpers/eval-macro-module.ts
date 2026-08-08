/**
 * THE one way a test evaluates a macro-emitted module.
 *
 * The TABLE lowering does not emit a self-contained artifact, and that is the
 * point: the module is `import { tableRules } from "parseman/table"` plus a data
 * literal. The recognition logic ships ONCE and every grammar contributes only
 * data, which is the entire reason the artifact is ~14x smaller than the source
 * lowering's. `new Function` cannot resolve an import, so a harness that pastes
 * macro output straight into `new Function` breaks the moment the macro emits a
 * table — which is exactly what happened to ~112 local harnesses across 44 files.
 *
 * The import is the ONLY external reference in the emitted module, so injecting
 * `tableRules` as a parameter is sufficient and keeps the tests loader-free.
 * Use this instead of writing a 113th local variant.
 *
 * NOTE ON WHAT THIS IS FOR: this evaluates macro output to test BEHAVIOUR (the
 * grammar lowered, the result parses, the transform fired, IDs are stable). A
 * test that asserts generated SOURCE TEXT is a codegen test and must import
 * `compile` / `compileRuleMap` from `src/compiler/codegen.ts` directly rather
 * than reach the source lowering through the macro — see the header of
 * `test/unit/macro-grammar-coverage.test.ts` for that ruling written out.
 */
import { tableRules } from '../../src/table/index.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import type { TableProgram } from '../../src/table/program.ts'

/** Strip the module framing `new Function` cannot parse, leaving a function body. */
function toFunctionBody(code: string): string {
  return code
    .replace(/^[ \t]*import\b[^\n]*\n/gm, '')
    .replace(/^[ \t]*export[ \t]*\{[^}]*\}[^\n]*\n?/gm, '')
    .replace(/^[ \t]*export[ \t]+(?=(?:const|let|var|function|class|async)\b)/gm, '')
}

/**
 * Evaluate macro output and return `want` — an expression in the module's own
 * scope, e.g. `'parser'`, `'grammar'`, or `'{ Call, CstOuter }'`.
 *
 * `bindings` supplies any identifier the grammar source referenced from outside
 * (a base grammar, a node factory, an imported reducer). `tableRules` is always
 * in scope and never needs to be passed.
 */
export function evalMacroModule<T>(code: string, want: string, bindings: Record<string, unknown> = {}): T {
  const extra = Object.keys(bindings).filter(n => n !== 'tableRules')
  const names = ['tableRules', ...extra]
  // A SUPPLIED `tableRules` WINS. It still never NEEDS to be passed — the default
  // is the real driver — but a harness that passes one is asking to see the
  // program the macro printed, which is the only way to compare artifacts rather
  // than parse results. Ignoring it silently handed such a harness the real
  // driver and a capture list that stayed empty, which reads as "the macro
  // emitted no table" rather than as a harness that did not take effect.
  const driver = 'tableRules' in bindings ? bindings['tableRules'] : tableRules
  const values: unknown[] = [driver, ...extra.map(n => bindings[n])]
  const fn = new Function(...names, `${toFunctionBody(code)}\nreturn (${want})`) as (...args: unknown[]) => T
  return fn(...values)
}

/**
 * Evaluate macro output and return every top-level `export const` it declares,
 * keyed by name — the module-object form, for harnesses that consumed several
 * exports at once.
 */
export function evalMacroExports(code: string, bindings: Record<string, unknown> = {}): Record<string, unknown> {
  const names = [...code.matchAll(/^[ \t]*export[ \t]+(?:const|let|var|function)[ \t]+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  return evalMacroModule<Record<string, unknown>>(code, `{ ${names.join(', ')} }`, bindings)
}

/**
 * True when the macro actually compiled the grammar away.
 *
 * The old proxy for this — "no `import` line survives" — is no longer valid:
 * a table artifact legitimately keeps `import { tableRules } from "parseman/table"`.
 * What must be gone is the COMBINATOR import, i.e. the package index.
 */
export function macroImportRemoved(code: string): boolean {
  return !/^[ \t]*import\b[^\n]*from\s*['"]parseman['"]/m.test(code)
}

/** Throwing form, for harnesses that used the removal check as a compile guard. */
export function assertMacroCompiled(code: string): string {
  if (!macroImportRemoved(code)) throw new Error('macro transform did not remove the parseman import')
  return code
}

/**
 * Is `code` a COMPILED artifact for `rule`, rather than a re-spelled runtime call?
 *
 * The old proxy for this was a codegen spelling — `function _r_<Name>(input, …)`.
 * That is a property of the SOURCE lowering, so it stopped answering the question
 * the moment the macro emitted a table. This asks the artifact-neutral version:
 * the rule is present in a lowered form, either as codegen's canonical rule
 * function or as a key in a table's rule-offset map.
 */
export function isCompiledRule(code: string, rule: string): boolean {
  return new RegExp(`function _r_${rule}\\(`).test(code)
    || (/\btableRules\(/.test(code) && new RegExp(`"${rule}"\\s*:`).test(code))
}

/**
 * Does a TABLE artifact keep the trivia / state capture tiers?
 *
 * The capture-tier contract used to be read off codegen spellings — `_raw12 = []`,
 * `_EMPTY_TL`, a literal `undefined` in the builder call. Those are properties of
 * the SOURCE lowering, so once the macro emitted a table every such regex answered
 * "no capture" for every artifact and the whole cost contract stopped being checked
 * without a single test going red.
 *
 * The table states the same decision as bits on the node row —
 * `[OP_NODE, fnIdx, child, flags, project, type, tags]`, flags bit 4 = trivia,
 * bit 8 = state. A confirmed low-arity reducer clears them; an undecidable one
 * (rest parameter, unresolvable import, reassigned binding) must fail OPEN and
 * keep them. That is the property, in the artifact's own vocabulary.
 *
 * Requires exactly one `node()` in the grammar, which every harness using this has,
 * and THROWS rather than guessing otherwise — a probe that silently picks a row is
 * how the codegen version went dead.
 */
const OP_NODE = 10
const OP_NODE_TRACK = 19
const TAIL_CAPTURE_BITS = 4 | 8

export function tableKeepsTailCapture(code: string): boolean {
  const cm = /\bc:\[([-\d,]+)\]/.exec(code)
  const rm = /\br:(\{[^}]*\})/.exec(code)
  if (!cm || !rm) throw new Error('no table program in the emitted artifact — did the grammar fail to lower?')
  const prog = {
    code: cm[1]!.split(',').map(Number),
    rules: JSON.parse(rm[1]!) as Record<string, number>,
    k: [], fns: [], cc: [], fx: [], disp: [], dsp: [], trivia: [],
  } as unknown as TableProgram
  // REACHABILITY, not a scan for the opcode's numeric value. Operands are ordinary
  // integers and collide with opcodes — a raw `indexOf(10)` finds child pointers and
  // flag words as readily as node rows, which is exactly the "confident nonsense"
  // `inspect.ts` was written to avoid. This decodes instruction widths from the rule
  // entries, so a row is a row.
  const rows = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NODE || prog.code[ip] === OP_NODE_TRACK)
  if (rows.length !== 1) throw new Error(`expected exactly one node row, found ${rows.length}`)
  return (prog.code[rows[0]! + 3]! & TAIL_CAPTURE_BITS) !== 0
}
