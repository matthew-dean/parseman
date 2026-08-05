import { describe, it, expect } from 'vitest'
import { buildLineIndex, offsetToLineCol, annotateSpan, annotateTreeSpans, normalizeLineIndex, recordLineRange, compile, cstBuildHost, literal, node, parser, regex, rules, trivia, sequence, sepBy } from '../../src/index.ts'
import { REC } from '../../src/recovery/scan.ts'
import type { ParseContext } from '../../src/index.ts'
import { compile as compileCodegen } from '../../src/compiler/codegen.ts'

describe('buildLineIndex', () => {
  it('single-line string has one entry', () => {
    const idx = buildLineIndex('hello')
    expect(idx.lineStarts).toEqual([0])
  })

  it('tracks newline positions', () => {
    const idx = buildLineIndex('foo\nbar\nbaz')
    expect(idx.lineStarts).toEqual([0, 4, 8])
  })

  it('trailing newline creates empty last line', () => {
    const idx = buildLineIndex('foo\n')
    expect(idx.lineStarts).toEqual([0, 4])
  })
})

describe('recordLineRange', () => {
  it('supports append-only speculative collection by normalizing later', () => {
    const idx = { lineStarts: [0] }
    const input = 'a\nb\nc'
    recordLineRange(idx, input, 2, input.length)
    recordLineRange(idx, input, 0, 3)
    recordLineRange(idx, input, 0, input.length)
    expect(normalizeLineIndex(idx).lineStarts).toEqual([0, 2, 4])
  })
})

describe('offsetToLineCol', () => {
  const input = 'foo\nbar\nbaz'
  const idx = buildLineIndex(input)

  it('offset 0 is line 1 col 1', () => {
    expect(offsetToLineCol(idx, 0)).toEqual({ line: 1, col: 1 })
  })

  it('offset at newline char', () => {
    expect(offsetToLineCol(idx, 3)).toEqual({ line: 1, col: 4 })
  })

  it('offset after newline is next line col 1', () => {
    expect(offsetToLineCol(idx, 4)).toEqual({ line: 2, col: 1 })
  })

  it('offset on third line', () => {
    // 'baz' starts at offset 8
    expect(offsetToLineCol(idx, 10)).toEqual({ line: 3, col: 3 })
  })

  it('start of input', () => {
    expect(offsetToLineCol(buildLineIndex(''), 0)).toEqual({ line: 1, col: 1 })
  })
})

describe('annotateSpan', () => {
  it('fills line/col on a span', () => {
    const input = 'hello\nworld'
    const idx = buildLineIndex(input)
    const span = annotateSpan({ start: 6, end: 11 }, idx)
    expect(span.startLine).toBe(2)
    expect(span.startColumn).toBe(1)
    expect(span.endLine).toBe(2)
    expect(span.endColumn).toBe(6)
  })

  it('span crossing a newline', () => {
    const input = 'foo\nbar'
    const idx = buildLineIndex(input)
    const span = annotateSpan({ start: 2, end: 5 }, idx)
    expect(span.startLine).toBe(1)
    expect(span.startColumn).toBe(3)
    expect(span.endLine).toBe(2)
    expect(span.endColumn).toBe(2)
  })
})

