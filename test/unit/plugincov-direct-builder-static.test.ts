/**
 * Branch coverage for `src/plugin/direct-builder-static.ts`.
 *
 * This is the gate that decides whether a `node(..., build)` callback can cross a
 * compiled-artifact boundary. Every name it fails to report becomes a
 * `ReferenceError` at import time in the consuming module, and every construct it
 * waves through un-analysed is a hole in that guarantee — so the expression forms
 * it walks and the ones it refuses are asserted individually, by the exact strings
 * it returns.
 */
import { describe, it, expect } from 'vitest'
import { directBuilderUnsupportedBindings } from '../../src/plugin/direct-builder-static.ts'

const scan = directBuilderUnsupportedBindings

describe('expression forms the static builder check walks', () => {
  it('walks both arms of a conditional expression', () => {
    expect(scan('(c) => (c.length ? c : null)')).toEqual([])
    expect(scan('(c) => (c.length ? leftHelper : rightHelper)')).toEqual(['leftHelper', 'rightHelper'])
    expect(scan('(c) => (testHelper ? 1 : 2)')).toEqual(['testHelper'])
  })

  it('walks template literal substitutions', () => {
    expect(scan('(c) => `v:${c[0]}`')).toEqual([])
    expect(scan('(c) => `v:${outsideHelper}`')).toEqual(['outsideHelper'])
  })

  it('walks sequence, unary, update, binary, spread and new expressions', () => {
    expect(scan('(c) => ({ n: -c.length, ok: !c, all: [...c], made: new Date(0) })')).toEqual([])
    expect(scan('(c) => [...spreadHelper]')).toEqual(['spreadHelper'])
  })

  it('skips array holes rather than treating them as bindings', () => {
    expect(scan('(c) => [, c]')).toEqual([])
  })

  it('allows the documented static globals but nothing else', () => {
    expect(scan('(c) => Object.assign({}, JSON.parse("{}"), { n: Number(c) })')).toEqual([])
    expect(scan('(c) => globalThis.foo')).toEqual(['globalThis'])
  })
})

describe('constructs the static builder check refuses', () => {
  it('refuses a callback with a block body', () => {
    expect(scan('(c) => { return c }')).toEqual(['unsupported BlockStatement'])
  })

  it('refuses a nested arrow with a block body', () => {
    expect(scan('(c) => c.map(x => { return x })')).toEqual(['unsupported BlockStatement'])
  })

  it('refuses a destructured parameter on the callback itself', () => {
    expect(scan('({ children }) => children')).toEqual(['unsupported parameter pattern'])
    expect(scan('([a]) => a')).toEqual(['unsupported parameter pattern'])
  })

  it('refuses a destructured parameter on a nested arrow', () => {
    // The destructured name is never admitted to the nested allow-set, so the body's
    // read of it is reported too — both facts must survive.
    expect(scan('(c) => c.map(({ a }) => a)')).toEqual(['unsupported ObjectPattern', 'a'])
  })

  it('refuses object methods and accessors, which carry a block body', () => {
    expect(scan('(c) => ({ m() { return c } })')).toEqual(['unsupported Property'])
    expect(scan('(c) => ({ get a() { return c } })')).toEqual(['unsupported Property'])
  })

  it('refuses an expression form it does not model, naming the node type', () => {
    expect(scan('(c) => function () { return c }')).toEqual(['unsupported FunctionExpression'])
    expect(scan('(c) => class {}')).toEqual(['unsupported ClassExpression'])
  })

  it('refuses a callback that is not an arrow function at all', () => {
    expect(scan('function build(c) { return c }')).toEqual(['unsupported callback shape'])
    expect(scan('someHelper')).toEqual(['unsupported callback shape'])
  })

  it('reads a computed key expression as well as the value', () => {
    expect(scan('(c) => ({ [keyHelper]: c })')).toEqual(['keyHelper'])
  })
})
