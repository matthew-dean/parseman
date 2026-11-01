/**
 * THE PLANT CATALOGUE — one real defect per entry, as a textual edit to the
 * implementation path the registered differential claims to exercise.
 *
 * `scripts/check-differentials.mjs` applies one of these, runs the differentials
 * registered against it, and restores. A registered differential that does not
 * MOVE under its plant is a differential that cannot fail, and that is the whole
 * finding — see docs/design/differential-gates.md.
 *
 * WHY TEXTUAL EDITS TO REAL IMPLEMENTATION CODE, and not a mock or an injected hook.
 *
 * A hook proves the hook fires. The claim under test is that the harness, run
 * exactly as a lane runs it, notices a change to the engine it names — so the
 * change has to be in the engine. `bench/jess/hooks.mjs` short-circuits every
 * `.ts` load with `shortCircuit: true`, so a downstream loader hook never sees
 * those modules at all; patch-and-restore is the mechanism that works for every
 * harness here without any of them being modified to be testable.
 *
 * WHY AN ANCHOR THAT VANISHES IS A HARD FAILURE. `find` is matched exactly and
 * must occur exactly once. When a refactor moves it the gate stops with
 * "anchor not found", which forces the plant to be re-derived against the code
 * as it now is. The alternative — a fuzzy match, or a skip — silently converts
 * this gate into the thing it exists to detect.
 *
 * EACH PLANT MUST BE OBSERVABLE, NOT CATASTROPHIC. A plant that makes every
 * parse throw proves nothing: "both legs threw" is vacuity mode V2. These move a
 * span by one, narrow a character class by one code point, cap a repetition, or
 * turn off recovery — each is the shape of a defect this repo has actually
 * shipped, and each leaves the engine running.
 */

/**
 * @typedef {object} Defect
 * @property {string} why           what real defect class this imitates
 * @property {Array<{file: string, find: string, replace: string}>} edits
 */

