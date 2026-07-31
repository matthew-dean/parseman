/**
 * MODULE-LEVEL HOIST OF BYTE-IDENTICAL FUSED DECLARATIONS
 * ======================================================
 *
 * Every `compose()` / `composeLeaf()` in a module lowers to its OWN self-contained
 * IIFE (`emitFusedSource` → `/* @__PURE__ *​/ (() => { … })()`). A module that
 * publishes N variants of one grammar — the jess shape: shared recognition pieces
 * plus N leaves differing only in `hostMode` / `trackLines` — therefore emits the
 * recognition piece's rule functions N times, under the SAME namespaced names,
 * in N sibling scopes. The namespace is content-addressed, so those N copies are
 * byte-identical: `probe/variants-4` emits 5 `_r_` rule functions, four of which
 * have exactly one distinct body across all four IIFEs.
 *
 * Measured on the committed size probe (bench/size/probe.ts), byte-identical
 * declaration text available for dedup:
 *
 *   probe/variants-2   41,446 B generated   9,557 B duplicated (23.1%)
 *   probe/variants-4   82,058 B generated  29,286 B duplicated (35.7%)
 *
 * This module collects the top-level declarations of every fused IIFE in one
 * module, decides which are safe to emit ONCE at module scope, and rewrites each
 * IIFE to drop its copy.
 *
 * THE CORRECTNESS PROBLEM, AND WHY THE DECISION IS KEYED ON THE NAME
 * -----------------------------------------------------------------
 * `_pfFail` is an identity sentinel: a rule function signals failure by returning
 * it and every caller tests `v === _pfFail`. Each IIFE declares its own
 * `const _pfFail = {}`, so today the producer and the consumer are always the same
 * object. A PARTIAL hoist breaks that: if some scopes read the module-level
 * sentinel while others keep a local one, a rule that FAILED returns object A and
 * its caller compares against object B — the test is false, and the failure is
 * read as a SUCCESS carrying the value `{}`. Silent wrong output, the worst class
 * of bug this compiler can have.
 *
 * So the hoist decision is made per DECLARED NAME, not per occurrence:
 *
 *   a name is hoistable only if EVERY declaration of that name anywhere in the
 *   module is byte-identical,
 *
 * and when it is, EVERY occurrence is removed and one copy is emitted at module
 * scope. A mixed state is unrepresentable: there is no code path that removes one
 * occurrence and keeps another. If two scopes ever disagreed about `_pfFail`'s
 * text, the name would have two distinct texts, would fail the uniformity test,
 * and NO scope would hoist it. `test/unit/module-hoist.test.ts` asserts both
 * directions.
 *
 * `_pfEnd` (`let _pfEnd`) is a single-slot out-parameter and is safe to share
 * unconditionally: the write is the last statement before a rule function returns
 * (src/compiler/codegen.ts, `pushNamedFnDecl` — `_pfEnd = <end>` immediately
 * precedes `return <value>`) and the read is the next statement at the call site
 * (`emitNamedFnCall` — `const _pfe = _pfEnd` immediately follows the sentinel
 * test). Nothing user-controlled runs between the write and the read, so even a
 * builder that re-enters another grammar cannot observe a stale slot: the nested
 * parse completes entirely before the outer write.
 *
 * FREE-VARIABLE FIXPOINT
 * ----------------------
 * A hoisted declaration must not reference anything that stayed IIFE-local. Every
 * top-level name of every IIFE is known here (the declarations ARE the input), so
 * a hoisted text is rejected if it mentions any name that is not itself hoisted,
 * iterated to a fixpoint. Reference detection is a `\bNAME\b` scan over the
 * declaration text: that over-approximates (it also matches inside strings and
 * comments), and over-approximation is the safe direction — it only ever blocks a
 * hoist, never permits an unsound one.
 *
 * This also disposes of the un-namespaced `_wcf<N>` hazard. `withCtx` names its
 * wrapper `_wcf${namedParsers.size}` with no namespace prefix, so two different
 * artifacts can both declare `_wcf0` with DIFFERENT bodies. Such a name has two
 * distinct texts, so it is not hoistable, and by the fixpoint nothing that
 * references it is hoistable either.
 *
 * SCOPE
 * -----
 * Hoisting is sound only because every macro replacement is made from the
 * plugin's top-level `for (const stmt of body)` loop — the call sites are all
 * module-level statements, so an IIFE's free variables can only resolve to
 * module-level bindings, which are still in scope at module level. The prelude is
 * inserted at the START of the earliest top-level statement that carries a
 * replacement, which is never earlier than the earliest IIFE, so no binding those
 * declarations already depended on moves out of scope.
 */

/** Placeholder emitted in place of a claimed declaration, resolved by `finalize`. */
const marker = (id: number): string => `/*@pmh:${id}@*/`

/** Matches a marker plus the newline that separated it from the next declaration,
 *  so a hoisted declaration leaves no blank line behind. */
