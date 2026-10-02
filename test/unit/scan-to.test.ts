/**
 * scanTo() and balanced() tests.
 *
 * scanTo(sentinel, { skip }) — consume input up to sentinel, skipping containers.
 * balanced(open, close, { skip }) — match a balanced delimiter pair.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, sequence, choice, transform, parse, parser, trivia, run, expect as expected } from '../../src/index.ts'
import { scanTo, balanced } from '../../src/index.ts'
import { parseValue } from '../helpers/parse-result.ts'

// ---------------------------------------------------------------------------
// Basic scanTo
// ---------------------------------------------------------------------------
describe('scanTo — basics', () => {
  it('stops just before the sentinel', () => {
    const p = scanTo(literal('{'))
    const r = parse(p, 'hello {world}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('hello ')
      expect(r.span).toEqual({ start: 0, end: 6 })
    }
  })

  it('sentinel not consumed', () => {
    const p = sequence(scanTo(literal('{')), literal('{'))
    const r = parse(p, 'abc{')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value[0]).toBe('abc')
      expect(r.value[1]).toBe('{')
    }
  })

  it('sentinel at start returns empty string', () => {
    const p = scanTo(literal('{'))
    const r = parse(p, '{rest}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('')
      expect(r.span.end).toBe(0)
    }
  })

  it('fails when sentinel not found', () => {
    const p = scanTo(literal('{'))
    expect(parse(p, 'no brace here').ok).toBe(false)
  })

  it('reports a generic "sentinel" label when the sentinel is not a literal', () => {
    const p = scanTo(regex(/;/))
    const r = parse(p, 'no semicolon')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['sentinel'])
  })

  it('orEOF: succeeds when sentinel absent', () => {
    const p = scanTo(literal('{'), { orEOF: true })
    const r = parse(p, 'no brace')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('no brace')
      expect(r.span.end).toBe(8)
    }
  })

  it('scans across newlines', () => {
    const p = scanTo(literal('END'))
    const r = parse(p, 'line1\nline2\nEND')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('line1\nline2\n')
  })
})

describe('scanTo — paired-sentinel recovery', () => {
  const boundary = choice(literal(';'), literal('{'), literal('}'))
  const jsString = sequence(literal("'"), scanTo(literal("'"), { raw: true }), literal("'"))
  const body = scanTo(literal('`'), {
    recoverAt: boundary,
    stopAt: literal('\\\n'),
    skip: [jsString, balanced('(', ')', { strict: true }), balanced('{', '}', { strict: true })],
  })

  it('keeps a complete payload containing a recovery delimiter', () => {
    expect(parseValue(body, 'let x = 1; x`;')).toBe('let x = 1; x')
  })

  it('keeps a complete object before an outer block delimiter', () => {
    expect(parseValue(body, '{ answer: 42 }` {')).toBe('{ answer: 42 }')
  })

  it('recovers an unfinished payload before a later complete payload', () => {
    const result = parse(body, 'bad; second: `good`;')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe('bad')
      expect(result.span).toEqual({ start: 0, end: 3 })
    }
  })

  it('accepts the first sentinel when later complete payloads preserve odd parity', () => {
    expect(parseValue(body, 'one; still one` next: `two`;')).toBe('one; still one')
  })

  it('does not treat recovery delimiters inside a skipper as outer boundaries', () => {
    expect(parseValue(body, 'fn(\';\'); done`;')).toBe("fn(';'); done")
  })

  it('lets an opaque skipper win when it shares a recovery opener', () => {
    expect(parseValue(body, 'start; { value: `inner` } end`;'))
      .toBe('start; { value: `inner` } end')
  })

  it('rolls back errors produced after the retained sentinel', () => {
    const diagnosticSkipper = sequence(literal('('), expected(literal(')')))
    const source = scanTo(literal('`'), {
      recoverAt: literal(';'),
      skip: [diagnosticSkipper],
    })
    const result = run(source, 'one; done`(;')
    expect(result.ok).toBe(true)
    expect(result.value).toBe('one; done')
    expect(result.errors).toEqual([])
  })

  it('rolls back errors from a failed skipper after it recorded a diagnostic', () => {
    const diagnosticSkipper = sequence(
      literal('('),
      expected(literal(')')),
      literal('!'),
    )
    const skipperResult = run(diagnosticSkipper, '(;')
    expect(skipperResult.ok).toBe(false)
    expect(skipperResult.errors).toHaveLength(1)

    const source = scanTo(literal('`'), {
      recoverAt: choice(literal(';'), literal('(')),
      skip: [diagnosticSkipper],
    })
    const result = run(source, 'fn(; next: `good`;')
    expect(result.ok).toBe(true)
    expect(result.value).toBe('fn')
    expect(result.errors).toEqual([])
  })

  it('stops at a hard boundary without crossing the following line', () => {
    const result = parse(body, 'unfinished\\\nnext: `value`;')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('unfinished')
  })

  it('lets a hard stop win over an overlapping skipper', () => {
    const source = scanTo(literal('`'), {
      stopAt: literal('\n'),
      skip: [regex(/\s+/)],
    })
    const result = parse(source, 'unfinished\nnext: `value`;')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe('unfinished')
      expect(result.span).toEqual({ start: 0, end: 10 })
    }
  })

  it('does not let an advancing skipper cross a hard stop inside its span', () => {
    const source = scanTo(literal('`'), {
      stopAt: literal('\n'),
      skip: [regex(/\s+/)],
    })
    const result = parse(source, 'unfinished \nnext: `value`;')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe('unfinished ')
      expect(result.span).toEqual({ start: 0, end: 11 })
    }
  })

  it('drops skipper errors recorded beyond an interior hard stop', () => {
    const diagnosticWhitespace = sequence(
      literal(' '),
      expected(literal('?')),
      literal('\n'),
    )
    const skipperResult = run(diagnosticWhitespace, ' \n')
    expect(skipperResult.ok).toBe(true)
    expect(skipperResult.errors).toHaveLength(1)

    const source = scanTo(literal('`'), {
      stopAt: literal('\n'),
      skip: [diagnosticWhitespace],
    })
    const result = run(source, 'unfinished \nnext: `value`;')
    expect(result.ok).toBe(true)
    expect(result.value).toBe('unfinished ')
    expect(result.errors).toEqual([])
  })

  it('rolls back errors from a failed hard-stop probe', () => {
    const diagnosticStop = sequence(
      literal('!'),
      expected(literal('?')),
      literal('#'),
    )
    const stopResult = run(diagnosticStop, '!;')
    expect(stopResult.ok).toBe(false)
    expect(stopResult.errors).toHaveLength(1)

    const source = scanTo(literal('`'), {
      recoverAt: literal(';'),
      stopAt: diagnosticStop,
    })
    const result = run(source, 'one! still one`;')
    expect(result.ok).toBe(true)
    expect(result.value).toBe('one! still one')
    expect(result.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Skip patterns
// ---------------------------------------------------------------------------
describe('scanTo — skip patterns', () => {
  const dqString = sequence(literal('"'), scanTo(literal('"'), { orEOF: false }), literal('"'))
  const sqString = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
  const lineComment = sequence(literal('//'), scanTo(literal('\n'), { orEOF: true }))
  const blockComment = sequence(literal('/*'), scanTo(literal('*/'), { orEOF: false }), literal('*/'))

  it('skips a double-quoted string containing the sentinel', () => {
    const p = scanTo(literal('{'), { skip: [dqString] })
    // The '{' inside the string should be ignored
    const r = parse(p, 'a "has{brace}" {real}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('a "has{brace}" ')
  })

  it('skips single-quoted string containing the sentinel', () => {
    const p = scanTo(literal('{'), { skip: [dqString, sqString] })
    const r = parse(p, "a '{' {real}")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("a '{' ")
  })

  it('skips line comments', () => {
    const p = scanTo(literal('{'), { skip: [lineComment] })
    const r = parse(p, 'a // { fake\n{real}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('a // { fake\n')
  })

  it('skips block comments', () => {
    const p = scanTo(literal('{'), { skip: [blockComment] })
    const r = parse(p, 'a /* { fake */ {real}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('a /* { fake */ ')
  })

  it('skips multiple skip kinds in one scan', () => {
    const p = scanTo(literal('{'), { skip: [blockComment, dqString, sqString] })
    const r = parse(p, '/* { */ a "b{c}" \'d{e}\' {real}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("/* { */ a \"b{c}\" 'd{e}' ")
  })
})

// ---------------------------------------------------------------------------
// balanced()
// ---------------------------------------------------------------------------
describe('balanced()', () => {
  it('matches simple balanced pair', () => {
    const p = balanced('(', ')')
    const r = parse(p, '(hello)')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('(hello)')
  })

  it('falls back to a single-char content run when a skip has an unbounded first-set', () => {
    // A skip whose firstSet is `any` (regex `.`) makes firstSetClassChars return
    // null → `bounded = false` → the interior content run scans one char at a time
    // so the skip arm always gets a chance to match at its position.
    const anySkip = sequence(literal('@'), regex(/./))
    const p = balanced('(', ')', { skip: [anySkip] })
    const r = parse(p, '(a@)b)')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('(a@)b)')
  })

  it('treats a wide-range skip first-set (>8 chars) as unbounded', () => {
    // regex(/[a-z].../) has a first-set range wider than 8 code points, so
    // firstSetClassChars returns null and the content run degrades to one char.
    const wideSkip = sequence(regex(/[a-z]/), literal('!'))
    const p = balanced('(', ')', { skip: [wideSkip] })
    const r = parse(p, '(x!y)')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('(x!y)')
  })

  it('balanced with skip — skips nested same-close inside skip', () => {
    const sqStr = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
    const p = balanced('(', ')', { skip: [sqStr] })
    const r = parse(p, "(a ')'b)")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("(a ')'b)")
  })

  it('handles same-delimiter nesting automatically (depth-counted)', () => {
    // balanced() skips nested same-delimiter pairs via an internal self-reference,
    // so the FIRST close no longer wins — depth is respected.
    const p = balanced('(', ')')
    expect(parseValue(p, '(a(b)c)')).toBe('(a(b)c)')
    expect(parseValue(p, '(a(b(c))d)')).toBe('(a(b(c))d)')
    expect(parseValue(balanced('{', '}'), '{{x}}')).toBe('{{x}}')
    expect(parseValue(balanced('{', '}'), '{{{deep}}}')).toBe('{{{deep}}}')
  })

  it('handles well-formed mixed-delimiter nesting', () => {
    // In a scanTo skip-set, each balanced() skips its own kind; well-formed input
    // always escorts a close with its matching open, so cross-delimiter nesting at
    // any depth is consumed intact.
    const st = scanTo(choice(literal(';'), literal('}')), {
      skip: [balanced('(', ')'), balanced('[', ']'), balanced('{', '}')],
    })
    for (const body of ['(({[{}]}))', '({()})', '([{}])', '({[({[]})]})', '{1, {2}, [3]}']) {
      const r = parse(st, body + ';')
      expect(r.ok).toBe(true)
      expect(body.slice(0, r.span.end ? body.length : 0)).toBe(body) // sanity
      expect((body + ';').slice(0, r.span.end)).toBe(body)
    }
  })
})

// ---------------------------------------------------------------------------
// CSS/Less-style selector peeking (the motivating use case)
// ---------------------------------------------------------------------------
describe('CSS-style selector scan', () => {
  // Minimal CSS-like hole parsers
  const dqStr = sequence(literal('"'), scanTo(literal('"'), { orEOF: false }), literal('"'))
  const sqStr = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
  const urlFn = sequence(literal('url('), scanTo(literal(')'), { skip: [dqStr, sqStr] }), literal(')'))
  const parenGrp = balanced('(', ')', { skip: [dqStr, sqStr, urlFn] })
  const bracketGrp = balanced('[', ']', { skip: [dqStr, sqStr] })
  const blockComment = sequence(literal('/*'), scanTo(literal('*/'), { orEOF: false }), literal('*/'))

  const selector = scanTo(literal('{'), {
    skip: [blockComment, dqStr, sqStr, urlFn, parenGrp, bracketGrp],
  })

  it('scans a simple class selector', () => {
    const r = parse(selector, '.foo {')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('.foo ')
  })

  it('skips attribute selectors containing {', () => {
    // [attr="{"] should not stop the scan
    const r = parse(selector, 'div[attr="{"] {')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('div[attr="{"] ')
  })

  it('skips :not() and complex pseudo-selectors', () => {
    const r = parse(selector, 'div:not(.a, .b) {')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('div:not(.a, .b) ')
  })

  it('skips url() in a mixin call argument', () => {
    const r = parse(selector, '.mixin(url("a{b}")) {')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('.mixin(url("a{b}")) ')
  })

  it('skips block comments containing {', () => {
    const r = parse(selector, '.a /* { */ .b {')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('.a /* { */ .b ')
  })

  it('combined — no sentinel means not a ruleset (fail)', () => {
    // Declarations end in ';' not '{', so selector scan should fail
    const r = parse(selector, 'color: red;')
    expect(r.ok).toBe(false)
  })

  it('full ruleset sequence: selector + block', () => {
    const ws = trivia(regex(/\s*/))
    const decl = transform(
      sequence(
        regex(/[a-z-]+/),
        literal(':'),
        scanTo(choice(literal(';'), literal('}')), { skip: [dqStr, sqStr, urlFn] }),
        choice(literal(';'), literal('}')),
      ),
      ([prop,, value]) => ({ prop, value: value.trim() })
    )
    const ruleset = transform(
      sequence(selector, literal('{'), decl, literal('}')),
      ([sel,, d]) => ({ selector: sel.trim(), declarations: [d] })
    )
    const r = parser({ trivia: ws }, ruleset).parse('.foo { color: red; }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.selector).toBe('.foo')
      expect(r.value.declarations[0]?.prop).toBe('color')
      expect(r.value.declarations[0]?.value).toBe('red')
    }
  })
})

// ---------------------------------------------------------------------------
// Compiled parity
// ---------------------------------------------------------------------------
describe('scanTo — compiled', () => {
  it('compiles without runtime fallback', () => {
    const p = compile(scanTo(literal('{')))
    expect(p.source).not.toContain('_rp[')
  })

  it('compiled result matches runtime', () => {
    const dqStr = sequence(literal('"'), scanTo(literal('"'), { orEOF: false }), literal('"'))
    const p = scanTo(literal('{'), { skip: [dqStr] })
    const input = 'a "b{c}" {real}'
    const rt = parse(p, input)
    const cmp = compile(p).parse(input)
    expect(rt.ok).toBe(true)
    expect(cmp.ok).toBe(true)
    expect(rt.ok && rt.value).toBe(cmp.ok && cmp.value)
  })

  it('balanced compiles', () => {
    const p = compile(balanced('(', ')'))
    const r = p.parse('(hello world)')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('(hello world)')
  })
})

// ---------------------------------------------------------------------------
// balanced() — cut after open: an unmatched open reports + recovers
// ---------------------------------------------------------------------------
import { parse as _parseB } from '../../src/index.ts'
import type { ParseError as _PE } from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'

describe('balanced() — unmatched open reports an error', () => {
  it('well-formed input records NO error (unchanged behaviour)', () => {
    const r = _parseB(balanced('(', ')'), '(a(b)c)', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('(a(b)c)')
      expect(r.errors).toHaveLength(0)
    }
  })

  it('unmatched open records "expected close" + recovers', () => {
    const r = _parseB(balanced('(', ')'), '(a(b)c', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.errors as _PE[]).length).toBeGreaterThanOrEqual(1)
      expect((r.errors as _PE[])[0]!.expected).toContain('")"')
    }
  })

  it('reports through a scanTo skip set (the css/less use)', () => {
    // prelude-style scan: stop at `{`, skipping balanced parens. An unmatched `(`
    // in the prelude must surface an error rather than be swallowed silently.
    const prelude = scanTo(literal('{'), { skip: [balanced('(', ')')], orEOF: true })
    const r = _parseB(prelude, '(missing bracket here', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.errors as _PE[]).length).toBeGreaterThanOrEqual(1)
  })
})
