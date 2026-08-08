import { describe, expect, it } from 'vitest'
import {
  emitShapeMatch,
  parseScanShape,
  scanShapeFromRegex,
  type ScanShape,
} from '../../src/table/scan-shapes.ts'

function probe(shape: ScanShape): (input: string, pos: number) => number {
  let id = 0
  const match = emitShapeMatch(shape, 'pos', (prefix = '_v') => `${prefix}${id++}`, '  ', '_first')
  const body = [
    '  const _first = input.charCodeAt(pos)',
    ...match.setup,
    `  return (${match.ok}) ? (${match.end}) : -1`,
  ].join('\n')
  return new Function('input', 'pos', body) as (input: string, pos: number) => number
}

function expectRegexParity(source: string, flags: string, corpus: string): void {
  const shape = scanShapeFromRegex(source, flags)
  expect(shape, `/${source}/${flags} should have a scan shape`).not.toBeNull()
  const scan = probe(shape!)
  const sticky = new RegExp(source, flags.includes('y') ? flags : `${flags}y`)
  for (let pos = 0; pos <= corpus.length; pos++) {
    sticky.lastIndex = pos
    const match = sticky.exec(corpus)
    expect(scan(corpus, pos), `/${source}/${flags} at ${pos}`).toBe(match === null ? -1 : pos + match[0].length)
  }
}

describe('scan-shape edge matrix', () => {
  it('parses escaped class members, unicode literals, and rejects looping groups', () => {
    expect(parseScanShape('[a\\]]+')).toEqual({
      kind: 'chars',
      ranges: [[97, 97], [93, 93]],
      minOne: true,
    })
    expect(parseScanShape('\\u0061')).toEqual({
      kind: 'seq',
      parts: [{ part: 'lit', cps: [97], optional: false }],
    })
    expect(parseScanShape('\\')).toBeNull()
    expect(parseScanShape('(?:[a]*)+')).toBeNull()
    expect(parseScanShape('(?:[a]*)*')).toBeNull()
  })

  it('proves all signed class relationships used by trailing lookahead', () => {
    const accepted = [
      '[a]+(?![a-z])',
      '[a]+(?![^b])',
      '[^a]+(?![^a])',
      '[^a]+(?=[a])',
    ]
    for (const source of accepted) {
      expectRegexParity(source, '', 'aaabbb---')
    }
    expect(parseScanShape('[^a]+(?![b])')).toBeNull()
  })

  it('emits case-fold, switch, range, and ordered alternations with regex parity', () => {
    for (const [source, flags] of [
      ['Alpha|beta|!', 'i'],
      ['a|b|c', ''],
      ['[a-z]+|[0-9]+', ''],
      ['a|ab', ''],
      ['//[^\\n]*|/\\*(?:[^*]|\\*(?!/))*\\*/', ''],
    ] as const) {
      expectRegexParity(source, flags, 'Alpha BETA ! abc 123 ab //x\n/*y*/ /')
    }
  })

  it('emits every linear-run and nested-group cardinality with regex parity', () => {
    for (const source of [
      '[a]{2,}',
      '[a]{2,3}b',
      '[a]b',
      '[a]?b',
      '(?:ab)c',
      '(?:ab)?c',
      '(?:ab)+c',
      '(?:ab)*c',
    ]) {
      expectRegexParity(source, '', 'aaab abc ababc c b x')
    }
  })

  it('emits a manually supplied nullable chars shape as an empty-capable scan', () => {
    const scan = probe({ kind: 'chars', ranges: [[48, 57]], minOne: false })
    expect(scan('123x', 0)).toBe(3)
    expect(scan('123x', 3)).toBe(3)
  })
})
