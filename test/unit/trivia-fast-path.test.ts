import { describe, it, expect } from 'vitest'
import { regex } from '../../src/combinators/regex.ts'
import { choice } from '../../src/combinators/choice.ts'
import { oneOrMore } from '../../src/combinators/repeat.ts'
import { trivia, label } from '../../src/combinators/map.ts'
import { parser } from '../../src/combinators/grammar.ts'
import { literal } from '../../src/combinators/literal.ts'
import { sequence } from '../../src/combinators/sequence.ts'
import { node } from '../../src/combinators/node.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { analyzeTriviaFastPath, buildFastTriviaFnDecl, buildLabeledScannableTriviaFnDecl, buildLabeledRegexTriviaFnDecl, labeledTriviaRegexArms, buildLabeledRuntimeTriviaFnDecl, analyzeLabeledScannableRun } from '../../src/compiler/trivia-fast-path.ts'
import type { LabeledTriviaSpec } from '../../src/cst/trivia-kinds.ts'

describe('trivia fast path — detection', () => {
  const ws = regex(/[ \t\n\r\f]+/)
  const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)

  const lineComment = regex(/\/\/[^\n\r]*/)
  const kinds = (rw: ReturnType<typeof trivia>) =>
    analyzeTriviaFastPath(rw)?.map(s => s.kind) ?? null

  it('detects CSS rw shape (ws + block comment)', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, comment))))).toEqual(['chars', 'delimited'])
  })

  it('detects Less rw shape (ws + block + line comment, 3 arms)', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, comment, lineComment))))).toEqual(['chars', 'delimited', 'until'])
  })

  it('detects ws + line-comment only', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, lineComment))))).toEqual(['chars', 'until'])
  })

  it('derives a char-class run structurally (any class, not a hardcoded ws set)', () => {
    // digits: not whitespace, still lowers to a char-scan run.
    const shapes = analyzeTriviaFastPath(trivia(oneOrMore(regex(/[0-9]+/))))
    expect(shapes).toEqual([{ kind: 'chars', ranges: [[48, 57]], minOne: true }])
  })

  it('does not fast-path merged alternation regex (one arm per parse)', () => {
    const rw = trivia(regex(/[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//))
    expect(analyzeTriviaFastPath(rw)).toBeNull()
  })

  it('detects ws-only trivia', () => {
    expect(kinds(trivia(regex(/[ \t]+/)))).toEqual(['chars'])
    expect(kinds(trivia(oneOrMore(ws)))).toEqual(['chars'])
  })

  it('detects \\s-based trivia (PERF_IDEAS §8a — fixed code-point set)', () => {
    expect(kinds(trivia(regex(/\s+/)))).toEqual(['chars'])
    expect(kinds(trivia(oneOrMore(regex(/\s+/))))).toEqual(['chars'])
  })

  it('returns null for non-matching trivia', () => {
    // a direct non-run regex (leading `#` literal) is not a bare char-class run.
    expect(analyzeTriviaFastPath(trivia(regex(/#[0-9a-f]+/)))).toBeNull()
  })

  it('returns null for a bare delimited regex (not a char run)', () => {
    expect(analyzeTriviaFastPath(trivia(regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)))).toBeNull()
  })

  it('returns null for oneOrMore of a single non-char scannable arm', () => {
    expect(analyzeTriviaFastPath(trivia(oneOrMore(regex(/\/\/.*/))))).toBeNull()
  })

  it('returns null for a single-arm choice (needs 2+ arms)', () => {
    expect(analyzeTriviaFastPath(trivia(oneOrMore(choice(ws))))).toBeNull()
  })

  it('recognizes many(min≥1) the same as oneOrMore', () => {
    const asManyMin1 = {
      ...oneOrMore(ws),
      _def: { tag: 'many' as const, parser: ws, min: 1 },
    } as unknown as ReturnType<typeof oneOrMore>
    expect(analyzeTriviaFastPath(trivia(asManyMin1))).toEqual(
      analyzeTriviaFastPath(trivia(oneOrMore(ws))),
    )
  })

  it('accepts an escape-aware string arm (shared completion-checked match)', () => {
    // Strings are now safe in a trivia loop: the scan is completion-checked, so
    // an unterminated string leaves `end === start` and the loop stops (parity
    // with the interpreter) instead of consuming to EOF.
    expect(kinds(trivia(oneOrMore(choice(ws, regex(/'(?:[^'\\]|\\.)*'/)))))).toEqual(['chars', 'string'])
  })
})

describe('trivia fast path — codegen', () => {
  it('emits charCodeAt loop for capturing CST grammar with CSS-like trivia', () => {
    const ws = regex(/[ \t\n\r\f]+/)
    const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
    const rw = trivia(oneOrMore(choice(ws, comment)))
    const p = node(
      'Root',
      parser({ trivia: rw }, sequence(literal('a'), literal('b'))),
      () => null,
    )
    const src = compile(p).source
    expect(src).toContain('function _tf0(input, _pos, _ctx, _cap)')
    expect(src).toContain('charCodeAt(_e + 1) === 42')
    expect(src).not.toMatch(/function _tf0[\s\S]*_re\d+\.exec/)
  })

  it('buildLabeledRuntimeTriviaFnDecl emits per-arm runtime-parser dispatch (non-regex/mixed arms)', () => {
    // This fallback is used when labeled trivia arms aren't all plain regexes
    // (e.g. a labeled arm is a sequence/node/etc.) — each arm is tried via its
    // own runtime parser slot in `_rp`, offset by `rpStartIndex`, rather than a
    // char-scan loop or a compiled regex .exec().
    const spec: LabeledTriviaSpec = {
      labels: ['ws', 'fancy'],
      arms: [
        { label: 'ws', kindIndex: 0, parser: null as never },
        { label: 'fancy', kindIndex: 1, parser: null as never },
      ],
      minRepeats: 1,
    }
    const src = buildLabeledRuntimeTriviaFnDecl('_tf3', spec, 5)
    expect(src).toContain('function _tf3(input, _pos, _ctx, _cap)')
    expect(src).toContain('_rp[5].parse(input, _e, _ctx)')
    expect(src).toContain('_rp[6].parse(input, _e, _ctx)')
    expect(src).toContain('_ctx._triviaLog.push(_e, _ce, 0)')
    expect(src).toContain('_ctx._triviaLog.push(_e, _ce, 1)')
  })

  it('buildFastTriviaFnDecl emits char-scan loop with capture hooks', () => {
    const shapes = analyzeTriviaFastPath(trivia(oneOrMore(regex(/[ \t]+/))))!
    const src = buildFastTriviaFnDecl('_tf9', shapes)
    expect(src).toContain('function _tf9(input, _pos, _ctx, _cap)')
    expect(src).toContain('charCodeAt(_e)')
    expect(src).toContain('_ctx._triviaLog.push(_pos, _e)')
  })

  it('buildLabeledScannableTriviaFnDecl emits per-arm kind capture', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
    )))
    const arms = analyzeLabeledScannableRun(rw)!
    const src = buildLabeledScannableTriviaFnDecl('_tfL', arms)
    expect(src).toContain('function _tfL(input, _pos, _ctx, _cap)')
    expect(src).toMatch(/_ctx\._triviaLog\.push\(_e, \w+, 0\)/)
    expect(src).toMatch(/_ctx\._triviaLog\.push\(_e, \w+, 1\)/)
  })

  it('labeledTriviaRegexArms returns spec when every arm is a regex', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('lineComment', regex(/\/\/.*/)),
    )))
    const spec = labeledTriviaRegexArms(rw)
    expect(spec?.labels).toEqual(['whitespace', 'lineComment'])
  })

  it('labeledTriviaRegexArms returns null when an arm is not a regex', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('slash', literal('//')),
    )))
    expect(labeledTriviaRegexArms(rw)).toBeNull()
  })

  it('buildLabeledRegexTriviaFnDecl emits regex dispatch with kind indices', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('lineComment', regex(/\/\/.*/)),
    )))
    const spec = labeledTriviaRegexArms(rw)!
    const src = buildLabeledRegexTriviaFnDecl('_tfR', spec, ['_re0', '_re1'])
    expect(src).toContain('function _tfR(input, _pos, _ctx, _cap)')
    expect(src).toContain('_re0.exec(input)')
    expect(src).toContain('_ctx._triviaLog.push(_e, _ce, 1)')
  })
})
