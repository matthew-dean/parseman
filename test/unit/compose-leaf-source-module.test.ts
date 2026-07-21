import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'

describe('composeLeaf source-private recognition modules', () => {
  it('macro-lowers a sibling .ts grammar imported through its future .js specifier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-source-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'recognition.ts'), `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('x') }))
`)
      const leaf = transformMacro(`
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.js'
export const parser = composeLeaf([
  recognition,
  rules(g => ({ Document: node('Document', g.Atom, (_children, _fields, span) => ({ type: 'Document', span })) })),
])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))

      expect(leaf?.warnings).toEqual([])
      expect(leaf?.code).not.toMatch(/\bcomposeLeaf\s*\(/)
      expect(leaf?.code).not.toContain('new Function')
      expect(leaf?.code).toContain('_r_Atom')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('instruments final composeLeaf winners through imported recognition and a local reduction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-coverage-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'recognition.ts'), `
import { literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Opaque: sequence(literal('@x'), literal('{'), g.Body), Body: regex(/[a-z]+/) }))
`)
      const source = `
import { composeLeaf, literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const parser = composeLeaf([
  recognition,
  rules(g => ({ Document: node('Document', sequence(g.Opaque, literal('}')), children => ({ type: 'Document', children })) })),
])
`
      const ordinary = transformMacro(source, path.join(dir, 'leaf.ts'), new Set(['parseman']))!
      const covered = transformMacro(source, path.join(dir, 'leaf.ts'), new Set(['parseman']), false, false, true)!
      expect(ordinary.warnings).toEqual([])
      expect(covered.warnings).toEqual([])
      expect(ordinary.code).not.toContain('_grammarCoverage')
      expect(covered.code).toContain('_grammarCoverage')
      expect(covered.code).not.toMatch(/\bcomposeLeaf\s*\(/)

      const makeParser = (code: string) => new Function(code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn parser')() as Record<string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>
      const ordinaryParser = makeParser(ordinary.code)
      const parser = makeParser(covered.code)
      const hits: string[] = []
      const events: Array<{ id: string; phase: string }> = []
      const ctx = {
        _grammarCoverage: (id: string) => hits.push(id),
        _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) },
      }
      const coveredResult = parser.Document!('@x{nested}', 0, ctx)
      expect(coveredResult).toMatchObject({ ok: true })
      expect(coveredResult).toEqual(ordinaryParser.Document!('@x{nested}', 0, {}))
      expect(hits).toEqual(expect.arrayContaining(['rule:Document', 'rule:Opaque', 'rule:Body']))
      expect(events.map(event => `${event.id}/${event.phase}`)).toEqual(expect.arrayContaining([
        'rule:Document/enter',
        'rule:Opaque/enter',
        'rule:Body/enter',
        'rule:Body/success',
        'rule:Opaque/success',
      ]))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats Parseman balanced() reconstruction as recognition-only in composeLeaf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-balanced-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'recognition.ts'), `
import { balanced, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Group: balanced('(', ')') }))
`)
      const source = `
import { composeLeaf, literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const parser = composeLeaf([
  recognition,
  rules(g => ({ Document: node('Document', sequence(g.Group, literal('!')), children => ({ type: 'Document', children })) })),
])
`
      const result = transformMacro(source, path.join(dir, 'leaf.ts'), new Set(['parseman']), false, false, true)!
      expect(result.warnings).toEqual([])
      const parser = new Function(result.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn parser')() as Record<string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>
      const hits: string[] = []
      expect(parser.Document!('(nested)!', 0, { _grammarCoverage: (id: string) => hits.push(id) })).toMatchObject({ ok: true })
      expect(hits).toEqual(expect.arrayContaining(['rule:Group', 'rule:Document']))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honors an explicit .ts import over a sibling emitted .js artifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-explicit-source-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'recognition.ts'), `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('x') }))
`)
      fs.writeFileSync(path.join(dir, 'recognition.js'), 'export const recognition = {}')
      const leaf = transformMacro(`
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const parser = composeLeaf([recognition, rules(g => ({ Document: g.Atom }))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))
      expect(leaf?.warnings).toEqual([])
      expect(leaf?.code).not.toMatch(/\bcomposeLeaf\s*\(/)
      expect(leaf?.code).toContain('_r_Atom')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refreshes the source-private IR cache when its source mtime changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-source-cache-'))
    const recognition = path.join(dir, 'recognition.ts')
    const leafSource = `
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const parser = composeLeaf([recognition, rules(g => ({ Document: g.Atom }))])
`
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(recognition, `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('x') }))
`)
      const first = transformMacro(leafSource, path.join(dir, 'leaf.ts'), new Set(['parseman']))!
      fs.writeFileSync(recognition, `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('y') }))
`)
      const future = new Date(Date.now() + 2_000)
      fs.utimesSync(recognition, future, future)
      const second = transformMacro(leafSource, path.join(dir, 'leaf.ts'), new Set(['parseman']))!
      expect(second.warnings).toEqual([])
      expect(second.code).not.toBe(first.code)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not read or lower an explicit .ts import that escapes the nearest package root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-escape-'))
    const dir = path.join(parent, 'pkg')
    fs.mkdirSync(dir)
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(parent, 'outside.ts'), `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const outside = rules(g => ({ Atom: literal('x') }))
`)
      // `outside` is a valid recognition artifact: if the macro read it, this
      // composeLeaf call would fuse. The required throw proves containment
      // rejects it before any source lowering can happen.
      expect(() => transformMacro(`
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { outside } from '../outside.ts'
export const parser = composeLeaf([outside, rules(g => ({ Document: literal('x') }))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))).toThrow(
        'composeLeaf() must macro-fuse; runtime composition is forbidden',
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked source target that escapes the nearest package root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-symlink-'))
    const dir = path.join(parent, 'pkg')
    fs.mkdirSync(dir)
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      const outside = path.join(parent, 'outside.ts')
      fs.writeFileSync(outside, `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const outside = rules(g => ({ Atom: literal('x') }))
`)
      fs.symlinkSync(outside, path.join(dir, 'linked.ts'))
      expect(() => transformMacro(`
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { outside } from './linked.ts'
export const parser = composeLeaf([outside, rules(g => ({ Document: literal('x') }))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))).toThrow(
        'composeLeaf() must macro-fuse; runtime composition is forbidden',
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails closed on a source-private import cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-leaf-cycle-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'a.ts'), `
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
import { b } from './b.js'
export const a = compose([b, rules(g => ({ A: literal('a') }))])
`)
      fs.writeFileSync(path.join(dir, 'b.ts'), `
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
import { a } from './a.js'
export const b = compose([a, rules(g => ({ B: literal('b') }))])
`)
      expect(() => transformMacro(`
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { a } from './a.js'
export const parser = composeLeaf([a, rules(g => ({ Document: literal('x') }))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))).toThrow(
        'composeLeaf() must macro-fuse; runtime composition is forbidden',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
