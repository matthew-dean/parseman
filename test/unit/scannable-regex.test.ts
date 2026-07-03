/**
 * Scannable regex lowering (PERF_IDEAS §8): terminal `regex()` shapes that
 * compile to `charCodeAt` scan loops instead of `RegExp.exec`.
 *
 * Rigorous cross-mode parity (interpreter vs compile() vs macro) plus codegen
 * detection that lowered patterns skip `_reN.exec` and non-scannable patterns
 * still use the regex fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  regex, literal, sequence, choice, transform, oneOrMore, many, sepBy,
  node, parser, trivia, parse, compile,
} from '../../src/index.ts'
import type { Combinator, CSTLeaf } from '../../src/index.ts'
import { parseScanShape } from '../../src/compiler/scannable-run.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// ---------------------------------------------------------------------------
// Shape recognition
// ---------------------------------------------------------------------------

describe('parseScanShape — quantifier', () => {
  it('records minOne for + and *', () => {
    expect(parseScanShape('[0-9]+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('[0-9]*')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: false })
  })

  it('recognizes until and delimited terminal shapes', () => {
    expect(parseScanShape('//[^\\n\\r]*')?.kind).toBe('until')
    expect(parseScanShape('/\\*(?:[^*]|\\*(?!/))*\\*/')?.kind).toBe('delimited')
  })

  it('recognizes shorthand-class runs (\\d, \\w)', () => {
    expect(parseScanShape('\\d+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('\\w*')).toEqual({
      kind: 'chars',
      ranges: [[48, 57], [65, 90], [97, 122], [95, 95]],
      minOne: false,
    })
  })

  it('expands \\d/\\w inside a char class (not treated as literal letters)', () => {
    // `[\d.]+` must match digits or dot — NOT the letter "d".
    expect(parseScanShape('[\\d.]+')).toEqual({
      kind: 'chars',
      ranges: [[48, 57], [46, 46]],
      minOne: true,
    })
  })

  it('recognizes identifier shape [head][tail]*', () => {
    expect(parseScanShape('[_A-Za-z]\\w*')).toEqual({
      kind: 'ident',
      head: [[95, 95], [65, 90], [97, 122]],
      tail: [[48, 57], [65, 90], [97, 122], [95, 95]],
    })
    expect(parseScanShape('[a-z][a-z0-9]*')?.kind).toBe('ident')
  })

  it('rejects non-scannable patterns', () => {
    // `\s` includes Unicode whitespace → cannot lower to a fixed ASCII range.
    expect(parseScanShape('\\s+')).toBeNull()
    expect(parseScanShape('[\\s]+')).toBeNull()
    // optional prefix not yet a shape.
    expect(parseScanShape('-?[0-9]+')).toBeNull()
    // negated head/tail can't become positive ranges.
    expect(parseScanShape('[^a][b]*')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Codegen detection
// ---------------------------------------------------------------------------

describe('scannable regex — codegen', () => {
  it('lowers [0-9]+ to charCodeAt without RegExp.exec', () => {
    const { source } = compile(regex(/[0-9]+/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toMatch(/const _re\d+/)
    expect(source).not.toContain('.exec(input)')
  })

  it('lowers until and delimited shapes', () => {
    const line = compile(regex(/\/\/[^\n\r]*/))
    expect(line.source).toContain('charCodeAt')
    expect(line.source).not.toContain('.exec(input)')

    const block = compile(regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))
    expect(block.source).toContain('charCodeAt')
    expect(block.source).not.toContain('.exec(input)')
  })

  it('keeps RegExp.exec for non-scannable patterns', () => {
    const { source } = compile(regex(/\s+/))
    expect(source).toMatch(/const _re\d+ = /)
    expect(source).toContain('.exec(input)')
  })

  it('lowers \\d+ and \\w+ shorthand runs', () => {
    expect(compile(regex(/\d+/)).source).not.toContain('.exec(input)')
    expect(compile(regex(/\w+/)).source).not.toContain('.exec(input)')
  })

  it('lowers identifier shape [_A-Za-z]\\w*', () => {
    const { source } = compile(regex(/[_A-Za-z]\w*/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toContain('.exec(input)')
  })

  it('does NOT lower case-insensitive/unicode/multiline patterns', () => {
    // `i` folds case → a fixed ASCII range would be wrong; must stay on exec.
    expect(compile(regex(/[a-z]+/i)).source).toContain('.exec(input)')
    expect(compile(regex(/[a-z]+/u)).source).toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// Cross-mode parity helpers
// ---------------------------------------------------------------------------

type ParseFn = (
  input: string,
  pos: number,
  ctx: Record<string, unknown>,
) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function makeMacroParser(code: string, exportName: string): ParseFn {
  const result = transformMacro(code, 'scannable-regex-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + `\nreturn ${exportName}`
  return new Function(fnBody)() as ParseFn
}

function modesFor<T>(combinator: Parameters<typeof compile<T>>[0], macroCode: string, exportName: string) {
  const compiled = compile(combinator)
  let macroFn: ParseFn
  beforeAll(() => {
    macroFn = makeMacroParser(macroCode, exportName)
  })
  return [
    ['interpreter', (input: string, pos = 0) => {
      const r = combinator.parse(input, pos, { trackLines: false })
      return { ok: r.ok, value: r.ok ? r.value : undefined, span: r.span }
    }],
    ['compile()', (input: string, pos = 0) => {
      const r = compiled.parse(input, pos)
      return { ok: r.ok, value: r.ok ? r.value : undefined, span: r.span }
    }],
    ['macro', (input: string, pos = 0) => macroFn(input, pos, {})],
  ] as const
}

function expectParity(
  modes: ReturnType<typeof modesFor>,
  input: string,
  pos = 0,
) {
  const results = modes.map(([, run]) => run(input, pos))
  const vals = results.map(r => (r.ok ? r.value : `fail@${r.span.end}`))
  expect(new Set(vals).size).toBe(1)
  return results[0]!
}

// ---------------------------------------------------------------------------
// Parity — char-class runs
// ---------------------------------------------------------------------------

const digits = regex(/[0-9]+/)
const digitsStar = regex(/[0-9]*/)
const letters = regex(/[a-z]+/)

describe('scannable regex — [0-9]+ parity', () => {
  const modes = modesFor(
    digits,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const digits = regex(/[0-9]+/)`,
    'digits',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches a digit run`, () => {
      const r = run('123abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('123')
      expect(r.span).toEqual({ start: 0, end: 3 })
    })

    it(`${mode}: fails on empty / non-digit`, () => {
      expect(run('abc').ok).toBe(false)
      expect(run('', 0).ok).toBe(false)
    })

    it(`${mode}: matches at offset`, () => {
      const r = run('xx42yy', 2)
      expect(r.ok).toBe(true)
      expect(r.value).toBe('42')
      expect(r.span).toEqual({ start: 2, end: 4 })
    })
  }

  it('all modes agree on mixed cases', () => {
    for (const [input, pos] of [['007', 0], ['a1', 1], ['9', 0], ['', 0]] as const) {
      expectParity(modes, input, pos)
    }
  })
})

describe('scannable regex — [0-9]* parity', () => {
  const modes = modesFor(
    digitsStar,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const digitsStar = regex(/[0-9]*/)`,
    'digitsStar',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: allows zero-width match`, () => {
      const r = run('abc')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('')
      expect(r.span).toEqual({ start: 0, end: 0 })
    })

    it(`${mode}: still consumes digits when present`, () => {
      const r = run('99x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('99')
    })
  }

  it('all modes agree', () => {
    expectParity(modes, '001end')
    expectParity(modes, 'no-digits')
  })
})

describe('scannable regex — choice of letter vs digit runs', () => {
  const arm = choice(letters, digits)
  const modes = modesFor(
    arm,
    `import { regex, choice } from 'parseman' with { type: 'macro' }
const letters = regex(/[a-z]+/)
const digits = regex(/[0-9]+/)
export const arm = choice(letters, digits)`,
    'arm',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: picks the matching arm`, () => {
      expect(run('abc123').value).toBe('abc')
      expect(run('123abc').value).toBe('123')
    })
  }
})

// ---------------------------------------------------------------------------
// Parity — shorthand runs and identifier shape
// ---------------------------------------------------------------------------

const dRun = regex(/\d+/)
const wRun = regex(/\w+/)
const ident = regex(/[_A-Za-z]\w*/)

describe('scannable regex — \\d+ / \\w+ parity', () => {
  const dModes = modesFor(
    dRun,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const dRun = regex(/\\d+/)`,
    'dRun',
  )
  for (const [mode, run] of dModes) {
    it(`${mode}: \\d+ matches a digit run`, () => {
      const r = run('2026!')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('2026')
    })
    it(`${mode}: \\d+ fails on a letter`, () => {
      expect(run('x').ok).toBe(false)
    })
  }

  const wModes = modesFor(
    wRun,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const wRun = regex(/\\w+/)`,
    'wRun',
  )
  for (const [mode, run] of wModes) {
    it(`${mode}: \\w+ matches word chars incl. underscore/digits`, () => {
      const r = run('a_1B-')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('a_1B')
    })
  }
})

describe('scannable regex — identifier shape parity', () => {
  const modes = modesFor(
    ident,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const ident = regex(/[_A-Za-z]\\w*/)`,
    'ident',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: head then tail run`, () => {
      const r = run('_foo123 ')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('_foo123')
    })
    it(`${mode}: single head char is a valid identifier`, () => {
      const r = run('x=')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('x')
    })
    it(`${mode}: fails when first char is a digit`, () => {
      expect(run('1abc').ok).toBe(false)
    })
  }

  it('all modes agree across mixed inputs', () => {
    for (const s of ['a', 'A9', '__', 'z0z0', '9no']) expectParity(modes, s)
  })
})

// ---------------------------------------------------------------------------
// Parity — until / delimited
// ---------------------------------------------------------------------------

const lineComment = regex(/\/\/[^\n\r]*/)
const blockComment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)

describe('scannable regex — line comment (until)', () => {
  const modes = modesFor(
    lineComment,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const lineComment = regex(/\\/\\/[^\\n\\r]*/)`,
    'lineComment',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: consumes through EOL`, () => {
      const r = run('// hello\nrest')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('// hello')
      expect(r.span.end).toBe(8)
    })

    it(`${mode}: fails without // opener`, () => {
      expect(run('hello').ok).toBe(false)
    })
  }
})

describe('scannable regex — block comment (delimited)', () => {
  const modes = modesFor(
    blockComment,
    `import { regex } from 'parseman' with { type: 'macro' }
export const blockComment = regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)`,
    'blockComment',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches a closed block`, () => {
      const r = run('/* a * b */ tail')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('/* a * b */')
    })

    it(`${mode}: fails on unclosed block`, () => {
      expect(run('/* open').ok).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// Parity — transform + sequence (realistic terminal use)
// ---------------------------------------------------------------------------

const num = transform(regex(/[0-9]+/), s => Number(s))
// `[^"]*` has no literal opener, so it is NOT lowered (until requires <lit>[^X]*).
// This proves a scannable delimiter can wrap a non-scannable body in one sequence.
const quoted = sequence(literal('"'), regex(/[^"]*/), literal('"'))
// `//[^\n\r]*` IS a genuine until shape — exercised inside a sequence here.
const tagged = sequence(literal('#'), regex(/[a-z]+/))

describe('scannable regex — inside transform and sequence', () => {
  const numModes = modesFor(
    num,
    `import { regex, transform } from 'parseman' with { type: 'macro' }
export const num = transform(regex(/[0-9]+/), s => Number(s))`,
    'num',
  )
  for (const [mode, run] of numModes) {
    it(`${mode}: transform receives scanned digits`, () => {
      const r = run('42x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe(42)
    })
  }

  const strModes = modesFor(
    quoted,
    `import { regex, sequence, literal } from 'parseman' with { type: 'macro' }
export const quoted = sequence(literal('"'), regex(/[^"]*/), literal('"'))`,
    'quoted',
  )
  for (const [mode, run] of strModes) {
    it(`${mode}: scannable delimiters around a non-scannable body`, () => {
      const r = run('"hi"!')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['"', 'hi', '"'])
    })
  }

  const tagModes = modesFor(
    tagged,
    `import { regex, sequence, literal } from 'parseman' with { type: 'macro' }
export const tagged = sequence(literal('#'), regex(/[a-z]+/))`,
    'tagged',
  )
  for (const [mode, run] of tagModes) {
    it(`${mode}: scannable chars run after a literal`, () => {
      const r = run('#foo ')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['#', 'foo'])
    })
  }
})

// `[^"]*` must stay on the RegExp.exec fallback (no literal opener).
it('scannable regex — bare negated class is not lowered', () => {
  expect(parseScanShape('[^"]*')).toBeNull()
  expect(compile(regex(/[^"]*/)).source).toContain('.exec(input)')
})

// ---------------------------------------------------------------------------
// Parity — repetition of scannable terminals
// ---------------------------------------------------------------------------

const digitGroups = sepBy(regex(/[0-9]+/), literal(','))
const wordRun = many(sequence(regex(/[a-z]+/), regex(/[0-9]*/)))

describe('scannable regex — repeated in sepBy', () => {
  const modes = modesFor(
    digitGroups,
    `import { regex, sepBy, literal } from 'parseman' with { type: 'macro' }
export const digitGroups = sepBy(regex(/[0-9]+/), literal(','))`,
    'digitGroups',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: collects comma-separated digit runs`, () => {
      const r = run('1,22,333')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(['1', '22', '333'])
    })
  }
})

describe('scannable regex — repeated in many + optional-star body', () => {
  const modes = modesFor(
    wordRun,
    `import { regex, many, sequence } from 'parseman' with { type: 'macro' }
export const wordRun = many(sequence(regex(/[a-z]+/), regex(/[0-9]*/)))`,
    'wordRun',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: matches word/digit pairs incl. zero-width star`, () => {
      const r = run('ab12cd')
      expect(r.ok).toBe(true)
      expect(r.value).toEqual([['ab', '12'], ['cd', '']])
    })
  }
})

// ---------------------------------------------------------------------------
// Non-scannable fallback parity (still uses exec — behavior unchanged)
// ---------------------------------------------------------------------------

const ws = regex(/\s+/)

describe('scannable regex — \\s+ fallback parity', () => {
  const modes = modesFor(
    ws,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const ws = regex(/\\s+/)`,
    'ws',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: whitespace via RegExp.exec`, () => {
      const r = run('  \tx')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('  \t')
    })
  }

  it('compiled output still uses exec', () => {
    expect(compile(ws).source).toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// CST capture — the terminal analog of the trivia capture path. A scannable
// regex inside a capturing node() must push a CSTLeaf whose value/span match
// the interpreter, and codegen must lower it (charCodeAt + _cstLeaves.push,
// never RegExp.exec).
// ---------------------------------------------------------------------------

type CstNode = { _tag: 'node'; type: string; span: { start: number; end: number }; leaves: unknown[] }
const mkNode = (type: string) =>
  (c: readonly unknown[], _r: unknown, s: { start: number; end: number }): CstNode =>
    ({ _tag: 'node', type, span: s, leaves: [...c] })

function cstParity<T>(label: string, combinator: Combinator<T>, inputs: string[]) {
  const compiled = compile(combinator)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const interp = parse(combinator, input, { trackLines: false })
      const comp = compiled.parse(input, 0)
      expect(comp.ok).toBe(interp.ok)
      if (interp.ok && comp.ok) {
        // Deep-equal covers the captured CSTLeaf value AND span, per mode.
        expect(comp.value).toEqual(interp.value)
      }
    })
  }
}

const capWs = trivia(regex(/[ \t]+/))
const NumNode = node('Num', regex(/[0-9]+/), mkNode('Num'))
const LineNode = node('Line', regex(/\/\/[^\n\r]*/), mkNode('Line'))
const BlockNode = node('Block', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//), mkNode('Block'))
const NumListNode = node(
  'Nums',
  parser({ trivia: capWs }, sepBy(regex(/[0-9]+/), literal(','))),
  mkNode('Nums'),
)

describe('scannable regex — CST leaf capture parity (interpreter vs compile())', () => {
  cstParity('chars run captured', NumNode, ['0', '42', '007'])
  cstParity('until captured', LineNode, ['// hi', '//', '// trailing\n'])
  cstParity('delimited captured', BlockNode, ['/**/', '/* a * b */'])
  cstParity('scannable terminals in a captured sepBy', NumListNode, ['1', '1, 22, 333'])

  it('captured leaf carries the scanned value and span', () => {
    const r = parse(NumNode, '4200')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaf = (r.value as CstNode).leaves.find(
      (c): c is CSTLeaf => (c as CSTLeaf)._tag === 'leaf',
    )
    expect(leaf?.value).toBe('4200')
    expect(leaf?.span).toEqual({ start: 0, end: 4 })
  })
})

describe('scannable regex — CST capture codegen', () => {
  it('captured chars run: charCodeAt + _cstLeaves.push, no exec', () => {
    const src = compile(NumNode).source
    expect(src).toContain('charCodeAt')
    expect(src).toContain('_cstLeaves.push')
    expect(src).not.toContain('.exec(input)')
  })

  it('captured delimited: charCodeAt + _cstLeaves.push, no exec', () => {
    const src = compile(BlockNode).source
    expect(src).toContain('charCodeAt')
    expect(src).toContain('_cstLeaves.push')
    expect(src).not.toContain('.exec(input)')
  })
})

// ---------------------------------------------------------------------------
// String-literal shape:  <q>(?:[^q\\]|\\.)*<q>  — quote-delimited with escapes.
// The scan must honor escaped quotes/backslashes and the line-terminator rules
// that distinguish `\\.` (no line terminators) from `\\[\s\S]` (any char).
// ---------------------------------------------------------------------------

describe('parseScanShape — string shape', () => {
  it('recognizes double/single quoted strings with escapes', () => {
    expect(parseScanShape(/"(?:[^"\\]|\\.)*"/.source)).toEqual({
      kind: 'string', quote: 34, excluded: [[34, 34], [92, 92]], escLineTerm: false,
    })
    expect(parseScanShape(/'(?:[^'\\]|\\[\s\S])*'/.source)).toEqual({
      kind: 'string', quote: 39, excluded: [[39, 39], [92, 92]], escLineTerm: true,
    })
  })

  it('records a newline-excluding body (cp-style string)', () => {
    expect(parseScanShape(/"(?:[^"\n\\]|\\.)*"/.source)).toEqual({
      kind: 'string', quote: 34, excluded: [[34, 34], [10, 10], [92, 92]], escLineTerm: false,
    })
  })

  it('accepts escape-first arm order', () => {
    expect(parseScanShape(/'(?:\\.|[^'\\])*'/.source)?.kind).toBe('string')
  })

  it('rejects non-string quote patterns', () => {
    // body class missing the backslash → not an escape-aware string.
    expect(parseScanShape(/"[^"]*"/.source)).toBeNull()
    // no closing quote match.
    expect(parseScanShape(/"(?:[^"\\]|\\.)*'/.source)).toBeNull()
  })
})

describe('scannable regex — string codegen', () => {
  it('lowers a quoted string to charCodeAt without RegExp.exec', () => {
    const { source } = compile(regex(/"(?:[^"\\]|\\.)*"/))
    expect(source).toContain('charCodeAt')
    expect(source).not.toContain('.exec(input)')
  })
})

const dqStr = regex(/"(?:[^"\\]|\\.)*"/)
const sqStr = regex(/'(?:[^'\\]|\\[\s\S])*'/)
const cpDqStr = regex(/"(?:[^"\n\\]|\\.)*"/)

describe('scannable regex — double-quoted string parity', () => {
  const modes = modesFor(
    dqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const dqStr = regex(/"(?:[^"\\\\]|\\\\.)*"/)`,
    'dqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: plain string`, () => {
      const r = run('"hi" rest')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"hi"')
      expect(r.span).toEqual({ start: 0, end: 4 })
    })
    it(`${mode}: escaped quote does not close early`, () => {
      const r = run('"a\\"b" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\\"b"')
    })
    it(`${mode}: escaped backslash then close`, () => {
      const r = run('"a\\\\" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\\\\"')
    })
    it(`${mode}: unterminated fails`, () => {
      expect(run('"abc').ok).toBe(false)
    })
    it(`${mode}: trailing backslash (no escaped char) fails`, () => {
      expect(run('"ab\\').ok).toBe(false)
    })
    it(`${mode}: backslash before newline fails (\\. excludes line terminators)`, () => {
      expect(run('"a\\\nb"').ok).toBe(false)
    })
    it(`${mode}: raw newline in body is allowed ([^"\\] matches it)`, () => {
      const r = run('"a\nb" x')
      expect(r.ok).toBe(true)
      expect(r.value).toBe('"a\nb"')
    })
  }
})

describe('scannable regex — single-quoted string with \\[\\s\\S] escapes', () => {
  const modes = modesFor(
    sqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const sqStr = regex(/'(?:[^'\\\\]|\\\\[\\s\\S])*'/)`,
    'sqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: backslash before newline is allowed ([\\s\\S])`, () => {
      const r = run("'a\\\nb' x")
      expect(r.ok).toBe(true)
      expect(r.value).toBe("'a\\\nb'")
    })
    it(`${mode}: unterminated fails`, () => {
      expect(run("'oops").ok).toBe(false)
    })
  }
})

describe('scannable regex — newline-excluding string body', () => {
  const modes = modesFor(
    cpDqStr,
    `import { regex } from 'parseman' with { type: 'macro' }\nexport const cpDqStr = regex(/"(?:[^"\\n\\\\]|\\\\.)*"/)`,
    'cpDqStr',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: raw newline in body fails (body excludes \\n)`, () => {
      expect(run('"a\nb"').ok).toBe(false)
    })
    it(`${mode}: single-line string still matches`, () => {
      expect(run('"ok"').value).toBe('"ok"')
    })
  }
})

// Battery cross-check: compiled scan must agree with the native anchored RegExp
// on every input, including the tricky escape/line-terminator corners.
describe('scannable regex — string matches native RegExp', () => {
  const cases: Array<{ re: RegExp; inputs: string[] }> = [
    {
      re: /"(?:[^"\\]|\\.)*"/y,
      inputs: [
        '"hi"', '"a\\"b"', '"a\\\\"', '"abc', '"ab\\', '"a\\\nb"', '"a\nb"',
        '""', '"\\t\\n"', 'no-quote', '"end"trailing',
      ],
    },
    {
      re: /'(?:[^'\\]|\\[\s\S])*'/y,
      inputs: ["''", "'a\\\nb'", "'x\\'y'", "'unterminated", "'\\\\'"],
    },
    {
      re: /"(?:[^"\n\\]|\\.)*"/y,
      inputs: ['"ok"', '"a\nb"', '"a\\nb"'],
    },
  ]
  for (const { re, inputs } of cases) {
    const compiled = compile(regex(new RegExp(re.source)))
    for (const input of inputs) {
      it(`${re.source} vs native — ${JSON.stringify(input)}`, () => {
        re.lastIndex = 0
        const native = re.exec(input)
        const nativeOk = native !== null && native.index === 0
        const r = compiled.parse(input, 0)
        expect(r.ok).toBe(nativeOk)
        if (nativeOk && r.ok) expect(r.value).toBe(native![0])
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Trivia parity — the whole point of sharing one match core: a completion-
// sensitive shape (delimited comment, escape-aware string) used as a TRIVIA arm
// must behave identically to the interpreter's oneOrMore(choice(…)) — most
// importantly, an UNTERMINATED token must stop the trivia loop (leaving it
// unconsumed) rather than being swallowed to EOF. All three modes must agree.
// ---------------------------------------------------------------------------

function triviaModes(triviaCombinator: Combinator<unknown>, macroTriviaExpr: string) {
  const g = parser({ trivia: triviaCombinator }, sequence(literal('a'), literal('b')))
  const macroCode =
    `import { regex, oneOrMore, choice, trivia, parser, sequence, literal } from 'parseman' with { type: 'macro' }\n` +
    `export const g = parser({ trivia: ${macroTriviaExpr} }, sequence(literal('a'), literal('b')))`
  return modesFor(g, macroCode, 'g')
}

/** Accept/reject parity across modes; on shared success also end + value. */
function expectTriviaParity(modes: ReturnType<typeof modesFor>, input: string) {
  const results = modes.map(([, run]) => run(input))
  const oks = results.map(r => r.ok)
  expect(new Set(oks).size, `ok parity for ${JSON.stringify(input)}`).toBe(1)
  if (results[0]!.ok) {
    expect(new Set(results.map(r => r.span.end)).size).toBe(1)
    expect(new Set(results.map(r => JSON.stringify(r.value))).size).toBe(1)
  }
}

describe('trivia parity — delimited (block comment) arm', () => {
  const modes = triviaModes(
    oneOrMore(choice(regex(/[ \t\n\r\f]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))),
    `oneOrMore(choice(regex(/[ \\t\\n\\r\\f]+/), regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)))`,
  )
  for (const [mode, run] of modes) {
    it(`${mode}: closed comment is trivia`, () => {
      expect(run('a /* c */ b').ok).toBe(true)
    })
    it(`${mode}: unterminated comment stops the loop (reject, not swallow)`, () => {
      expect(run('a /* unterminated b').ok).toBe(false)
    })
  }
  it('all modes agree', () => {
    for (const s of ['ab', 'a b', 'a/*x*/b', 'a /* u\nb', 'a /* ok */ b']) {
      expectTriviaParity(modes, s)
    }
  })
})

describe('trivia parity — escape-aware string arm', () => {
  const modes = triviaModes(
    oneOrMore(choice(regex(/[ \t]+/), regex(/'(?:[^'\\]|\\.)*'/))),
    `oneOrMore(choice(regex(/[ \\t]+/), regex(/'(?:[^'\\\\]|\\\\.)*'/)))`,
  )
  for (const [mode, run] of modes) {
    it(`${mode}: closed string is trivia`, () => {
      expect(run("a 'x' b").ok).toBe(true)
    })
    it(`${mode}: escaped quote keeps the string open`, () => {
      expect(run("a 'x\\'y' b").ok).toBe(true)
    })
    it(`${mode}: unterminated string stops the loop (reject, not swallow)`, () => {
      expect(run("a 'unterminated b").ok).toBe(false)
    })
  }
  it('all modes agree', () => {
    for (const s of ['ab', "a 'x' b", "a'y'b", "a 'no-close b", "a '\\'' b"]) {
      expectTriviaParity(modes, s)
    }
  })
})
