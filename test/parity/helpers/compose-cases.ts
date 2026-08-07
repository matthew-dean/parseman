/**
 * The SHARED compose case battery: one source string per case, fused by every engine
 * the repo has — runtime `compose()`, the macro, and the interpreted fuse
 * (`test/parity/interpreted-fuse-parity.test.ts`). Shared rather than copied so a case
 * added for one engine cannot silently go unchecked by the others.
 */
// Trivia flavors with an OBSERVABLE difference: ws (whitespace) vs wsc (ws OR /*…*/).
export const TRIVIA = String.raw`
const ws  = trivia(oneOrMore(regex(/[ \t\n]+/)))
const wsc = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))`

export const IMPORTS = `import { rules, compose, parser, noTrivia, trivia, sequence, literal, oneOrMore, choice, regex } from 'parseman' with { type: 'macro' }`

export type Case = { name: string; src: string; entry: string; inputs: string[]; expect?: Record<string, string | number> }

export const cases: Case[] = [
  {
    name: 'single-level: ws, cross-boundary ref to inherited rule',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules({ trivia: ws }, (g) => ({ Doc: sequence(literal('x'), g.Pair, literal('y')) }))])`,
    entry: 'Doc',
    inputs: ['x a b y', 'xaby', 'x a b', 'x a/*c*/b y', 'q'],
    expect: { 'x a b y': 7, 'xaby': 4 },
  },
  {
    name: 'composing-wins: the delta’s wsc reaches the inherited base Pair',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules({ trivia: wsc }, (g) => ({ Doc: sequence(literal('x'), g.Pair) }))])`,
    entry: 'Doc',
    inputs: ['x a/*c*/b', 'x a b', 'x/*c*/a/*c*/b', 'xab'],
    expect: { 'x a/*c*/b': 9, 'x a b': 5 },
  },
  {
    name: 'delta declares no trivia → inherits the base grammar’s wsc',
    src: `${IMPORTS}${TRIVIA}
const base = rules({ trivia: wsc }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
export const g = compose([base, rules((g) => ({ Doc: sequence(literal('x'), g.Pair) }))])`,
    entry: 'Doc',
    inputs: ['x a/*c*/b', 'xab', 'x a b'],
    expect: { 'x a/*c*/b': 9, 'xab': 3 },
  },
  {
    name: 'noTrivia override: inner region glued, surroundings skip',
    src: `${IMPORTS}${TRIVIA}
export const g = compose([rules({ trivia: ws }, (r) => ({
  Doc: sequence(literal('x'), r.Inner, literal('y')),
  Inner: noTrivia(sequence(literal('p'), literal('q'))),
}))])`,
    entry: 'Doc',
    inputs: ['x pq y', 'x p q y', 'xpqy'],
    expect: { 'x pq y': 6, 'x p q y': 'FAIL' },
  },
  {
    name: 'parser({trivia: other}) override: inner region uses the OTHER trivia',
    src: `${IMPORTS}${TRIVIA}
export const g = compose([rules({ trivia: ws }, (r) => ({
  Doc: sequence(literal('x'), r.Inner),
  Inner: parser({ trivia: wsc }, sequence(literal('p'), literal('q'))),
}))])`,
    entry: 'Doc',
    inputs: ['x p/*c*/q', 'x/*c*/pq', 'x p q'],
    expect: { 'x p/*c*/q': 9, 'x/*c*/pq': 'FAIL' },
  },
  {
    name: 'multi-level (css→less→scss): deepest rule adopts outermost wsc',
    src: `${IMPORTS}${TRIVIA}
const css = rules({ trivia: ws }, (g) => ({ Pair: sequence(literal('a'), literal('b')) }))
const less = compose([css, rules({ trivia: ws }, (g) => ({ Mid: sequence(literal('m'), g.Pair) }))])
export const g = compose([less, rules({ trivia: wsc }, (g) => ({ Doc: sequence(literal('x'), g.Mid) }))])`,
    entry: 'Doc',
    inputs: ['x m a/*c*/b', 'x m a b', 'xmab'],
    expect: { 'x m a/*c*/b': 11, 'x m a b': 7 },
  },
]

