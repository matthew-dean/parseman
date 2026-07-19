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
