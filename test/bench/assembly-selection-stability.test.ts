/**
 * A COMMENT CHANGES NOTHING A MODULE SHIPS.
 *
 * Checked on jess's CSS grammar (`fixtures/jess-grammars`): the failure this pins
 * showed on its SCSS sibling, where a slightly longer doc comment cost five functions
 * and about 1% of parse speed. CSS alone catches each way of breaking it, and lowers
 * in about a second where a dialect composed over it takes eight. That a larger budget
 * never loses a site is `fitHotSites`'s unit test; `bench/jess/selection-sweep.ts`
 * sweeps it over the real grammars by hand.
 */
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseSync } from 'oxc-parser'
import { describe, expect, it } from 'vitest'
import { CARRIED_SIDECAR_SUFFIX, transformMacro, type CarriedSink } from '../../src/plugin/index.ts'

const ALIASES = new Set(['parseman'])
const FIXTURE = resolve(import.meta.dirname, '../../fixtures/jess-grammars')

/** Rebuilt with every comment passed through `edit`; an empty result takes the whitespace before it too, keeping a line end. */
function editComments(id: string, code: string, edit: (comment: string) => string): string {
  let out = ''
  let at = 0
  for (const c of parseSync(id, code).comments) {
    const before = code.slice(at, c.start)
    const text = edit(code.slice(c.start, c.end))
    const kept = before.trimEnd()
    const keepsLine = before.slice(kept.length).includes('\n') && code[c.end] !== '\n'
    out += text === '' ? kept + (keepsLine ? '\n' : '') : before + text
    at = c.end
  }
  return out + code.slice(at)
}

/** What a bundler leaves of a lowered module: its code, with comments gone. */
const shipped = (id: string, code: string): string => editComments(id, code, () => '').replace(/\s+/g, ' ')

describe('selective assembly on a real grammar', () => {
  it('a comment changes nothing shipped', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'parseman-selection-')))
    try {
      cpSync(FIXTURE, root, { recursive: true })
      // The shared pieces CSS imports, lowered as a build lowers them.
      for (const m of ['recognition', 'pseudo-consts', 'unknown-at-rule']) {
        const file = join(root, 'parser-shared', `${m}.ts`)
        const sink: CarriedSink = new Map()
        const out = transformMacro(readFileSync(file, 'utf8'), file, ALIASES, false, false, false, undefined, undefined, sink)!
        const js = file.replace(/\.ts$/, '.js')
        writeFileSync(js, out.code)
        if (sink.size > 0) writeFileSync(js + CARRIED_SIDECAR_SUFFIX, JSON.stringify({ exports: Object.fromEntries(sink) }))
      }
      const id = join(root, 'css', 'grammar.ts')
      const code = readFileSync(id, 'utf8')
      const lower = (source: string, share: number) => transformMacro(source, id, ALIASES, false, false, false, undefined, share)!

      const base = shipped(id, lower(code, 2).code)
      const removed = editComments(id, code, () => '')
      const longer = editComments(id, code, c => c.startsWith('//') ? `${c} and some more` : `/* and some more ${c.slice(2)}`)
      expect(shipped(id, lower(removed, 2).code) === base, 'comments removed').toBe(true)
      expect(shipped(id, lower(longer, 2).code) === base, 'comments longer').toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
