/**
 * `scripts/verify-doc-examples.mjs` exists so that a `// →` output pasted into the
 * guide is a CHECKED claim rather than a hopeful one. That guarantee is only as
 * good as the comparison, and the comparison used to run on JSON-round-tripped
 * values: `undefined` and symbols arrived as `null`, `undefined` object fields
 * disappeared, and a `bigint` threw and took the whole block down. So a doc could
 * claim `null` for a value that is really `undefined` and the verifier would agree.
 *
 * These run the real script against fixture markdown, which is also the only way to
 * cover a build script that is not importable (it executes at module scope).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'scripts/verify-doc-examples.mjs')

/** Run the verifier over one fixture doc; returns its report text. */
function verify(markdown: string): { out: string; ok: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'pm-docverify-'))
  const file = join(dir, 'fixture.md')
  writeFileSync(file, markdown)
  try {
    const out = execFileSync(process.execPath, [SCRIPT, file], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    })
    return { out, ok: true }
  } catch (e) {
    const err = e as { stdout?: string; message?: string }
    return { out: err.stdout ?? err.message ?? '', ok: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const block = (body: string): string => `# Fixture\n\n\`\`\`ts\n// [verify]\n${body}\n\`\`\`\n`

describe('doc-example verifier — values that JSON destroys', () => {
  it('renders undefined as undefined, and REJECTS the null a JSON round-trip produced', () => {
    // The regression, stated: `JSON.stringify([undefined])` is `[null]`, so this
    // doc claim used to be accepted for a value that is not null.
    const bad = verify(block('const xs = [undefined]\nxs\n// → [null]'))
    expect(bad.ok).toBe(false)
    expect(bad.out).toContain('FAIL')
    expect(bad.out).toMatch(/got "\[undefined\]"/)

    const good = verify(block('const xs = [undefined]\nxs\n// → [undefined]'))
    expect(good.ok).toBe(true)
    expect(good.out).toContain('1 pass, 0 fixed, 0 fail, 0 error')
  })

  it('keeps an undefined OBJECT FIELD, which JSON drops entirely', () => {
    const good = verify(block('const o = { a: 1, b: undefined }\no\n// → { a: 1, b: undefined }'))
    expect(good.out).toContain('1 pass, 0 fixed, 0 fail, 0 error')
    expect(good.ok).toBe(true)
  })

  it('renders a bigint distinguishably instead of aborting the block', () => {
    // `JSON.stringify(1n)` THROWS: the block was reported as an ERROR with a
    // "Do not know how to serialize a BigInt" message and nothing was checked.
    const good = verify(block('const n = 1n\nn\n// → 1n'))
    expect(good.out).toContain('1 pass, 0 fixed, 0 fail, 0 error')
    expect(good.ok).toBe(true)
    // …and `1n` must not compare equal to the NUMBER 1.
    const bad = verify(block('const n = 1n\nn\n// → 1'))
    expect(bad.ok).toBe(false)
    expect(bad.out).toContain('FAIL')
  })

  it('renders a symbol instead of collapsing it to null', () => {
    const good = verify(block("const s = [Symbol('tag')]\ns\n// → [Symbol(tag)]"))
    expect(good.out).toContain('1 pass, 0 fixed, 0 fail, 0 error')
    expect(good.ok).toBe(true)
  })

  it('still verifies a real parseman example end to end', () => {
    const good = verify(block(
      "import { choice, literal, parse } from 'parseman'\n"
      + "parse(choice(literal('in'), literal('instanceof')), 'instanceof x').value\n"
      + "// → 'instanceof'",
    ))
    expect(good.out).toContain('1 pass, 0 fixed, 0 fail, 0 error')
    expect(good.ok).toBe(true)
  })

  it('reports a mismatch with the file and LINE of the offending block', () => {
    const bad = verify(block("'a'\n// → 'b'"))
    expect(bad.ok).toBe(false)
    expect(bad.out).toMatch(/fixture\.md:3/)
  })
})

/*
 * The verifier is a REQUIRED, never-skipped CI job (`.github/workflows/ci.yml`, job
 * `docs-verify`, enforced in the `test` aggregate). Its green is a claim that every
 * documented output was executed and matched.
 *
 * Everything it does hinges on two literals: the ```ts fence `BLOCK_RE` matches and
 * the `// [verify]` marker. Rename either, or move `docs/`, and every loop iterates
 * zero times — it printed "0 pass, 0 fixed, 0 fail, 0 error" and exited 0, making
 * that claim on behalf of a run that checked nothing.
 */
describe('doc-example verifier — the discovery floor', () => {
  /** Run in FULL-GUIDE mode over a fixture tree, which is where the floor applies. */
  function sweep(docs: Record<string, string>): { out: string; ok: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'pm-docfloor-'))
    for (const [name, body] of Object.entries(docs)) writeFileSync(join(dir, name), body)
    try {
      const out = execFileSync(process.execPath, [SCRIPT, `--docs=${dir}`], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      })
      return { out, ok: true }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string }
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? ''), ok: false }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('FAILS when a sweep finds no verified blocks at all', () => {
    // The shape of every structural break: docs exist, nothing carries the marker.
    const r = sweep({ 'a.md': '# Guide\n\nProse only.\n' })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/DISCOVERY FLOOR/)
    expect(r.out).toMatch(/found 0 verified block/)
  })

  it('FAILS when the fence is renamed out from under BLOCK_RE', () => {
    // ```typescript is the realistic version of this: a valid, ordinary edit that
    // silently removes every block from the sweep.
    const r = sweep({
      'a.md': '# Guide\n\n```typescript\n// [verify]\nconst x = 1\nx // → 1\n```\n',
    })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/DISCOVERY FLOOR/)
  })

  it('FAILS when the guide shrinks below the floor rather than to zero', () => {
    // The floor is not just a zero check — a sweep finding one block cannot support
    // the claim the CI job makes either.
    const r = sweep({ 'a.md': block('const x = 1\nx // → 1') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/DISCOVERY FLOOR/)
  })

  it('does NOT apply to an explicitly named subset', () => {
    // `node scripts/verify-doc-examples.mjs docs/guide/combinators.md` is a deliberate
    // subset, and every other test in this file drives single fixture files that way.
    const r = verify(block('const x = 1\nx // → 1'))
    expect(r.ok).toBe(true)
    expect(r.out).not.toMatch(/DISCOVERY FLOOR/)
  })
})
