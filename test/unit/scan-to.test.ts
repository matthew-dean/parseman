/**
 * scanTo() and balanced() tests.
 *
 * scanTo(sentinel, { skip }) — consume input up to sentinel, skipping containers.
 * balanced(open, close, { skip }) — match a balanced delimiter pair.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, sequence, choice, transform, parse, compile, trivia } from '../../src/index.ts'
import { scanTo, balanced } from '../../src/index.ts'

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

  it('balanced with skip — skips nested same-close inside skip', () => {
    const sqStr = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
    const p = balanced('(', ')', { skip: [sqStr] })
    const r = parse(p, "(a ')'b)")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("(a ')'b)")
  })

  it('balanced stops at first close without skip', () => {
    // Without skip, the first ) terminates — nested () breaks naively
    const p = balanced('(', ')')
    const r = parse(p, '(a(b)c)')
    // Without nesting skip, stops at inner )
    if (r.ok) expect(r.value).toBe('(a(b)')   // first close wins
  })

  it('truly nested with recursive skip', () => {
    // To handle nested parens: pass balanced itself as a skipper
    // We use a forward ref pattern since balanced is recursive
    let parenGroup: ReturnType<typeof balanced>
    const sqStr = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
    // Build with lazy skip: at scan time, parenGroup is defined
    const inner = scanTo(literal(')'), {
      skip: [
        sqStr,
        { // inline lazy parser
          _tag: 'lazy',
          _meta: { firstSet: { kind: 'ranges', ranges: [{ lo: 40, hi: 40 }] }, canMatchNewline: true, isTrivia: false },
          _def: { tag: 'lazy', thunk: () => parenGroup as Combinator<unknown> },
          parse: (input, pos, ctx) => parenGroup.parse(input, pos, ctx),
        },
      ],
    })
    parenGroup = transform(
      sequence(literal('('), inner, literal(')')),
      ([o, c, cl]) => o + c + cl,
    )
    const r = parse(parenGroup, '(a(b(c))d)')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('(a(b(c))d)')
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
    const r = parse(ruleset, '.foo { color: red; }', { trivia: ws })
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
    expect(p.source).toContain('while')
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
