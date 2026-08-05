import { describe, expect, it } from 'vitest'
import { cstBuildHost, literal, node, optional, rules, run, sequence, withCtx } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'

const leafValue = (value: unknown) =>
  typeof value === 'object' && value !== null && (value as { _tag?: string })._tag === 'leaf'
    ? (value as { value: string }).value
    : undefined

describe('cstBuildHost options', () => {
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
    const compiled = compile(Doc, undefined, { hostMode: 'cst' })
    const ctx = { trackLines: false, build: cstBuildHost({ collapse: type => type === 'Wrap' }) }
    const result = compiled.parseWithContext('ab', ctx, 0)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = result.value as { children: unknown[] }
    expect((doc.children[0] as { type?: string }).type).toBe('Inner')
    expect((doc.children[1] as { type?: string }).type).toBe('Keep')
    expect(compiled.source).toContain('_parsemanCstCollapse')
  })

  // The collapse branch is gated on `cstOutput || (!build && project === undefined)`, so
  // under a positioned-CST host it is reached BEFORE the `project` branch. Only
  // structural/direct-builder nodes were covered, leaving that ordering unasserted in
  // either engine.
  it('collapses a one-child `project` node under a CST host, in both engines', () => {
    const Projected = node('Projected', Inner, { project: 0 })
    const ProjDoc = node('ProjDoc', sequence(Projected, Keep))
    const host = () => cstBuildHost({ collapse: ['Projected'] })

    const interpreted = run(ProjDoc, 'ab', { build: host() })
    expect(interpreted.ok).toBe(true)
    const idoc = interpreted.value as { children: unknown[] }
    expect((idoc.children[0] as { type?: string }).type).toBe('Inner')

    const compiled = compile(ProjDoc, undefined, { hostMode: 'cst' })
    const result = compiled.parseWithContext('ab', { trackLines: false, build: host() }, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cdoc = result.value as { children: unknown[] }
    expect((cdoc.children[0] as { type?: string }).type).toBe('Inner')
    // Not collapsed: the projected node is still host-built and keeps its own identity.
    const uncollapsed = run(ProjDoc, 'ab', { build: cstBuildHost({ collapse: ['Nothing'] }) })
    expect(((uncollapsed.value as { children: unknown[] }).children[0] as { type?: string }).type).toBe('Projected')
  })

  it('collapse predicate receives inferred rule names and structural child lists', () => {
    const seen: Array<{ type: string; childType: string | undefined; childCount: number; rawCount: number }> = []
    const g = rules(r => ({
      Inner: node(literal('a')),
      Wrap: node(r.Inner),
    }))
    const result = run(g.Wrap, 'a', {
      build: cstBuildHost({
        collapse: (type, child, children, rawChildren) => {
          seen.push({
            type,
            childType: (child as { type?: string }).type,
            childCount: children.length,
            rawCount: rawChildren.length,
          })
          return type === 'Wrap'
        },
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({ _tag: 'node', type: 'Inner' })
    expect(seen).toEqual([
      { type: 'Inner', childType: undefined, childCount: 1, rawCount: 1 },
      { type: 'Wrap', childType: 'Inner', childCount: 1, rawCount: 1 },
    ])
  })

  it('collapse true keeps zero-child structural wrappers', () => {
    const Empty = node('Empty', optional(literal('a')))
    const result = run(Empty, '', { build: cstBuildHost({ collapse: true }) })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      _tag: 'node',
      type: 'Empty',
      children: [],
    })
  })

  it('keeps cstBuildHost itself usable as the direct default host', () => {
    cstBuildHost({ collapse: true })
    const result = run(Wrap, 'a', { build: cstBuildHost })

    expect(result.ok).toBe(true)
    expect((result.value as { type?: string }).type).toBe('Wrap')
  })

  it('cstBuildHost() preserves grammar state in the BuildHost state slot', () => {
    const DocWithState = withCtx({ mode: 'strict' }, node('Doc', literal('a')))
    const result = run(DocWithState, 'a', { build: cstBuildHost() })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      _tag: 'node',
      type: 'Doc',
      state: { mode: 'strict' },
    })
  })

  it('materializes grammar tags only when requested', () => {
    const Tagged = node('Tagged', literal('a'), { tags: ['Statement', 'Primary'] })

    const plain = run(Tagged, 'a', { build: cstBuildHost() })
    const directDefault = run(Tagged, 'a', { build: cstBuildHost })
    const tagged = run(Tagged, 'a', { build: cstBuildHost({ tags: true }) })

    expect(plain.ok).toBe(true)
    expect(directDefault.ok).toBe(true)
    expect(tagged.ok).toBe(true)
    expect(plain.ok && plain.value).not.toHaveProperty('tags')
    expect(directDefault.ok && directDefault.value).not.toHaveProperty('tags')
    expect(tagged.ok && tagged.value).toMatchObject({
      _tag: 'node',
      type: 'Tagged',
      tags: ['Statement', 'Primary'],
    })
  })

  it('compile(): materializes grammar tags through the CST host', () => {
    const Tagged = node('Tagged', literal('a'), { tags: ['Statement'] })
    const compiled = compile(Tagged, undefined, { hostMode: 'cst' })
    const result = compiled.parseWithContext('a', { trackLines: false, build: cstBuildHost({ tags: true }) }, 0)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      _tag: 'node',
      type: 'Tagged',
      tags: ['Statement'],
    })
  })
})