const MARKER_RE = /\/\*@pmh:(\d+)@\*\/\n?/g

/** Non-global marker test, for asking whether a generated replacement claimed any
 *  declarations (a `/g` regex would carry `lastIndex` between calls). */
export const HOIST_MARKER_PROBE = /\/\*@pmh:\d+@\*\//

/** Top-level declaration heads. Every entry `fusedBody` produces starts at column
 *  0 with one of these; `LINE_SPAN_DECL` declares two, hence the per-line scan. */
const DECL_RE = /^(?:const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/

/** Names that exist in the IIFE but never in `lines`, so they can never be
 *  hoisted and must never be mistaken for module-level. `_map`/`_k` are declared
 *  by the fused body's tail; `_env` is the runtime-callback parameter. */
const ALWAYS_LOCAL: ReadonlySet<string> = new Set(['_map', '_k', '_env'])

/** The names a generated top-level declaration binds. */
export function declaredNames(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = DECL_RE.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

export type HoistResult = {
  /** Declarations to emit ONCE at module scope, in first-claim order. Empty when
   *  nothing qualified. Ends with a newline when non-empty. */
  prelude: string
  /** Replace every marker in a generated source string with either nothing (the
   *  declaration was hoisted) or its original text (it was not). */
  resolve(src: string): string
  /** Diagnostics: bytes removed from the IIFEs, minus the bytes re-emitted once. */
  savedBytes: number
  /** Names emitted at module scope. */
  hoistedNames: string[]
}

export type ModuleHoist = {
  /** Register one fused IIFE's top-level declarations; returns the marker lines to
   *  emit in their place. */
  claim(decls: readonly string[]): string[]
  finalize(): HoistResult
}

export function createModuleHoist(): ModuleHoist {
  const texts: string[] = []

  const claim = (decls: readonly string[]): string[] =>
    decls.map(text => {
      const id = texts.length
      texts.push(text)
      return marker(id)
    })

  const finalize = (): HoistResult => {
    // name → the distinct declaration texts that bind it, across the whole module.
    const nameTexts = new Map<string, Set<string>>()
    // text → how many IIFEs emitted exactly this text.
    const textCount = new Map<string, number>()
    const textNames = new Map<string, string[]>()
    const order: string[] = []
    for (const text of texts) {
      const seen = textCount.get(text)
      textCount.set(text, (seen ?? 0) + 1)
      if (seen === undefined) {
        order.push(text)
        const names = declaredNames(text)
        textNames.set(text, names)
        for (const n of names) {
          const s = nameTexts.get(n)
          if (s) s.add(text)
          else nameTexts.set(n, new Set([text]))
        }
      }
    }

    // A text qualifies when it is duplicated AND every name it binds is bound by
    // that one text everywhere in the module. The uniformity test is what makes a
    // partial `_pfFail` hoist unrepresentable — see the header.
    const hoisted = new Set(
      order.filter(text =>
        (textCount.get(text) ?? 0) >= 2
        && textNames.get(text)!.length > 0
        && textNames.get(text)!.every(n => !ALWAYS_LOCAL.has(n) && nameTexts.get(n)!.size === 1),
      ),
    )

    // Fixpoint: drop any hoisted text that mentions a name which stayed local.
    for (;;) {
      const localNames: string[] = []
      for (const [n, ts] of nameTexts) {
        if (ts.size !== 1 || !hoisted.has([...ts][0]!)) localNames.push(n)
      }
      let changed = false
      // The spread is load-bearing, not the redundant one oxlint flags: the loop
      // DELETES from `hoisted`, so it must iterate a snapshot.
      for (const text of [...hoisted]) {
        if (localNames.some(n => new RegExp(`\\b${escapeName(n)}\\b`).test(text))) {
          hoisted.delete(text)
          changed = true
        }
      }
      if (!changed) break
    }

    const preludeTexts = order.filter(t => hoisted.has(t))
    const prelude = preludeTexts.length === 0 ? '' : `${preludeTexts.join('\n')}\n`
    const removed = texts.reduce((n, t) => (hoisted.has(t) ? n + t.length + 1 : n), 0)

    return {
      prelude,
      savedBytes: removed - prelude.length,
      hoistedNames: preludeTexts.flatMap(t => textNames.get(t)!),
      resolve: (src: string): string =>
        src.replace(MARKER_RE, (m, idStr: string) => {
          const text = texts[Number(idStr)]
          // A marker with no claim behind it means the caller mixed hoists from two
          // modules; refusing to guess is the only safe move.
          if (text === undefined) throw new Error(`parseman: unknown hoist marker ${m}`)
          if (hoisted.has(text)) return ''
          return m.endsWith('\n') ? `${text}\n` : text
        }),
    }
  }

  return { claim, finalize }
}

/** Generated names are plain identifiers; `$` is the only regex metacharacter
 *  JS identifiers admit. */
function escapeName(n: string): string {
  return n.replace(/\$/g, '\\$')
}
