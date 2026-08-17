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
import { directBuilderBindings, directBuilderUnsupportedBindings } from '../../src/plugin/direct-builder-static.ts'

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

describe('block-statement and function-reducer bodies the check now walks', () => {
  it('walks a block body instead of refusing it wholesale', () => {
    // A block body is carried as source text and inlined verbatim downstream, so a
    // statement inlines exactly as an expression does. `c` is the param; nothing free.
    expect(scan('(c) => { return c }')).toEqual([])
    expect(scan('(c) => { const n = c.length; return n }')).toEqual([])
    // A free name read inside the block is still reported.
    expect(scan('(c) => { return blockHelper(c) }')).toEqual(['blockHelper'])
  })

  it('walks a nested arrow with a block body', () => {
    expect(scan('(c) => c.map(x => { return x })')).toEqual([])
    expect(scan('(c) => c.map(x => { return nestedHelper(x) })')).toEqual(['nestedHelper'])
  })

  it('admits a resolved `function` reducer with an identifier param list', () => {
    // A bare reference to a top-level `function foldOperation(…) {…}` resolves to a
    // FunctionExpression here; it inlines just like the arrow the analyzer already ran.
    expect(scan('function build(c) { return c }')).toEqual([])
    // The function binds its own name inside its body (recursion) — self-contained.
    expect(scan('function fold(c) { return c.length > 1 ? fold(c.slice(1)) : c[0] }')).toEqual([])
    // Free reads inside a function body are still reported.
    expect(scan('function build(c) { return fnHelper(c) }')).toEqual(['fnHelper'])
  })

  it('walks throw / for / for-of statements, reporting only genuinely free reads', () => {
    // `throw new TypeError(...)` is admitted: intrinsic error constructors are static globals.
    expect(scan('(c) => { if (c.length === 0) throw new TypeError("empty"); return c }')).toEqual([])
    // A thrown custom (module-scope) error stays a free name.
    expect(scan('(c) => { throw new CustomError("x") }')).toEqual(['CustomError'])
    // A C-style for loop: its `index` binding does not leak, `push`-free body is analyzable.
    expect(scan('(c) => { const out = []; for (let i = 0; i < c.length; i += 1) out.push(c[i]); return out }')).toEqual([])
    // for-of binds the loop variable into the body only; the iterable is read outside.
    expect(scan('(c) => { const parts = []; for (const child of c) parts.push(child); return parts }')).toEqual([])
    // A free read inside the loop iterable is reported.
    expect(scan('(c) => { for (const x of outerList) c.push(x); return c }')).toEqual(['outerList'])
  })
})

describe('constructs the static builder check refuses', () => {
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

  it('refuses a callback that is neither an arrow nor a function', () => {
    expect(scan('someHelper')).toEqual(['unsupported callback shape'])
    expect(scan('42')).toEqual(['unsupported callback shape'])
  })

  it('reads a computed key expression as well as the value', () => {
    expect(scan('(c) => ({ [keyHelper]: c })')).toEqual(['keyHelper'])
  })
})

describe('the refuse-boundary a lifted analyzer must still hold (fail closed)', () => {
  it('refuses an async or generator reducer — not a pure synchronous builder', () => {
    expect(scan('async (c) => c')).toEqual(['unsupported callback shape'])
    expect(scan('async function build(c) { return c }')).toEqual(['unsupported callback shape'])
    expect(scan('function* build(c) { return c }')).toEqual(['unsupported callback shape'])
  })

  it('refuses `this` and `arguments` — function-only bindings no import can supply', () => {
    expect(scan('function build(c) { return this.value }')).toEqual(['unsupported ThisExpression'])
    expect(scan('function build(c) { return arguments[0] }')).toEqual(['unsupported arguments'])
  })

  it('still refuses an un-modelled statement kind rather than waving it through', () => {
    // `while` is not one of the walked statement kinds, so it fails closed.
    expect(scan('(c) => { while (c.length) c.pop(); return c }')).toEqual(['unsupported WhileStatement'])
    // A destructuring for-of target is not a single-identifier declaration.
    expect(scan('(c) => { for (const [a] of c) c.pop(); return c }')).toEqual(['unsupported ArrayPattern'])
  })
})

describe('the structural/free split `directBuilderBindings` exposes', () => {
  // `directBuilderUnsupportedBindings` is the FLATTENED `structural ++ free` view every
  // legacy caller reads. The evaluator, though, keys its two outcomes off the SPLIT:
  // a `free` name is rescuable (its import provenance can be carried and re-emitted),
  // while a `structural` refusal is not. Lock that contract directly so a future change
  // that reclassifies one as the other is caught here, not as a downstream mis-fusion.
  it('routes a plain lexical read to `free`, leaving `structural` empty', () => {
    expect(directBuilderBindings('(c) => importedFactory(c)')).toEqual({
      structural: [], free: ['importedFactory'],
    })
  })

  it('routes an un-modelled/function-only construct to `structural`, leaving `free` empty', () => {
    expect(directBuilderBindings('function build(c) { return arguments[0] }')).toEqual({
      structural: ['unsupported arguments'], free: [],
    })
    expect(directBuilderBindings('(c) => class {}')).toEqual({
      structural: ['unsupported ClassExpression'], free: [],
    })
  })

  it('keeps both when a builder mixes a refusal and a rescuable read', () => {
    const r = directBuilderBindings('(c) => (c.length ? helper(c) : function () {})')
    expect(r.free).toEqual(['helper'])
    expect(r.structural).toEqual(['unsupported FunctionExpression'])
    // The flattened view every existing caller reads is exactly `structural ++ free`.
    expect(scan('(c) => (c.length ? helper(c) : function () {})')).toEqual([...r.structural, ...r.free])
  })
})
