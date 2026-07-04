/**
 * Scannable regex lowering (PERF_IDEAS §8): terminal `regex()` shapes that
 * compile to `charCodeAt` scan loops instead of `RegExp.exec`.
 *
 * Rigorous cross-mode parity (interpreter vs compile() vs macro) plus codegen
 * detection that lowered patterns skip `_reN.exec` and non-scannable patterns
 * still use the regex fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  regex, literal, sequence, choice, transform, oneOrMore, many, sepBy,
  node, parser, trivia, parse, compile,
} from '../../src/index.ts'
import type { Combinator, CSTLeaf } from '../../src/index.ts'
import { parseScanShape, scanShapeFromRegex, SPACE_RANGES } from '../../src/compiler/scannable-run.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// ---------------------------------------------------------------------------
// Shape recognition
// ---------------------------------------------------------------------------

describe('parseScanShape — quantifier', () => {
  it('records minOne for + and *', () => {
    expect(parseScanShape('[0-9]+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('[0-9]*')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: false })
  })

  it('recognizes until and delimited terminal shapes', () => {
    expect(parseScanShape('//[^\\n\\r]*')?.kind).toBe('until')
    expect(parseScanShape('/\\*(?:[^*]|\\*(?!/))*\\*/')?.kind).toBe('delimited')
  })

  it('recognizes shorthand-class runs (\\d, \\w)', () => {
    expect(parseScanShape('\\d+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('\\w*')).toEqual({
      kind: 'chars',
      ranges: [[48, 57], [65, 90], [97, 122], [95, 95]],
      minOne: false,
    })
  })

  // `\s` (WhiteSpace + LineTerminator) is a fixed code-point set, unaffected by
  // the `u` flag — unlike `\d`/`\w`, which are ASCII-only without `u`. PERF_IDEAS §8a.
  // Import the production constant so this assertion can never drift from source.
  it('recognizes shorthand-class runs (\\s)', () => {
    expect(parseScanShape('\\s+')).toEqual({ kind: 'chars', ranges: SPACE_RANGES, minOne: true })
    expect(parseScanShape('\\s*')).toEqual({ kind: 'chars', ranges: SPACE_RANGES, minOne: false })
    expect(parseScanShape('[\\s]+')).toEqual({ kind: 'chars', ranges: SPACE_RANGES, minOne: true })
  })

  it('expands \\d/\\w/\\s inside a char class (not treated as literal letters)', () => {
    // `[\d.]+` must match digits or dot — NOT the letter "d".
    expect(parseScanShape('[\\d.]+')).toEqual({
      kind: 'chars',
      ranges: [[48, 57], [46, 46]],
      minOne: true,
    })
    // `[\s,]+` must match whitespace or comma — NOT the letter "s".
    expect(parseScanShape('[\\s,]+')).toEqual({
      kind: 'chars',
      ranges: [...SPACE_RANGES, [44, 44]],
      minOne: true,
    })
  })

  it('recognizes identifier shape [head][tail]*', () => {
    expect(parseScanShape('[_A-Za-z]\\w*')).toEqual({
      kind: 'ident',
      head: [[95, 95], [65, 90], [97, 122]],
      tail: [[48, 57], [65, 90], [97, 122], [95, 95]],
    })
    expect(parseScanShape('[a-z][a-z0-9]*')?.kind).toBe('ident')
  })

  it('rejects non-scannable patterns', () => {
    // `\S`/`\D`/`\W` (negated shorthand classes) aren't a fixed set we lower.
    expect(parseScanShape('\\S+')).toBeNull()
    expect(parseScanShape('[\\S]+')).toBeNull()
    // top-level `a|b` now lowers (§8e, see dedicated describe block below) —
    // groups / `.` / bounded repeats are still outside the chain category.
    expect(parseScanShape('a.c')).toBeNull()
    expect(parseScanShape('(ab)+')).toBeNull()
    expect(parseScanShape('a{2,3}')).toBeNull()
    // a bare negated `*` matches zero-width → no mandatory segment, not lowered.
    expect(parseScanShape('[^"]*')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Top-level alternation `A|B|C` (§8e) — split outside any `[]`/`()`, each arm
// lowered independently, then either disjoint first-char dispatch or ordered
// (first-success-wins) fallback, matching regex `|`'s own semantics exactly:
// the first alternative that matches AT ALL wins on its own greedy length,
// never compared against a later alternative's possibly-longer match.
// ---------------------------------------------------------------------------

describe('parseScanShape — top-level alternation (§8e)', () => {
  it('splits two disjoint literal arms and dispatches by first char', () => {
    const s = parseScanShape('GET|POST')
    expect(s?.kind).toBe('alt')
    if (s?.kind === 'alt') {
      expect(s.disjoint).toBe(true)
      expect(s.arms.map(a => a.kind)).toEqual(['seq', 'seq'])
    }
  })

  it('falls back to ordered (non-disjoint) when first-sets overlap', () => {
    // \d ⊆ \w, so the two arms' first-char sets overlap — must stay ordered.
    const s = parseScanShape('\\d+|\\w+')
    expect(s?.kind).toBe('alt')
    if (s?.kind === 'alt') expect(s.disjoint).toBe(false)
  })

  it('recognizes disjoint arms with mixed shapes (ident-like vs single literal)', () => {
    // The CSS Dimension unit tail: `-?ident|%` — real motivating pattern.
    const s = parseScanShape('-?[_a-zA-Z][-_a-zA-Z0-9]*|%')
    expect(s?.kind).toBe('alt')
    if (s?.kind === 'alt') expect(s.disjoint).toBe(true)
  })

  it('handles a literal `|` and escaped brackets inside bracket classes without mis-splitting', () => {
    // Real CSS `anyValueTok`: first arm's class body contains a literal `|`;
    // second arm's negated class body contains escaped `[`/`]`/`(`/`)`. Both
    // must be treated as atomic, non-split-point content.
    const s = parseScanShape(String.raw`[+\-*/=<>|~^]+|[^\s;{}\[\]()'",!]+`)
    expect(s?.kind).toBe('alt')
    if (s?.kind === 'alt') {
      expect(s.arms).toHaveLength(2)
      // Overlaps on e.g. `+` (accepted by both), so must stay ordered.
      expect(s.disjoint).toBe(false)
    }
  })

  it('unwraps one redundant whole-string (?:…) wrapper before splitting', () => {
    const s = parseScanShape('(?:GET|POST)')
    expect(s?.kind).toBe('alt')
  })

  it('does NOT unwrap a group that has trailing content after it (still lowers via §8f group support)', () => {
    // The `(?:…)` here doesn't span the whole source — a literal `%` follows —
    // so unwrapping (treating it as a top-level alternation) would silently
    // change what the pattern means, and correctly doesn't happen. It's NOT a
    // top-level `alt` shape — instead it's a `seq` whose SECOND part is a
    // `group` (§8f) wrapping the `a|b` alternation, followed by literal `%`.
    const s = parseScanShape('(?:a|b)%')
    expect(s?.kind).toBe('seq')
    if (s?.kind === 'seq') {
      expect(s.parts[0]).toMatchObject({ part: 'group' })
      expect(s.parts[1]).toEqual({ part: 'lit', cps: [37], optional: false })
    }
  })

  it('now lowers an arm with a nested group, since §8f closed that gap', () => {
    // Real CSS `numPart`-style shape: one arm has its own `(?:…)` group. Both
    // arms independently lower (§8f), and since their first-sets overlap on
    // digits (arm1 can start with `\d` OR `.`; arm2 is `\d+`), the alt is
    // correctly NOT disjoint — ordered dispatch, not switch dispatch.
    const s = parseScanShape(String.raw`\d*\.\d+(?:[eE][+-]?\d+)?|\d+`)
    expect(s?.kind).toBe('alt')
    if (s?.kind === 'alt') expect(s.disjoint).toBe(false)
  })

  it('declines an empty alternative (zero-width arm, unmodeled)', () => {
    expect(parseScanShape('a||b')).toBeNull()
  })

  it('rejects alternation under the /i flag (blocked upstream by scanShapeFromRegex)', () => {
    expect(scanShapeFromRegex('even|odd', 'i')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)*`, `(?:…)+` as `seq` parts
// (§8f). Composed with §8e (alternation-in-group) this lowers the "number"
// pattern shared by JSON/GraphQL/lang/TOML/CSS: `-?(?:0|[1-9]\d*)(?:\.\d+)?…`.
// `groupInnerSafe` restricts a group's body to shapes already proven to have
// exactly one valid greedy match (chars/ident/seq/litFold, or a DISJOINT alt)
// — a non-disjoint alt inside a group is declined outright (real backtracking
// into a different arm is possible if something after the group fails; see
// `/^(?:a|ab)c/.exec("abc")` → matches via the SECOND arm).
// ---------------------------------------------------------------------------

describe('parseScanShape — non-capturing groups (§8f)', () => {
  it('recognizes a required group with no quantifier', () => {
    const s = parseScanShape('a(?:bc)d')
    expect(s?.kind).toBe('seq')
    if (s?.kind === 'seq') {
      expect(s.parts[1]).toMatchObject({ part: 'group', min: 1, unbounded: false })
    }
  })

  it('recognizes optional / star / plus quantified groups', () => {
    const opt = parseScanShape('a(?:bc)?')
    const star = parseScanShape('a(?:bc)*')
    const plus = parseScanShape('a(?:bc)+')
    expect(opt?.kind === 'seq' && opt.parts[1]).toMatchObject({ part: 'group', min: 0, unbounded: false })
    expect(star?.kind === 'seq' && star.parts[1]).toMatchObject({ part: 'group', min: 0, unbounded: true })
    expect(plus?.kind === 'seq' && plus.parts[1]).toMatchObject({ part: 'group', min: 1, unbounded: true })
  })

  it('lowers the JSON/GraphQL "number" pattern in full: -?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', () => {
    const s = parseScanShape(String.raw`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`)
    expect(s?.kind).toBe('seq')
    if (s?.kind === 'seq') {
      expect(s.parts).toHaveLength(4)
      expect(s.parts[0]).toEqual({ part: 'lit', cps: [45], optional: true })
      // group 1: required, disjoint alt of "0" vs "[1-9]\d*"
      const part1 = s.parts[1]
      expect(part1).toMatchObject({ part: 'group', min: 1, unbounded: false })
      const g1 = part1?.part === 'group' ? part1.inner : null
      expect(g1?.kind).toBe('alt')
      if (g1?.kind === 'alt') expect(g1.disjoint).toBe(true)
      // groups 2 and 3: both optional, disjoint from each other (`.` vs `e`/`E`)
      expect(s.parts[2]).toMatchObject({ part: 'group', min: 0, unbounded: false })
      expect(s.parts[3]).toMatchObject({ part: 'group', min: 0, unbounded: false })
    }
  })

  it('lowers GraphQL float: -?(?:0|[1-9]\\d*)(?:\\.\\d+(?:[eE][+-]?\\d+)?|[eE][+-]?\\d+)', () => {
    // Nested alternation-in-a-group-in-a-group: the second top-level group's
    // body is ITSELF a disjoint 2-arm alt (`.`-led vs `e`/`E`-led), and one of
    // those arms has its own further-nested optional group.
    const s = parseScanShape(String.raw`-?(?:0|[1-9]\d*)(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)`)
    expect(s?.kind).toBe('seq')
    if (s?.kind === 'seq') {
      const part2 = s.parts[2]
      const g2 = part2?.part === 'group' ? part2.inner : null
      expect(g2?.kind).toBe('alt')
      if (g2?.kind === 'alt') expect(g2.disjoint).toBe(true)
    }
  })

  it('rejects {n,m} on a group (§8c/§8f combination not modeled)', () => {
    expect(parseScanShape('a(?:bc){2,3}')).toBeNull()
  })

  it('rejects a bare capturing group and a mid-pattern lookaround', () => {
    expect(parseScanShape('a(bc)d')).toBeNull()
    expect(parseScanShape('a(?=bc)d')).toBeNull()
  })

  it('rejects a `*`/`+` group whose body can match empty (would loop forever)', () => {
    expect(parseScanShape('a(?:[0-9]*)+')).toBeNull()
    expect(parseScanShape('a(?:[0-9]*)*')).toBeNull()
  })

  it('declines a NON-TRAILING group whose body is a non-disjoint alt (arm-switching hazard)', () => {
    // `(?:a|ab)` genuinely needs real backtracking into the second arm when
    // the trailing `c` fails against the first arm's shorter match
    // (`/^(?:a|ab)c/.exec("abc")` matches via the SECOND arm) — ordered-commit
    // can't model that, so a non-trailing non-disjoint-alt group is declined.
    expect(parseScanShape('x(?:a|ab)c')).toBeNull()
  })

  // §8h: a non-disjoint-alt group IS lowerable when it's the trailing,
  // matched-once part — nothing follows to force an arm switch, so ordered
  // commit equals the engine. `x(?:a|ab)` matches "xa" both ways.
  it('lowers a TRAILING group whose body is a non-disjoint alt (§8h)', () => {
    expect(parseScanShape('x(?:a|ab)')?.kind).toBe('seq')
    // But still declined when trailing-yet-optional/repeated (a "drop the
    // group" or "repeat" choice reintroduces the arm-switch hazard).
    expect(parseScanShape('x(?:a|ab)?')).toBeNull()
    expect(parseScanShape('x(?:a|ab)+')).toBeNull()
  })

  it('declines two consecutive optional groups whose first-sets overlap', () => {
    // Both groups can start with 'a' — genuinely ambiguous which one (if
    // either) should claim it.
    expect(parseScanShape(String.raw`x(?:a[0-9]+)?(?:a[a-z]+)?`)).toBeNull()
  })

  it('allows a chain of 3 consecutive optional groups when pairwise disjoint', () => {
    // Stress test for the generalized seqIsUnambiguous check: p is compared
    // against seqFirstAccept of EVERYTHING that follows, not just the
    // immediate next sibling.
    const s = parseScanShape(String.raw`a(?:\.[0-9]+)?(?:![a-c]+)?(?:#[x-z]+)?`)
    expect(s?.kind).toBe('seq')
    if (s?.kind === 'seq') expect(s.parts).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// General `seq` category — a linear chain of literals + char runs. This is the
// GENERALIZATION of the CSS/Less token shapes (optional prefix, literal opener,
// negated run, …); no specific byte value is hardcoded in the recognizer.
// ---------------------------------------------------------------------------

describe('parseScanShape — general seq category', () => {
  const seqOf = (re: RegExp) => {
    const s = parseScanShape(re.source)
    return s && s.kind === 'seq' ? s.parts : s?.kind ?? null
  }

  it('optional literal prefix + run (e.g. -?[0-9]+)', () => {
    expect(seqOf(/-?[0-9]+/)).toEqual([
      { part: 'lit', cps: [45], optional: true },
      { part: 'run', ranges: [[48, 57]], negated: false, min: 1, unbounded: true },
    ])
  })

  it('literal opener + char run (e.g. CSS --custom-prop)', () => {
    expect(parseScanShape(/--[-_a-zA-Z0-9\u0080-\uffff]*/.source)?.kind).toBe('seq')
  })

  it('literal + optional dash + ident head/tail (e.g. CSS @-webkit-…)', () => {
    const parts = seqOf(/@-?[_a-zA-Z][-_a-zA-Z0-9]*/)
    expect(Array.isArray(parts) && parts[0]).toEqual({ part: 'lit', cps: [64], optional: false })
    expect(Array.isArray(parts) && parts[1]).toEqual({ part: 'lit', cps: [45], optional: true })
  })

  it('bare negated run: `+` lowers, `*` does not (zero-width)', () => {
    expect(parseScanShape(/[^)"' \t\n\r\f]+/.source)?.kind).toBe('seq')
    expect(parseScanShape(/[^)"' \t\n\r\f]*/.source)).toBeNull()
  })

  it('declines ambiguous greedy chains (overlapping adjacent runs)', () => {
    // `[a-z]+[a-z]` — greedy run overlaps the following required char; a one-pass
    // scan would diverge from the engine's backtracking, so we do NOT lower it.
    expect(parseScanShape('[a-z]+[a-z]')).toBeNull()
    // `-?[-a]+` — the optional `-` is also matchable by the following run, so
    // greedy-take vs skip diverge; declined.
    expect(parseScanShape('-?[-a]+')).toBeNull()
    // `[A-Z]?P` — the optional run [A-Z] covers P (80 ∈ [65,90]); greedy-take
    // diverges from backtracking (P consumed by run → required P fails). Must
    // NOT be lowered. (This is the `rangeFirstCps` lower-bound-only bug.)
    expect(parseScanShape('[A-Z]?P')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Trailing lookahead boundary guard (PERF_IDEAS §8b) — `<inner>(?!class)` /
// `<inner>(?=class)`. Tested against a mix of shapes/operands that are NOT the
// `lang` keyword set (`if`/`then`/`else`/`true`/`false`) the idea was framed
// around, so the recognizer is verified as a general structural rule, not
// something that happens to work for five specific strings.
// ---------------------------------------------------------------------------

describe('parseScanShape — trailing lookahead boundary (§8b)', () => {
  it('wraps a chars-shape base with a negative shorthand-class lookahead', () => {
    const s = parseScanShape('[a-z]+(?!\\w)')
    expect(s?.kind).toBe('lookahead')
    if (s?.kind === 'lookahead') {
      expect(s.inner).toEqual({ kind: 'chars', ranges: [[97, 122]], minOne: true })
      expect(s.ranges).toEqual([[48, 57], [65, 90], [97, 122], [95, 95]])
      expect(s.negative).toBe(true)
      expect(s.classNegated).toBe(false)
    }
  })

  it('wraps a literal token (not a lang keyword) with a negative lookahead', () => {
    // Generic "identifier-like literal must not be followed by a word char" —
    // the same shape as `if(?!\w)` etc., but with an arbitrary literal to prove
    // this isn't special-cased to the five `lang` keywords.
    const s = parseScanShape('wombat(?!\\w)')
    expect(s?.kind).toBe('lookahead')
  })

  it('wraps a bracket-class run with a positive single-char-literal lookahead', () => {
    const s = parseScanShape('[0-9]+(?=%)')
    expect(s?.kind).toBe('lookahead')
    if (s?.kind === 'lookahead') {
      expect(s.ranges).toEqual([[37, 37]])
      expect(s.negative).toBe(false)
      expect(s.classNegated).toBe(false)
    }
  })

  it('wraps a run with a positive NEGATED bracket-class lookahead ([^…])', () => {
    // Base and operand cover the SAME set (digits ⊆ "not-a-digit"'s underlying
    // class) — provably safe (see `lookaheadUnambiguous`/§8b ambiguity guard).
    const s = parseScanShape('[0-9]+(?=[^0-9])')
    expect(s?.kind).toBe('lookahead')
    if (s?.kind === 'lookahead') {
      expect(s.ranges).toEqual([[48, 57]])
      expect(s.classNegated).toBe(true)
    }
  })

  it('declines an AMBIGUOUS lookahead where backtracking could rescue a shorter match', () => {
    // `/^[0-9]+(?=[5-9])/.exec('12345')` really does return `["1234"]` in real
    // regex (backtracks past the trailing '5', which the class ALSO matches) —
    // a naive greedy-then-check-once lowering would get this wrong (either miss
    // the shorter match or report total failure). Since [0-9] and [5-9] overlap
    // (not disjoint), the guard declines this rather than risk it.
    expect(parseScanShape('[0-9]+(?=[5-9])')).toBeNull()
    // Same issue for negative lookahead: base [a-z] is NOT a subset of the
    // single-char operand 'X' (disjoint alphabets), so shrinking the run could
    // expose a char that changes the verdict — declined.
    expect(parseScanShape('[a-z]+(?!X)')).toBeNull()
  })

  it('wraps a `seq` base (optional prefix + run) with a lookahead', () => {
    const s = parseScanShape('-?[0-9]+(?!\\w)')
    expect(s?.kind).toBe('lookahead')
    if (s?.kind === 'lookahead') expect(s.inner.kind).toBe('seq')
  })

  it('generalizes the CSS colorHex-style boundary without hardcoding "Color"', () => {
    // `[0-9a-fA-F]+(?![0-9a-fA-F])` — a hex run that must not extend further.
    const s = parseScanShape('[0-9a-fA-F]+(?![0-9a-fA-F])')
    expect(s?.kind).toBe('lookahead')
  })

  it('declines lookahead operands that are sub-patterns, not a class', () => {
    // Alternation inside the lookahead — a sub-pattern, not a class.
    expect(parseScanShape('foo(?!bar|baz)')).toBeNull()
    // Nested group inside the lookahead.
    expect(parseScanShape('foo(?!(?:x))')).toBeNull()
    // Multi-char literal operand — not (yet) supported; falls back safely.
    expect(parseScanShape('foo(?!barbaz)')).toBeNull()
    // `.` (any-char) operand — a metachar, not a class.
    expect(parseScanShape('foo(?=.)')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Codegen detection
// ---------------------------------------------------------------------------

describe('scannable regex — codegen', () => {
  it('lowers [0-9]+ to charCodeAt without RegExp.exec', () => {
    const { source } = compile(regex(/[0-9]+/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toMatch(/const _re\d+/)
    expect(source).not.toContain('.exec(input)')
  })

  it('lowers until and delimited shapes', () => {
    const line = compile(regex(/\/\/[^\n\r]*/))
    expect(line.source).toContain('charCodeAt')
    expect(line.source).not.toContain('.exec(input)')

    const block = compile(regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))
    expect(block.source).toContain('charCodeAt')
    expect(block.source).not.toContain('.exec(input)')
  })

  it('keeps RegExp.exec for non-scannable patterns', () => {
    const { source } = compile(regex(/\S+/))
    expect(source).toMatch(/const _re\d+ = /)
    expect(source).toContain('.exec(input)')
  })

  it('lowers \\s+ to charCodeAt (fixed SPACE_RANGES set)', () => {
    const { source } = compile(regex(/\s+/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toContain('.exec(input)')
  })

  it('lowers \\d+ and \\w+ shorthand runs', () => {
    expect(compile(regex(/\d+/)).source).not.toContain('.exec(input)')
    expect(compile(regex(/\w+/)).source).not.toContain('.exec(input)')
  })

  it('lowers identifier shape [_A-Za-z]\\w*', () => {
    const { source } = compile(regex(/[_A-Za-z]\w*/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toContain('.exec(input)')
  })

  it('lowers CSS ident, customProp, atKeyword, urlInner, urlOpen', () => {
    const cssIdent = regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
    const cssCustom = regex(/--[-_a-zA-Z0-9\u0080-\uffff]*/)
    const cssAt = regex(/@-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
    const cssUrlInner = regex(/[^)"' \t\n\r\f]+/)
    const cssUrlOpen = regex(/url\(/i)
    for (const c of [cssIdent, cssCustom, cssAt, cssUrlInner, cssUrlOpen]) {
      const { source } = compile(c)
      expect(source, c.toString()).toContain('charCodeAt')
      expect(source, c.toString()).not.toContain('.exec(input)')
    }
  })

  it('does NOT lower case-insensitive class patterns (only pure literals)', () => {
    // `i` on a char class must stay on exec; pure-literal `i` lowers via litFold.
    expect(compile(regex(/[a-z]+/i)).source).toContain('.exec(input)')
    expect(compile(regex(/url\(/i)).source).not.toContain('.exec(input)')
    expect(compile(regex(/[a-z]+/u)).source).toContain('.exec(input)')
  })

  it('lowers a trailing lookahead boundary to charCodeAt, no exec (§8b)', () => {
    // Deliberately not one of the `lang` keywords — a generic word-boundary check.
    const code = compile(regex(/[a-z]+(?!\w)/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('an AMBIGUOUS lookahead still compiles correctly via the exec fallback', () => {
    // Declined by the ambiguity guard (see the "declines an AMBIGUOUS lookahead"
    // test above) — must fall back to RegExp.exec, not silently misbehave.
    const code = compile(regex(/[0-9]+(?=[5-9])/)).source
    expect(code).toContain('.exec(input)')
  })

  it('lowers a disjoint top-level alternation to charCodeAt, no exec (§8e)', () => {
    const code = compile(regex(/GET|POST/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('lowers an overlapping (ordered-fallback) alternation to charCodeAt, no exec', () => {
    // The real CSS `anyValueTok` arm — first-sets overlap on e.g. `+`, so this
    // exercises the "try each arm in order" codegen path, not disjoint dispatch.
    const code = compile(regex(/[+\-*/=<>|~^]+|[^\s;{}[\]()'",!]+/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('lowers a basicSel-style alternation with a nested group in one arm (§8f)', () => {
    // Previously declined (an arm's own `(?:\.\d+)?` group was unmodeled);
    // §8f's `group` SeqPart now lowers it fully. Real CSS `basicSel`.
    const code = compile(regex(/(?:[.#]?-?[_a-zA-Z][-_a-zA-Z0-9]*|\d+(?:\.\d+)?%|\*)/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('lowers an unbounded required group arm (§8f `+` quantifier)', () => {
    const code = compile(regex(/a(?:bc)+d/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('lowers the JSON/GraphQL number pattern to charCodeAt, no exec (§8f)', () => {
    const code = compile(regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)).source
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('.exec(input)')
  })

  it('lowers CSS numPart to charCodeAt, no exec (§8h — trailing non-disjoint alt)', () => {
    // `\d*\.\d+(?:...)?` and `\d+(?:...)?` overlap on digits, so the group's
    // body is a non-disjoint alt. It's the TRAILING part of the seq, so
    // ordered-choice-commit provably equals the engine (nothing follows to
    // force an arm switch) and it lowers. See the differential parity test.
    const numPart = compile(regex(/[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)/)).source
    expect(numPart).toContain('charCodeAt')
    expect(numPart).not.toContain('.exec(input)')
  })

  // Exhaustive differential parity: the lowered CSS numPart scan must consume
  // exactly what the raw RegExp matches, over every short combination of the
  // structurally-relevant chars (sign, dot, exp marker, digits, and boundary
  // chars a unit/`%` could start with).
  it('CSS numPart: lowered scan == RegExp.exec across all short inputs (§8h)', () => {
    const src = String.raw`[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)`
    const re = new RegExp('^(?:' + src + ')')
    const p = regex(new RegExp(src))
    const alph = ['', '+', '-', '.', 'e', 'E', '0', '1', '9', 'x', '%', ' ']
    for (const a of alph) for (const b of alph) for (const c of alph) for (const d of alph) {
      const s = a + b + c + d
      const m = re.exec(s)
      const want = m ? m[0].length : -1
      const r = parse(p, s)
      const got = r.ok ? (r.value as string).length : -1
      expect(got, JSON.stringify(s)).toBe(want)
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-mode parity helpers
// ---------------------------------------------------------------------------

type ParseFn = (
  input: string,
  pos: number,
  ctx: Record<string, unknown>,
) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function makeMacroParser(code: string, exportName: string): ParseFn {
  const result = transformMacro(code, 'scannable-regex-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + `\nreturn ${exportName}`
  return new Function(fnBody)() as ParseFn
}

function modesFor<T>(combinator: Parameters<typeof compile<T>>[0], macroCode: string, exportName: string) {
  const compiled = compile(combinator)
  let macroFn: ParseFn
  beforeAll(() => {
    macroFn = makeMacroParser(macroCode, exportName)
  })
  return [
    ['interpreter', (input: string, pos = 0) => {
      const r = combinator.parse(input, pos, { trackLines: false })
      return { ok: r.ok, value: r.ok ? r.value : undefined, span: r.span }
    }],
    ['compile()', (input: string, pos = 0) => {
      const r = compiled.parse(input, pos)
      return { ok: r.ok, value: r.ok ? r.value : undefined, span: r.span }
    }],
    ['macro', (input: string, pos = 0) => macroFn(input, pos, {})],
  ] as const
}

function expectParity(
  modes: ReturnType<typeof modesFor>,
  input: string,
  pos = 0,
) {
  const results = modes.map(([, run]) => run(input, pos))
  const vals = results.map(r => (r.ok ? r.value : `fail@${r.span.end}`))
  expect(new Set(vals).size).toBe(1)
  return results[0]!
}

// ---------------------------------------------------------------------------
// Parity — char-class runs
// ---------------------------------------------------------------------------

const digits = regex(/[0-9]+/)
const digitsStar = regex(/[0-9]*/)
const letters = regex(/[a-z]+/)

describe('scannable regex — [0-9]+ parity', () => {
  const modes = modesFor(
    digits,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const digits = regex(/[0-9]+/)`,
    'digits',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches a digit run`, () => {
      const r = run('123abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('123')
      expect(r.span).toEqual({ start: 0, end: 3 })
    })

    it(`${mode}: fails on empty / non-digit`, () => {
      expect(run('abc').ok).toBe(false)
      expect(run('', 0).ok).toBe(false)
    })

    it(`${mode}: matches at offset`, () => {
      const r = run('xx42yy', 2)
      expect(r.ok).toBe(true)
      expect(r.value).toBe('42')
      expect(r.span).toEqual({ start: 2, end: 4 })
    })
  }

  it('all modes agree on mixed cases', () => {
    for (const [input, pos] of [['007', 0], ['a1', 1], ['9', 0], ['', 0]] as const) {
      expectParity(modes, input, pos)
    }
  })
})

describe('scannable regex — [0-9]* parity', () => {
  const modes = modesFor(
    digitsStar,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const digitsStar = regex(/[0-9]*/)`,
    'digitsStar',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: allows zero-width match`, () => {
      const r = run('abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('')
      expect(r.span).toEqual({ start: 0, end: 0 })
    })

    it(`${mode}: still consumes digits when present`, () => {
      const r = run('99x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('99')
    })
  }

  it('all modes agree', () => {
    expectParity(modes, '001end')
    expectParity(modes, 'no-digits')
  })
})

describe('scannable regex — choice of letter vs digit runs', () => {
  const arm = choice(letters, digits)
  const modes = modesFor(
    arm,
    `import { regex, choice } from 'parseman' with { type: 'macro' }
const letters = regex(/[a-z]+/)
const digits = regex(/[0-9]+/)
export const arm = choice(letters, digits)`,
    'arm',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: picks the matching arm`, () => {
      expect(run('abc123').value).toBe('abc')
      expect(run('123abc').value).toBe('123')
    })
  }
})

// ---------------------------------------------------------------------------
// Parity — shorthand runs and identifier shape
// ---------------------------------------------------------------------------

const dRun = regex(/\d+/)
const wRun = regex(/\w+/)
const ident = regex(/[_A-Za-z]\w*/)

describe('scannable regex — \\d+ / \\w+ parity', () => {
  const dModes = modesFor(
    dRun,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const dRun = regex(/\\d+/)`,
    'dRun',
  )
  for (const [mode, run] of dModes) {
    it(`${mode}: \\d+ matches a digit run`, () => {
      const r = run('2026!')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('2026')
    })
    it(`${mode}: \\d+ fails on a letter`, () => {
      expect(run('x').ok).toBe(false)
    })
  }

  const wModes = modesFor(
    wRun,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const wRun = regex(/\\w+/)`,
    'wRun',
  )
  for (const [mode, run] of wModes) {
    it(`${mode}: \\w+ matches word chars incl. underscore/digits`, () => {
      const r = run('a_1B-')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('a_1B')
    })
  }
})

// `\s` (PERF_IDEAS §8a) — a fixed code-point set (WhiteSpace + LineTerminator),
// unaffected by the `u` flag, so it lowers to a charCodeAt scan like \d/\w.
const sRun = regex(/\s+/)

describe('scannable regex — \\s+ parity', () => {
  const sModes = modesFor(
    sRun,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const sRun = regex(/\\s+/)`,
    'sRun',
  )
  for (const [mode, run] of sModes) {
    it(`${mode}: \\s+ matches ASCII + Unicode whitespace`, () => {
      const r = run('  \t\n x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('  \t\n ')
    })
    it(`${mode}: \\s+ fails on a non-space char`, () => {
      expect(run('x').ok).toBe(false)
    })
  }

  it('compiled output lowers to a charCodeAt scan, not exec', () => {
    expect(compile(sRun).source).not.toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// Parity — trailing lookahead boundary (§8b). Uses a generic word-run and a
// digit-run, not the `lang` keyword literals, so this proves the mechanism
// generalizes rather than happening to work for `if`/`then`/`else`/`true`/`false`.
// ---------------------------------------------------------------------------

const wordBoundary = regex(/[a-z]+(?!\w)/)
const digitBeforePercent = regex(/[0-9]+(?=%)/)

describe('scannable regex — negative lookahead parity ([a-z]+(?!\\w))', () => {
  const modes = modesFor(
    wordBoundary,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const wordBoundary = regex(/[a-z]+(?!\\w)/)`,
    'wordBoundary',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: stops at a real word boundary`, () => {
      const r = run('cat dog')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('cat')
    })
    it(`${mode}: matches to end of input (no char to violate the lookahead)`, () => {
      const r = run('category')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('category')
    })
    it(`${mode}: fails entirely when every possible split is followed by a word char`, () => {
      // Matches native RegExp exactly (verified empirically) — base [a-z] is a
      // subset of \w, so no backtrack could ever rescue this.
      expect(run('cat1').ok).toBe(false)
    })
  }
})

describe('scannable regex — positive lookahead parity ([0-9]+(?=%))', () => {
  const modes = modesFor(
    digitBeforePercent,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const digitBeforePercent = regex(/[0-9]+(?=%)/)`,
    'digitBeforePercent',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches when the class char follows`, () => {
      const r = run('50%')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('50')
    })
    it(`${mode}: fails at end of input (nothing there to satisfy (?=%))`, () => {
      expect(run('50').ok).toBe(false)
    })
    it(`${mode}: fails when a different char follows`, () => {
      expect(run('50x').ok).toBe(false)
    })
  }

  it('span is zero-width for the lookahead itself — captured value excludes it', () => {
    const r = digitBeforePercent.parse('50%', 0, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.span).toEqual({ start: 0, end: 2 }) // "50", not "50%"
  })
})

// ---------------------------------------------------------------------------
// Top-level alternation (§8e) — one parity block per dispatch strategy.
// ---------------------------------------------------------------------------

const methodAlt = regex(/GET|POST/)

describe('scannable regex — disjoint alternation parity (GET|POST)', () => {
  const modes = modesFor(
    methodAlt,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const methodAlt = regex(/GET|POST/)`,
    'methodAlt',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches the first arm`, () => {
      const r = run('GET /x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('GET')
    })
    it(`${mode}: matches the second arm`, () => {
      const r = run('POST /x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('POST')
    })
    it(`${mode}: fails when neither arm matches`, () => {
      expect(run('PUT /x').ok).toBe(false)
    })
  }

  it('all modes agree on mixed cases', () => {
    for (const [input, pos] of [['GET', 0], ['POST', 0], ['xPOST', 1], ['', 0], ['G', 0]] as const) {
      expectParity(modes, input, pos)
    }
  })
})

// The real CSS `anyValueTok` token — deliberately overlapping first-sets
// (both arms accept e.g. `+`), so this exercises ordered (first-arm-wins)
// dispatch, not the disjoint switch — and its first arm's class body has a
// literal `|`, its second arm's negated class has escaped brackets/parens.
const anyValueTok = regex(/[+\-*/=<>|~^]+|[^\s;{}[\]()'",!]+/)

describe('scannable regex — ordered (overlapping) alternation parity (anyValueTok)', () => {
  const modes = modesFor(
    anyValueTok,
    String.raw`import { regex } from 'parseman' with { type: 'macro' }
export const anyValueTok = regex(/[+\-*/=<>|~^]+|[^\s;{}[\]()'",!]+/)`,
    'anyValueTok',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: a punctuation run stays in the first arm even though the
        second arm would also accept its leading char`, () => {
      const r = run('+++abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('+++') // first arm wins, its own greedy length — not "+++abc"
    })
    it(`${mode}: falls through to the second arm for a non-punctuation run`, () => {
      const r = run('hello world')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('hello')
    })
    it(`${mode}: fails on a char excluded by both arms (whitespace)`, () => {
      expect(run(' leading').ok).toBe(false)
    })
  }

  it('all modes agree on mixed cases, matching real RegExp order semantics', () => {
    for (const [input, pos] of [
      ['+abc', 0], ['a+b', 0], ['***', 0], ['', 0], ['   ', 0], ['x', 0], ["it's", 0],
    ] as const) {
      const expected = /^(?:[+\-*/=<>|~^]+|[^\s;{}[\]()'",!]+)/.exec(input.slice(pos))?.[0]
      const r = expectParity(modes, input, pos)
      expect(r.ok ? r.value : undefined).toBe(expected)
    }
  })
})

// The real JSON/GraphQL "number" pattern (§8f): a required disjoint-alt group
// (`0` vs `[1-9]\d*`) followed by two chained optional groups (`.digits`,
// `eE[+-]digits`) — exercises both group quantifier kinds and the
// generalized (chain-aware) `seqIsUnambiguous` check in the same shape.
const jsonNumber = regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)

describe('scannable regex — JSON/GraphQL number pattern parity (§8f groups)', () => {
  const modes = modesFor(
    jsonNumber,
    String.raw`import { regex } from 'parseman' with { type: 'macro' }
export const jsonNumber = regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)`,
    'jsonNumber',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches a bare integer`, () => {
      const r = run('123')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('123')
    })
    it(`${mode}: matches zero without a leading-zero digit run`, () => {
      const r = run('0abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('0') // "0" is its own arm — must not greedily read "0abc"'s digits
    })
    it(`${mode}: matches a negative decimal with exponent`, () => {
      const r = run('-3.14e10')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('-3.14e10')
    })
    it(`${mode}: matches decimal-only (no exponent)`, () => {
      const r = run('2.5x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('2.5')
    })
    it(`${mode}: matches exponent-only (no decimal point)`, () => {
      const r = run('7E-3;')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('7E-3')
    })
    it(`${mode}: fails on non-digit input`, () => {
      expect(run('abc').ok).toBe(false)
    })
  }

  it('all modes agree on mixed cases, matching real RegExp exactly', () => {
    for (const [input, pos] of [
      ['0', 0], ['00', 0], ['10', 0], ['-0', 0], ['-', 0], ['3.', 0], ['.5', 0],
      ['1e', 0], ['1e+', 0], ['1.2.3', 0], ['-1.5e-10rest', 0], ['', 0], ['9007199254740993', 0],
    ] as const) {
      const expected = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(pos))?.[0]
      const r = expectParity(modes, input, pos)
      expect(r.ok ? r.value : undefined).toBe(expected)
    }
  })
})

describe('scannable regex — CSS ident / atKeyword / url parity (seq)', () => {
  const cssIdent = regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)
  const modes = modesFor(
    cssIdent,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const cssIdent = regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)`,
    'cssIdent',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: -webkit-foo`, () => {
      const r = run('-webkit-foo ')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('-webkit-foo')
    })
    it(`${mode}: plain ident`, () => {
      const r = run('color:')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('color')
    })
    it(`${mode}: lone dash fails`, () => {
      expect(run('-').ok).toBe(false)
    })
  }

  const cssAt = regex(/@-?[_a-zA-Z][-_a-zA-Z0-9]*/)
  const atModes = modesFor(
    cssAt,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const cssAt = regex(/@-?[_a-zA-Z][-_a-zA-Z0-9]*/)`,
    'cssAt',
  )
  for (const [mode, run] of atModes) {
    it(`${mode}: @media`, () => {
      expect(run('@media{').value).toBe('@media')
    })
    it(`${mode}: @-webkit-keyframes`, () => {
      expect(run('@-webkit-keyframes ').value).toBe('@-webkit-keyframes')
    })
  }

  const urlOpen = regex(/url\(/i)
  const urlModes = modesFor(
    urlOpen,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const urlOpen = regex(/url\\(/i)`,
    'urlOpen',
  )
  for (const [mode, run] of urlModes) {
    it(`${mode}: case-insensitive url(`, () => {
      expect(run('URL(x)').value).toBe('URL(')
      expect(run('Url(x)').value).toBe('Url(')
    })
  }
})

describe('scannable regex — identifier shape parity', () => {
  const modes = modesFor(
    ident,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const ident = regex(/[_A-Za-z]\\w*/)`,
    'ident',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: head then tail run`, () => {
      const r = run('_foo123 ')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('_foo123')
    })
    it(`${mode}: single head char is a valid identifier`, () => {
      const r = run('x=')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('x')
    })
    it(`${mode}: fails when first char is a digit`, () => {
      expect(run('1abc').ok).toBe(false)
    })
  }

  it('all modes agree across mixed inputs', () => {
    for (const s of ['a', 'A9', '__', 'z0z0', '9no']) expectParity(modes, s)
  })
})

// ---------------------------------------------------------------------------
// Parity — until / delimited
// ---------------------------------------------------------------------------

const lineComment = regex(/\/\/[^\n\r]*/)
const blockComment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)

describe('scannable regex — line comment (until)', () => {
  const modes = modesFor(
    lineComment,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const lineComment = regex(/\\/\\/[^\\n\\r]*/)`,
    'lineComment',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: consumes through EOL`, () => {
      const r = run('// hello\nrest')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('// hello')
      expect(r.span.end).toBe(8)
    })

    it(`${mode}: fails without // opener`, () => {
      expect(run('hello').ok).toBe(false)
    })
  }
})

describe('scannable regex — block comment (delimited)', () => {
  const modes = modesFor(
    blockComment,
    `import { regex } from 'parseman' with { type: 'macro' }
export const blockComment = regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)`,
    'blockComment',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches a closed block`, () => {
      const r = run('/* a * b */ tail')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('/* a * b */')
    })

    it(`${mode}: fails on unclosed block`, () => {
      expect(run('/* open').ok).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// Parity — transform + sequence (realistic terminal use)
// ---------------------------------------------------------------------------

const num = transform(regex(/[0-9]+/), s => Number(s))
// `[^"]*` has no literal opener, so it is NOT lowered (until requires <lit>[^X]*).
// This proves a scannable delimiter can wrap a non-scannable body in one sequence.
const quoted = sequence(literal('"'), regex(/[^"]*/), literal('"'))
// `//[^\n\r]*` IS a genuine until shape — exercised inside a sequence here.
const tagged = sequence(literal('#'), regex(/[a-z]+/))

describe('scannable regex — inside transform and sequence', () => {
  const numModes = modesFor(
    num,
    `import { regex, transform } from 'parseman' with { type: 'macro' }
export const num = transform(regex(/[0-9]+/), s => Number(s))`,
    'num',
  )
  for (const [mode, run] of numModes) {
    it(`${mode}: transform receives scanned digits`, () => {
      const r = run('42x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe(42)
    })
  }

  const strModes = modesFor(
    quoted,
    `import { regex, sequence, literal } from 'parseman' with { type: 'macro' }
export const quoted = sequence(literal('"'), regex(/[^"]*/), literal('"'))`,
    'quoted',
  )
  for (const [mode, run] of strModes) {
    it(`${mode}: scannable delimiters around a non-scannable body`, () => {
      const r = run('"hi"!')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['"', 'hi', '"'])
    })
  }

  const tagModes = modesFor(
    tagged,
    `import { regex, sequence, literal } from 'parseman' with { type: 'macro' }
export const tagged = sequence(literal('#'), regex(/[a-z]+/))`,
    'tagged',
  )
  for (const [mode, run] of tagModes) {
    it(`${mode}: scannable chars run after a literal`, () => {
      const r = run('#foo ')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['#', 'foo'])
    })
  }
})

// `[^"]*` must stay on the RegExp.exec fallback (no literal opener).
it('scannable regex — bare negated class is not lowered', () => {
  expect(parseScanShape('[^"]*')).toBeNull()
  expect(compile(regex(/[^"]*/)).source).toContain('.exec(input)')
})

// ---------------------------------------------------------------------------
// Parity — repetition of scannable terminals
// ---------------------------------------------------------------------------

const digitGroups = sepBy(regex(/[0-9]+/), literal(','))
const wordRun = many(sequence(regex(/[a-z]+/), regex(/[0-9]*/)))

describe('scannable regex — repeated in sepBy', () => {
  const modes = modesFor(
    digitGroups,
    `import { regex, sepBy, literal } from 'parseman' with { type: 'macro' }
export const digitGroups = sepBy(regex(/[0-9]+/), literal(','))`,
    'digitGroups',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: collects comma-separated digit runs`, () => {
      const r = run('1,22,333')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['1', '22', '333'])
    })
  }
})

describe('scannable regex — repeated in many + optional-star body', () => {
  const modes = modesFor(
    wordRun,
    `import { regex, many, sequence } from 'parseman' with { type: 'macro' }
export const wordRun = many(sequence(regex(/[a-z]+/), regex(/[0-9]*/)))`,
    'wordRun',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches word/digit pairs incl. zero-width star`, () => {
      const r = run('ab12cd')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual([['ab', '12'], ['cd', '']])
    })
  }
})

// ---------------------------------------------------------------------------
// Non-scannable fallback parity (still uses exec — behavior unchanged)
// ---------------------------------------------------------------------------

const notSpace = regex(/\S+/)

describe('scannable regex — \\S+ fallback parity', () => {
  const modes = modesFor(
    notSpace,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const notSpace = regex(/\\S+/)`,
    'notSpace',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: non-whitespace via RegExp.exec`, () => {
      const r = run('abc x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('abc')
    })
  }

  it('compiled output still uses exec', () => {
    expect(compile(notSpace).source).toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// CST capture — the terminal analog of the trivia capture path. A scannable
// regex inside a capturing node() must push a CSTLeaf whose value/span match
// the interpreter, and codegen must lower it (charCodeAt + _cstLeaves.push,
// never RegExp.exec).
// ---------------------------------------------------------------------------

type CstNode = { _tag: 'node'; type: string; span: { start: number; end: number }; leaves: unknown[] }
const mkNode = (type: string) =>
  (c: readonly unknown[], _r: unknown, s: { start: number; end: number }): CstNode =>
    ({ _tag: 'node', type, span: s, leaves: [...c] })

function cstParity<T>(label: string, combinator: Combinator<T>, inputs: string[]) {
  const compiled = compile(combinator)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const interp = parse(combinator, input, { trackLines: false })
      const comp = compiled.parse(input, 0)
      expect(comp.ok).toBe(interp.ok)
      if (interp.ok && comp.ok) {
        // Deep-equal covers the captured CSTLeaf value AND span, per mode.
        expect(comp.value).toEqual(interp.value)
      }
    })
  }
}

const capWs = trivia(regex(/[ \t]+/))
const NumNode = node('Num', regex(/[0-9]+/), mkNode('Num'))
const LineNode = node('Line', regex(/\/\/[^\n\r]*/), mkNode('Line'))
const BlockNode = node('Block', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//), mkNode('Block'))
const NumListNode = node(
  'Nums',
  parser({ trivia: capWs }, sepBy(regex(/[0-9]+/), literal(','))),
  mkNode('Nums'),
)

describe('scannable regex — CST leaf capture parity (interpreter vs compile())', () => {
  cstParity('chars run captured', NumNode, ['0', '42', '007'])
  cstParity('until captured', LineNode, ['// hi', '//', '// trailing\n'])
  cstParity('delimited captured', BlockNode, ['/**/', '/* a * b */'])
  cstParity('scannable terminals in a captured sepBy', NumListNode, ['1', '1, 22, 333'])

  it('captured leaf carries the scanned value and span', () => {
    const r = parse(NumNode, '4200')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaf = (r.value as CstNode).leaves.find(
      (c): c is CSTLeaf => (c as CSTLeaf)._tag === 'leaf',
    )
    expect(leaf?.value).toBe('4200')
    expect(leaf?.span).toEqual({ start: 0, end: 4 })
  })
})

describe('scannable regex — CST capture codegen', () => {
  it('captured chars run: charCodeAt + _cstLeaves.push, no exec', () => {
    const src = compile(NumNode).source
    expect(src).toContain('charCodeAt')
    expect(src).toContain('_cstLeaves.push')
    expect(src).not.toContain('.exec(input)')
  })

  it('captured delimited: charCodeAt + _cstLeaves.push, no exec', () => {
    const src = compile(BlockNode).source
    expect(src).toContain('charCodeAt')
    expect(src).toContain('_cstLeaves.push')
    expect(src).not.toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// String-literal shape:  <q>(?:[^q\\]|\\.)*<q>  — quote-delimited with escapes.
// The scan must honor escaped quotes/backslashes and the line-terminator rules
// that distinguish `\\.` (no line terminators) from `\\[\s\S]` (any char).
// ---------------------------------------------------------------------------

describe('parseScanShape — string shape', () => {
  it('recognizes double/single quoted strings with escapes', () => {
    expect(parseScanShape(/"(?:[^"\\]|\\.)*"/.source)).toEqual({
      kind: 'string', quote: 34, excluded: [[34, 34], [92, 92]], escLineTerm: false,
    })
    expect(parseScanShape(/'(?:[^'\\]|\\[\s\S])*'/.source)).toEqual({
      kind: 'string', quote: 39, excluded: [[39, 39], [92, 92]], escLineTerm: true,
    })
  })

  it('records a newline-excluding body (cp-style string)', () => {
    expect(parseScanShape(/"(?:[^"\n\\]|\\.)*"/.source)).toEqual({
      kind: 'string', quote: 34, excluded: [[34, 34], [10, 10], [92, 92]], escLineTerm: false,
    })
  })

  it('accepts escape-first arm order', () => {
    expect(parseScanShape(/'(?:\\.|[^'\\])*'/.source)?.kind).toBe('string')
  })

  it('is not the escape-aware string shape when the body lacks a backslash', () => {
    // `"[^"]*"` has no escape arm, so it is NOT the `string` shape. It is still a
    // valid non-escaped quoted token, lowered via the general `seq` chain
    // (lit `"` + negated run + lit `"`), which the native cross-check verifies.
    const s = parseScanShape(/"[^"]*"/.source)
    expect(s?.kind).toBe('seq')
    expect(s?.kind).not.toBe('string')
    // a mismatched closing quote can't be lowered as either shape.
    expect(parseScanShape(/"(?:[^"\\]|\\.)*'/.source)).toBeNull()
  })
})

describe('scannable regex — string codegen', () => {
  it('lowers a quoted string to charCodeAt without RegExp.exec', () => {
    const { source } = compile(regex(/"(?:[^"\\]|\\.)*"/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toContain('.exec(input)')
  })
})

const dqStr = regex(/"(?:[^"\\]|\\.)*"/)
const sqStr = regex(/'(?:[^'\\]|\\[\s\S])*'/)
const cpDqStr = regex(/"(?:[^"\n\\]|\\.)*"/)

describe('scannable regex — double-quoted string parity', () => {
  const modes = modesFor(
    dqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const dqStr = regex(/"(?:[^"\\\\]|\\\\.)*"/)`,
    'dqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: plain string`, () => {
      const r = run('"hi" rest')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"hi"')
      expect(r.span).toEqual({ start: 0, end: 4 })
    })
    it(`${mode}: escaped quote does not close early`, () => {
      const r = run('"a\\"b" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\\"b"')
    })
    it(`${mode}: escaped backslash then close`, () => {
      const r = run('"a\\\\" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\\\\"')
    })
    it(`${mode}: unterminated fails`, () => {
      expect(run('"abc').ok).toBe(false)
    })
    it(`${mode}: trailing backslash (no escaped char) fails`, () => {
      expect(run('"ab\\').ok).toBe(false)
    })
    it(`${mode}: backslash before newline fails (\\. excludes line terminators)`, () => {
      expect(run('"a\\\nb"').ok).toBe(false)
    })
    it(`${mode}: raw newline in body is allowed ([^"\\] matches it)`, () => {
      const r = run('"a\nb" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\nb"')
    })
  }
})

describe('scannable regex — single-quoted string with \\[\\s\\S] escapes', () => {
  const modes = modesFor(
    sqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const sqStr = regex(/'(?:[^'\\\\]|\\\\[\\s\\S])*'/)`,
    'sqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: backslash before newline is allowed ([\\s\\S])`, () => {
      const r = run("'a\\\nb' x")
      expect(r.ok).toBe(true)
      expect(r.value).toBe("'a\\\nb'")
    })
    it(`${mode}: unterminated fails`, () => {
      expect(run("'oops").ok).toBe(false)
    })
  }
})

describe('scannable regex — newline-excluding string body', () => {
  const modes = modesFor(
    cpDqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const cpDqStr = regex(/"(?:[^"\\n\\\\]|\\\\.)*"/)`,
    'cpDqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: raw newline in body fails (body excludes \\n)`, () => {
      expect(run('"a\nb"').ok).toBe(false)
    })
    it(`${mode}: single-line string still matches`, () => {
      expect(run('"ok"').value).toBe('"ok"')
    })
  }
})

// Battery cross-check: compiled scan must agree with the native anchored RegExp
// on every input, including the tricky escape/line-terminator corners.
describe('scannable regex — string matches native RegExp', () => {
  const cases: Array<{ re: RegExp; inputs: string[] }> = [
    {
      re: /"(?:[^"\\]|\\.)*"/y,
      inputs: [
        '"hi"', '"a\\"b"', '"a\\\\"', '"abc', '"ab\\', '"a\\\nb"', '"a\nb"',
        '""', '"\\t\\n"', 'no-quote', '"end"trailing',
      ],
    },
    {
      re: /'(?:[^'\\]|\\[\s\S])*'/y,
      inputs: ["''", "'a\\\nb'", "'x\\'y'", "'unterminated", "'\\\\'"],
    },
    {
      re: /"(?:[^"\n\\]|\\.)*"/y,
      inputs: ['"ok"', '"a\nb"', '"a\\nb"'],
    },
  ]
  for (const { re, inputs } of cases) {
    const compiled = compile(regex(new RegExp(re.source)))
    for (const input of inputs) {
      it(`${re.source} vs native — ${JSON.stringify(input)}`, () => {
        re.lastIndex = 0
        const native = re.exec(input)
        const nativeOk = native !== null && native.index === 0
        const r = compiled.parse(input, 0)
        expect(r.ok).toBe(nativeOk)
        if (nativeOk && r.ok) expect(r.value).toBe(native![0])
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Trivia parity — the whole point of sharing one match core: a completion-
// sensitive shape (delimited comment, escape-aware string) used as a TRIVIA arm
// must behave identically to the interpreter's oneOrMore(choice(…)) — most
// importantly, an UNTERMINATED token must stop the trivia loop (leaving it
// unconsumed) rather than being swallowed to EOF. All three modes must agree.
// ---------------------------------------------------------------------------

function triviaModes(triviaCombinator: Combinator<unknown>, macroTriviaExpr: string) {
  const g = parser({ trivia: triviaCombinator }, sequence(literal('a'), literal('b')))
  const macroCode =
    `import { regex, oneOrMore, choice, trivia, parser, sequence, literal } from 'parseman' with { type: 'macro' }\n` +
    `export const g = parser({ trivia: ${macroTriviaExpr} }, sequence(literal('a'), literal('b')))`
  return modesFor(g, macroCode, 'g')
}

/** Accept/reject parity across modes; on shared success also end + value. */
function expectTriviaParity(modes: ReturnType<typeof modesFor>, input: string) {
  const results = modes.map(([, run]) => run(input))
  const oks = results.map(r => r.ok)
  expect(new Set(oks).size, `ok parity for ${JSON.stringify(input)}`).toBe(1)
  if (results[0]!.ok) {
    expect(new Set(results.map(r => r.span.end)).size).toBe(1)
    expect(new Set(results.map(r => JSON.stringify(r.value))).size).toBe(1)
  }
}

describe('trivia parity — delimited (block comment) arm', () => {
  const modes = triviaModes(
    oneOrMore(choice(regex(/[ \t\n\r\f]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))),
    `oneOrMore(choice(regex(/[ \\t\\n\\r\\f]+/), regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)))`,
  )
  for (const [mode, run] of modes) {
    it(`${mode}: closed comment is trivia`, () => {
      expect(run('a /* c */ b').ok).toBe(true)
    })
    it(`${mode}: unterminated comment stops the loop (reject, not swallow)`, () => {
      expect(run('a /* unterminated b').ok).toBe(false)
    })
  }
  it('all modes agree', () => {
    for (const s of ['ab', 'a b', 'a/*x*/b', 'a /* u\nb', 'a /* ok */ b']) {
      expectTriviaParity(modes, s)
    }
  })
})

describe('trivia parity — escape-aware string arm', () => {
  const modes = triviaModes(
    oneOrMore(choice(regex(/[ \t]+/), regex(/'(?:[^'\\]|\\.)*'/))),
    `oneOrMore(choice(regex(/[ \\t]+/), regex(/'(?:[^'\\\\]|\\\\.)*'/)))`,
  )
  for (const [mode, run] of modes) {
    it(`${mode}: closed string is trivia`, () => {
      expect(run("a 'x' b").ok).toBe(true)
    })
    it(`${mode}: escaped quote keeps the string open`, () => {
      expect(run("a 'x\\'y' b").ok).toBe(true)
    })
    it(`${mode}: unterminated string stops the loop (reject, not swallow)`, () => {
      expect(run("a 'unterminated b").ok).toBe(false)
    })
  }
  it('all modes agree', () => {
    for (const s of ['ab', "a 'x' b", "a'y'b", "a 'no-close b", "a '\\'' b"]) {
      expectTriviaParity(modes, s)
    }
  })
})
