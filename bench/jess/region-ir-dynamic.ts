/** RED-proven dynamic coverage for the compiler-only RegionIR cover. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { buildRegionIR } from '../../src/compiler/region-ir.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable } from '../../src/table/program.ts'
import { ENTRY, JESS_ROOT, assertParseman, loadGrammar, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect
const fixture = process.argv[3]
if ((dialect !== 'css' && dialect !== 'less') || (fixture !== 'benchmark' && fixture !== 'generated')) {
  throw new Error('usage: region-ir-dynamic.ts <css|less> <benchmark|generated>')
}
if (dialect === 'css' && fixture !== 'benchmark') throw new Error('CSS supports benchmark only')

const pm = await assertParseman()
const pmRoot = realpathSync(pm.root)
const jessRoot = realpathSync(JESS_ROOT)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const sha = (cwd: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

let input: string
let inputSource: string
if (fixture === 'generated') {
  const generator = realpathSync(resolve(jessRoot, 'packages/jess/benchmark/gen-workload.mjs'))
  const { generate } = await import(pathToFileURL(generator).href) as { generate: (dialect: string) => string }
  input = generate('less')
  inputSource = `${generator}#generate(less,defaults)`
} else {
  inputSource = realpathSync(resolve(jessRoot, `packages/jess/benchmark/benchmark.${dialect}`))
  input = readFileSync(inputSource, 'utf8')
}

// Build a temporary test-only module from the shipping closure assembler. The
// only source change wraps each linked Piece and records parent>child calls.
// Production source remains byte-identical; brittle anchors fail closed if the
// assembler seam changes.
const originalPath = realpathSync(resolve(pmRoot, 'src/table/assemble.ts'))
const originalDir = dirname(originalPath)
let source = readFileSync(originalPath, 'utf8')
const typeAnchor = 'type Piece = (input: string, pos: number, ctx: ParseContext) => unknown\n'
if (!source.includes(typeAnchor)) throw new Error('dynamic region profiler: Piece anchor moved')
source = source.replace(typeAnchor, `${typeAnchor}
export const regionProfile = { calls: 0, edges: new Map<string, number>() }
const regionStack: number[] = []
`)
const linkAnchor = '    const piece = lower(ip)\n'
if (!source.includes(linkAnchor)) throw new Error('dynamic region profiler: link anchor moved')
source = source.replace(linkAnchor, `    const rawPiece = lower(ip)
    const piece: Piece = (input, pos, ctx) => {
      const parent = regionStack[regionStack.length - 1]
      if (parent !== undefined) {
        const edge = parent + '>' + ip
        regionProfile.edges.set(edge, (regionProfile.edges.get(edge) ?? 0) + 1)
      }
      regionProfile.calls++
      regionStack.push(ip)
      try { return rawPiece(input, pos, ctx) } finally { regionStack.pop() }
    }
`)
source = source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_all, quote: string, spec: string) => {
  const absolute = pathToFileURL(resolve(originalDir, spec)).href
  return `from ${quote}${absolute}${quote}`
})
const temp = mkdtempSync(resolve(tmpdir(), 'parseman-region-profile-'))
const instrumentedPath = resolve(temp, 'assemble.ts')
writeFileSync(instrumentedPath, source)
const instrumented = await import(`${pathToFileURL(instrumentedPath).href}?${Date.now()}`) as {
  tableRules: (prog: unknown) => Record<string, unknown>
  regionProfile: { calls: number; edges: Map<string, number> }
}

try {
  const loaded = await loadGrammar(dialect, 'ast')
  const prog = encodeTable(loaded.rules, {})
  const resolved = resolveTable(prog)
  const strict = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
  const ir = buildRegionIR(resolved, strict)
  const sourceEntry = loaded.rules[ENTRY]!
  const referenceEntry = execRules(prog)[ENTRY]!
  const closureEntry = instrumented.tableRules({ ...prog, asm: [] })[ENTRY]!
  const trivia = loaded.rules.whitespace!
  const opts = dialect === 'less'
    ? { trivia, state: { source: input, mathMode: 'parens-division' as const }, rootTrivia: { select: ['lineComment', 'blockComment'] } }
    : { trivia, rootTrivia: { select: ['blockComment'] } }
  const parseInput = process.env.PM_REGION_PROFILE_PLANT === 'truncate' ? input.slice(0, -1) : input
  const results = [run(sourceEntry, input, opts), run(referenceEntry, input, opts), run(closureEntry as never, parseInput, opts)]
  const summary = results.map(result => ({
    ok: result.ok,
    consumed: result.ok ? result.unconsumedFrom ?? input.length : input.length,
    full: result.ok && (result.unconsumedFrom ?? input.length) === input.length,
    digest: hash(digestValue(result)),
  }))
  if (process.env.PM_REGION_PROFILE_PLANT === 'zero') {
    instrumented.regionProfile.calls = 0
    instrumented.regionProfile.edges.clear()
  }
  const covered = new Set<string>()
  const ownerByIp = new Map(ir.regions.flatMap(region => region.nodes.map(node => [node.ip, region] as const)))
  for (const chunk of ir.cover.chunks) {
    const owned = new Set(chunk.ownedIps)
    for (const parent of owned) {
      const region = ownerByIp.get(parent)!
      const row = region.nodes.find(node => node.ip === parent)!
      for (const child of row.children) {
        if (child.target === null) continue
        const targetIp = region.nodes[child.target]!.ip
        if (owned.has(targetIp)) covered.add(`${parent}>${targetIp}`)
      }
    }
  }
  let coveredCalls = 0
  for (const edge of covered) coveredCalls += instrumented.regionProfile.edges.get(edge) ?? 0
  const report = {
    protocol: 'region-ir-dynamic-v1',
    provenance: {
      parseman: { root: pmRoot, sha: sha(pmRoot) },
      jess: { root: jessRoot, sha: sha(jessRoot) },
      input: { source: inputSource, bytes: Buffer.byteLength(input), sha256: hash(input) },
      engines: {
        source: realpathSync(resolve(pmRoot, 'src/functional/run.ts')),
        reference: realpathSync(resolve(pmRoot, 'src/table/exec.ts')),
        closure: originalPath,
        instrumented: instrumentedPath,
      },
    },
    identity: { source: summary[0], reference: summary[1], closure: summary[2] },
    cover: {
      calls: instrumented.regionProfile.calls,
      coveredCalls,
      ratio: coveredCalls / instrumented.regionProfile.calls,
      dynamicEdges: instrumented.regionProfile.edges.size,
      coveredEdges: covered.size,
      chunks: ir.cover.chunks.length,
      templates: ir.cover.templates.length,
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!summary.every(row => row.full) || new Set(summary.map(row => row.digest)).size !== 1) {
    throw new Error('dynamic region profiler: full identity failed')
  }
  if (instrumented.regionProfile.calls === 0 || instrumented.regionProfile.edges.size === 0) {
    throw new Error('dynamic region profiler counter plant: no calls/edges')
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
