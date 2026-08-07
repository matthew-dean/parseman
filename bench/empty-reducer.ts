/**
 * A PRINTED ARTIFACT MAY NEVER CONTAIN AN EMPTY REDUCER.
 *
 * `src/table/emit.ts` still carries `opts.fnSources ?? prog.fns.map(() => '() => {}')`
 * at three sites. That fallback is legitimate for `emitTableOnly()`, which is
 * measuring machinery on purpose — and it is a silent catastrophe anywhere else:
 * `compile` used to reach it for every author callback, and the module it
 * printed loaded, parsed, reported `ok`, and returned `undefined` where both
 * other engines returned a tree. Nothing failed. Nothing warned.
 *
 * The reason this lives here, next to the size gate, rather than only in
 * `test/unit/table-compile.test.ts` where the property was first pinned: a
 * BYTES-ONLY gate reads a hollow artifact as an improvement and banks it. The
 * stub pool is *smaller* than real reducer text, so the incident arrived at the
 * size guard wearing the exact costume the guard exists to reward — and the
 * ceilings were re-cut against it. One shared definition, imported by the test
 * that states the property and by every gate that records a byte count, is what
 * stops the size half and the correctness half from drifting apart again.
 *
 * WHY A TEXT SCAN AND NOT A STRUCTURAL ONE. The pool is printed as `f:[…]`
 * inside one object literal, and reducer bodies contain brackets, braces and
 * string literals — so isolating the array means writing a parser to check the
 * output of a compiler. Scanning the whole artifact is a strict SUPERSET of
 * scanning the pool: no other part of an emitted module contains an arrow with
 * an empty body, verified across all 24 gated fixtures (8 examples through
 * `compile()`, 16 probe units through `transformMacro`), every one of which
 * scans clean.
 *
 * A grammar with NO reducers cannot false-positive: its pool is `f:[]` and the
 * artifact contains no arrow at all. So the qualifier "when the grammar has
 * reducers" needs no separate reducer count to enforce — an empty arrow in the
 * text IS the evidence that a reducer was dropped.
 */

/**
 * Matches a zero-argument or single-identifier arrow with an empty body.
 *
 * Deliberately NOT global: a `/g/` regex carries `lastIndex` across calls, so a
 * shared one would make `test()` alternate true/false on the same input. The
 * counting helper below makes its own global copy.
 */
export const EMPTY_ARROW = /(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}/

/** Every empty-bodied arrow in `text`, as matched source. Empty when clean. */
export function emptyReducersIn(text: string): string[] {
  return text.match(new RegExp(EMPTY_ARROW.source, 'g')) ?? []
}

/**
 * The failure message, shared so both gates say the same thing.
 *
 * Names the count, the sites, and the ONLY two legal outcomes — real reducer
 * text, or a refusal by name through `runtimeOnly`. "Emit a placeholder" is not
 * among them outside `emitTableOnly()`.
 */
export function emptyReducerReport(id: string, stubs: readonly string[]): string {
  return (
    `fixture ${id}: the printed artifact contains ${stubs.length} EMPTY REDUCER(S) — ${stubs.slice(0, 4).join(', ')}${stubs.length > 4 ? ', …' : ''}\n`
    + '  This is a HOLLOW artifact: it loads, parses, reports `ok`, and returns `undefined`\n'
    + '  where the other engines return a tree. Its byte count is meaningless and MUST NOT be\n'
    + '  recorded — the stub pool is smaller than real reducer text, so a bytes-only gate reads\n'
    + '  the defect as an improvement and ceilings the tree against it. That already happened.\n'
    + '  → A lowering that cannot source a reducer must REFUSE BY NAME through `runtimeOnly`,\n'
    + '    never substitute `() => {}`. See src/table/emit.ts and the property pinned in\n'
    + '    test/unit/table-compile.test.ts.'
  )
}