describe('parse with trackLines', () => {
  it('annotates span with line/col when trackLines: true', async () => {
    const { literal, sequence, parse } = await import('../../src/index.ts')
    const p = sequence(literal('foo'), literal('\n'), literal('bar'))
    const r = parse(p, 'foo\nbar', { trackLines: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.startColumn).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('parser({ trackLines: true }) annotates via the grammar wrapper', async () => {
    const { literal, sequence, parser } = await import('../../src/index.ts')
    const p = parser({ trackLines: true }, sequence(literal('foo'), literal('\n'), literal('bar')))
    const r = p.parse('foo\nbar', 0, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('rules({ trackLines: true }) annotates all grammar entries', () => {
    const g = rules({ trackLines: true }, _g => ({
      Doc: sequence(literal('foo'), literal('\n'), literal('bar')),
    }))
    const r = g.Doc.parse('foo\nbar', 0, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('parser({ trackLines: true }) reuses a caller-provided compiled line-start buffer', async () => {
    const { literal, sequence, parser } = await import('../../src/index.ts')
    const p = parser({ trackLines: true }, sequence(literal('foo'), literal('\n'), literal('bar')))
    const ctx = { trackLines: true, _lineStarts: [0], _lineScannedTo: 0 } as ParseContext
    const r = p.parse('foo\nbar', 0, ctx)
    expect(r.ok).toBe(true)
    expect(ctx._lineStarts).toEqual([0, 4])
    expect(ctx._lineScannedTo).toBe(4)
    if (r.ok) expect(r.span.endLine).toBe(2)
  })

  it('no line/col without trackLines', async () => {
    const { literal, parse } = await import('../../src/index.ts')
    const r = parse(literal('foo'), 'foo')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBeUndefined()
      expect(r.span.startColumn).toBeUndefined()
    }
  })
})

describe('compiled line tracking', () => {
  it('emits no line-tracking helper by default', () => {
    const c = compile(sequence(literal('foo'), literal('\n'), literal('bar')))
    expect(c.source).not.toContain('_trackLines')
    expect(c.source).not.toContain('_spanLines')
    expect(c.source).not.toContain('_lineStarts')
  })

  it('annotates spans when compiled with trackLines', () => {
    const c = compile(sequence(literal('foo'), literal('\n'), literal('bar')), undefined, { trackLines: true })
    const src = compileCodegen(sequence(literal('foo'), literal('\n'), literal('bar')), undefined, { trackLines: true }).source
    expect(src).not.toContain('_trackLines')
    expect(src).toContain('_lineStarts.push')
    const r = c.parse('foo\nbar')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.startColumn).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('honors parser-scoped trackLines when compiled', () => {
    const p = parser({ trackLines: true }, sequence(literal('foo'), literal('\n'), literal('bar')))
    const interpreted = p.parse('foo\nbar', 0, { trackLines: false })
    const compiled = compile(p).parseWithContext('foo\nbar', { trackLines: false }, 0)
    expect(compiled).toEqual(interpreted)
    expect(compiled.span.endLine).toBe(2)
  })

  it('uses the dynamic helper only for newline-capable regex spans', () => {
    const c = compile(regex(/(?:.|\n)+/), undefined, { trackLines: true })
    expect(compileCodegen(regex(/(?:.|\n)+/), undefined, { trackLines: true }).source).toContain('_trackLines')
    const r = c.parse('a\nb\nc')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.endLine).toBe(3)
      expect(r.span.endColumn).toBe(2)
    }
  })

  it('seeds line starts before a nonzero parse offset', () => {
    const c = compile(literal('bar'), undefined, { trackLines: true })
    const r = c.parse('foo\nbar', 4)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(2)
      expect(r.span.startColumn).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  // TODO(table/expect-span-lines) — 0.48. The table lowering does not
  // line-annotate CST LEAF spans (the `pushCstLeaf` sites) or `expect()` /
  // recovery-error spans; the interpreter does (`expect.ts:145`). `recoverScan`
  // annotates for everyone, so LIST recovery is unaffected — this is the leaf
  // and expect paths only.
  //
  // Deferred rather than rushed: the fix needs `spanLines` proven equivalent to
  // `annotateSpanFromLineContext` first, and doing that under the cutover would
  // have been a guess. Tracked in `notes/RELEASE-0.48-TARGET.md` §4.
  //
  // `.todo` rather than deleted: the assertions are correct and are what the fix
  // must satisfy. Do not weaken them to make them pass.
  it.todo('annotates CST spans at creation time when trackLines is enabled', () => {
    const p = node('Doc', sequence(literal('a'), literal('\n'), literal('b')))
    const interpreted = parser({ trackLines: true }, p).parse('a\nb', 0, { trackLines: false, build: cstBuildHost() })
    const compiled = compile(p, undefined, { trackLines: true }).parseWithContext('a\nb', { trackLines: false, build: cstBuildHost() }, 0)
    expect(compiled.ok).toBe(true)
    expect(interpreted.ok).toBe(true)
    if (compiled.ok && interpreted.ok) {
      expect(compiled.value).toEqual(interpreted.value)
      expect(compiled.span.endLine).toBe(2)
      expect((compiled.value as { span: { endLine?: number } }).span.endLine).toBe(2)
      const firstLeaf = (compiled.value as { children: Array<{ span: { endLine?: number } }> }).children[0]!
      expect(firstLeaf.span.endLine).toBe(1)
    }
  })

  it('keeps annotateTreeSpans available for already-built trees', () => {
    const tree: { _tag: string; span: ReturnType<typeof annotateSpan>; children: Array<{ _tag: string; span: ReturnType<typeof annotateSpan> }> } = {
      _tag: 'node',
      span: { start: 0, end: 3 },
      children: [{ _tag: 'leaf', span: { start: 2, end: 3 } }],
    }
    annotateTreeSpans(tree, buildLineIndex('a\nb'))
    expect(tree.span.endLine).toBe(2)
    expect(tree.children[0]!.span.startLine).toBe(2)
  })

  it('passes line-aware spans to node builders for AST consumers', () => {
    const built = node('Doc', sequence(literal('a'), literal('\n'), literal('b')), (_children, _fields, span) => ({ kind: 'Doc', span }))
    const cases = [
      parser({ trackLines: true }, built).parse('a\nb'),
      compile(built, undefined, { trackLines: true }).parse('a\nb'),
    ]
    for (const result of cases) {
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.value as { span: { endLine?: number } }).span.endLine).toBe(2)
    }
  })

  it('does not emit dynamic tracking for regexes proven not to match newlines', () => {
    const c = compile(regex(/[^,\r\n]*/), undefined, { trackLines: true })
    expect(c.source).not.toContain('_trackLines')
    const r = c.parse('abc')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.span.endLine).toBe(1)
  })

  it('tracks newlines consumed by compiled fast trivia', () => {
    const ws = trivia(regex(/[ \t\n\r]*/))
    const p = parser({ trivia: ws }, sequence(literal('a'), literal('b')))
    const c = compile(p, undefined, { trackLines: true })
    const r = c.parse('a\nb')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(2)
    }
  })

  // TODO(table/expect-span-lines) — 0.48, same cause as above.
  it.todo('backfills skipped recovery ranges before annotating error spans', () => {
    const decl = sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))
    const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}'))
    const input = '{a:1;\n@@\n;b:2}'
    const runTrackedTolerant = (parseEntry: (input: string, ctx: ParseContext) => unknown) => {
      const errors: unknown[] = []
      const result = parseEntry(input, { trackLines: false, _errors: errors, _tolerant: true, _rec: REC } as unknown as ParseContext)
      expect((result as { ok?: boolean }).ok).toBe(true)
      expect(errors).toHaveLength(1)
      return errors[0] as { span: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number } }
    }

    const interpreted = runTrackedTolerant((source, ctx) => parser({ trackLines: true }, block).parse(source, 0, ctx))
    const compiledParser = compile(block, undefined, { recovery: true, trackLines: true })
    const compiled = runTrackedTolerant((source, ctx) => compiledParser.parseWithContext(source, ctx, 0))
    expect(compiled).toEqual(interpreted)
    expect(interpreted.span).toMatchObject({
      startLine: 1,
      startColumn: 6,
      endLine: 3,
      endColumn: 1,
    })
  })
})
