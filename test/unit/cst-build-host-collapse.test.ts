import { describe, expect, it } from 'vitest'
import { compile, cstBuildHost, literal, node, run, sequence } from '../../src/index.ts'

const leafValue = (value: unknown) =>
  typeof value === 'object' && value !== null && (value as { _tag?: string })._tag === 'leaf'
    ? (value as { value: string }).value
    : undefined

describe('cstBuildHost({ collapse })', () => {
  const Inner = node('Inner', literal('a'))
  const Wrap = node('Wrap', Inner)
  const Keep = node('Keep', literal('b'))
  const Doc = node('Doc', sequence(Wrap, Keep))

  it('interpreter: collapses only selected one-child CST wrappers', () => {
    const result = run(Doc, 'ab', { build: cstBuildHost({ collapse: ['Wrap'] }) })

    expect(result.ok).toBe(true)
    const doc = result.value as { children: unknown[] }
    expect((doc.children[0] as { type?: string }).type).toBe('Inner')
    expect((doc.children[1] as { type?: string }).type).toBe('Keep')
    expect(leafValue((doc.children[1] as { children: unknown[] }).children[0])).toBe('b')
  })

  it('compile(): applies the same host policy without a post-walk', () => {
    const compiled = compile(Doc)
    const ctx = { trackLines: false, build: cstBuildHost({ collapse: type => type === 'Wrap' }) }
    const result = compiled.parseWithContext('ab', ctx, 0)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = result.value as { children: unknown[] }
    expect((doc.children[0] as { type?: string }).type).toBe('Inner')
    expect((doc.children[1] as { type?: string }).type).toBe('Keep')
    expect(compiled.source).toContain('_parsemanCstCollapse')
  })

  it('keeps cstBuildHost itself usable as the direct default host', () => {
    cstBuildHost({ collapse: true })
    const result = run(Wrap, 'a', { build: cstBuildHost })

    expect(result.ok).toBe(true)
    expect((result.value as { type?: string }).type).toBe('Wrap')
  })
})