/** @type {Record<string, Defect>} */
export const DEFECTS = {
  /**
   * The emitted table engine puts every node's span one byte to the right.
   *
   * The defect class: a lowering that parses identically and produces a
   * different TREE. Every table defect found during the 0.47 cycle was of this
   * shape — the parse succeeded, consumed every byte, and only the tree moved.
   * `consumed`-style instruments are blind to it by construction, which is why
   * the identity sweeps digest the whole `RunResult` and not just `ok`.
   */
  'emit-node-span': {
    why: 'emitted table engine: every node span starts one byte late',
    edits: [{
      file: 'src/table/emit-assembly.ts',
      find: "const span=${tracked ? 'spanLines(ctx,pos,end)' : '{start:pos,end}'}",
      replace: "const span=${tracked ? 'spanLines(ctx,pos,end)' : '{start:pos+1,end}'}",
    }],
  },

  /**
   * The reference table driver (`exec.ts`) does the same thing.
   *
   * Separate from `emit-node-span` on purpose: `tableRules` is what ships and
   * `execRules` is what a divergence gets bisected against, and a sweep that
   * imported one while claiming the other is exactly how `bench/table-lowering-identity.ts`
   * spent a release gating a driver nothing ships. Two plants, one per driver, is
   * how that stays visible.
   */
  'exec-node-span': {
    why: 'reference table driver: every node span starts one byte late',
    edits: [{
      file: 'src/table/exec.ts',
      find: 'const span = code[ip] === OP_NODE_TRACK ? spanLines(ctx, pos, end) : { start: pos, end }',
      replace: 'const span = code[ip] === OP_NODE_TRACK ? spanLines(ctx, pos, end) : { start: pos + 1, end }',
    }],
  },

  /**
   * A lowered character class loses its last code point.
   *
   * The defect class: the straight-line scan `scan-shapes.ts` emits in place of a
   * sticky `RegExp.exec` disagrees with the regex at some position the grammar
   * happens never to drive it to. An end-to-end sweep can miss that for as long
   * as no corpus file asks the hard question; the per-position oracle cannot.
   */
  'scan-class-narrow': {
    why: 'emitted scan shape: character-class upper bound short by one',
    edits: [{
      file: 'src/table/scan-shapes.ts',
      find: '(lo === hi ? `${cVar} === ${lo}` : `(${cVar} >= ${lo} && ${cVar} <= ${hi})`)',
      replace: '(lo === hi ? `${cVar} === ${lo}` : `(${cVar} >= ${lo} && ${cVar} <= ${hi - 1})`)',
    }],
  },

  /**
   * The interpreter's `many()` stops after three items.
   *
   * The defect class this project calls its worst: the parse STOPS EARLY, returns
   * `ok: true`, throws nothing, and every test stays green. jess's Less grammar
   * did exactly this at 0.47 — 73117 of `benchmark.less`'s 106802 bytes — while
   * the timing harness reported the shortfall as a speedup.
   */
  'interp-many-cap': {
    why: 'interpreter: many() silently stops after 3 items — a short parse that still reports ok',
    edits: [{
      file: 'src/combinators/repeat.ts',
      find: '      let count = 0\n      while (cur < input.length) {\n        if (count >= max) break',
      replace: '      let count = 0\n      while (cur < input.length) {\n        if (count >= max || count >= 3) break',
    }],
  },

  /**
   * Recovery is not lowered into the TOLERANT assembly.
   *
   * This plant is the gate's negative control, and it is the most important entry
   * here. `RunCfg.tolerant` selects WHICH TABLE is built, so a defect confined to
   * the tolerant assembly is invisible to any harness that calls `run(entry, input)`
   * without options — which is what `bench/jess/consumed-sweep.ts` does. The
   * registry therefore asserts `tolerant-sweep` MOVES under this plant and
   * `consumed-sweep` does NOT. If consumed-sweep ever moves here, the two sweeps
   * are measuring the same artifact and one of them is redundant; if
   * tolerant-sweep ever fails to move, it is not reaching the tolerant assembly
   * at all and its every past result was vacuous.
   */
  'tolerant-rec-off': {
    why: 'tolerant assembly only: recovery pieces are not lowered (strict parses unaffected)',
    edits: [
      {
        file: 'src/table/assemble.ts',
        find: '  const REC = prog.rec === 1 && cfg.tolerant',
        replace: '  const REC = false',
      },
      {
        file: 'src/table/emit-assembly.ts',
        find: '  const REC = prog.rec === 1 && cfg.tolerant',
        replace: '  const REC = false',
      },
    ],
  },

  /**
   * The macro timing contract computes rejection reasons but always exits green.
   *
   * The defect class: a report correctly names a regression while the required
   * CI step still succeeds. This plant lives in benchmark protocol code because
   * that protocol—not the browser/runtime package—is the behavior under test.
   */
  /**
   * A lexical choice ranks every arm where the character choice dispatches one.
   *
   * The defect class: a selected lexical body parses the same text but reports a
   * different failure than the character lowering it replaces. Only a failing
   * input shows it, and only when the selected arm fails at the choice's own
   * position.
   */
  'lex-choice-exclusive-off': {
    why: 'lexical body: a disjoint choice never takes the one-arm dispatch',
    edits: [{
      file: 'src/table/encode.ts',
      find: 'words.push(LEX_NODE_CHOICE, node.arms.length, exclusive ? 1 : 0, this.expected(node.expected))',
      replace: 'words.push(LEX_NODE_CHOICE, node.arms.length, 0, this.expected(node.expected))',
    }],
  },

  /** A lexical repeat accepts one item fewer than its `min`. */
  'lex-repeat-min-short': {
    why: 'lexical body: a repeat succeeds one item short of its minimum',
    edits: [{
      file: 'src/table/lex-program.ts',
      find: "        cur = end\n        count++\n      }\n      return count < min ? -1 : cur\n    },\n  }\n}",
      replace: "        cur = end\n        count++\n      }\n      return count < min - 1 ? -1 : cur\n    },\n  }\n}",
    }],
  },

  /**
   * A rule reference that reinstalls its trivia is lowered as if glued.
   *
   * The defect class: the parse of a trivia-separated rule inside a token stops
   * at the first gap, with the lexical body and the character lowering
   * disagreeing on what the token spans.
   */
  'lex-rule-trivia-glued': {
    why: 'lexical body: a reference that reinstalls its rule trivia is lowered without it',
    edits: [{
      file: 'src/compiler/token-alphabet.ts',
      find: '  return (reference._meta.grammarTrivia ?? target._meta.grammarTrivia) !== undefined\n    && hasOwnTriviaBoundary(target)',
      replace: '  return false && (reference._meta.grammarTrivia ?? target._meta.grammarTrivia) !== undefined\n    && hasOwnTriviaBoundary(target)',
    }],
  },

  /** A routed-arm gate miss reports less than the arm's next term would. */
  'rgate-miss-set-short': {
    why: 'closure engine: a routed-arm gate miss drops the first label of the next term',
    edits: [{
      file: 'src/table/assemble.ts',
      find: '            ctx._fe = item.span.end; ctx._fx = xf\n',
      replace: '            ctx._fe = item.span.end; ctx._fx = xf.slice(1)\n',
    }],
  },

  /**
   * The trivia lead gate (`trivia-gap.ts` `triviaLeadTable`, `emit-assembly.ts`
   * `triviaMiss`) answers a skip at a character no trivia can start without
   * scanning. Narrowing its lead set lets it refuse a gap that is there: the
   * trivia stays in the input and the parse, its recorded trivia or both move.
   */
  'trivia-lead-closure-narrow': {
    why: 'closure engine: the trivia lead table loses the trivia\'s last first-character range',
    edits: [{
      file: 'src/table/trivia-gap.ts',
      find: 'for (const r of fs.ranges) for',
      replace: 'for (const r of fs.ranges.slice(0, -1)) for',
    }],
  },

  'trivia-lead-emitted-narrow': {
    why: 'emitted engine: the printed trivia lead test loses the trivia\'s last first-character range',
    edits: [{
      file: 'src/table/emit-assembly.ts',
      find: 'return c => `${c}<55296&&!(${leads.map(',
      replace: 'return c => `${c}<55296&&!(${leads.slice(0, -1).map(',
    }],
  },

  'macro-timing-exit-off': {
    why: 'macro timing gate: regressions are reported but never block CI',
    edits: [{
      file: 'bench/jess/ab-protocol.ts',
      find: '  return errors.length === 0 ? 0 : 1',
      replace: '  return 0',
    }],
  },
}
