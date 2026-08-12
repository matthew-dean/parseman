/** Compiler-only RegionIR/cover census. No parser body is linked or executed. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { buildRegionIR } from '../../src/compiler/region-ir.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { resolveTable } from '../../src/table/program.ts'
import { JESS_ROOT, assertParseman, loadGrammar } from './grammars.ts'

const pm = await assertParseman()
const sha = (cwd: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const status = (cwd: string): string => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()
const templates = new Set<string>()
const templateSources = new Map<string, string>()
const dialects = []
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function functionBody(source: string, ip: number): string {
  const at = source.indexOf(`function _pf${ip}(`)
  if (at < 0) return ''
  const brace = source.indexOf('{', at)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125 && --depth === 0) return source.slice(at, i + 1)
  }
  throw new Error(`unterminated emitted body ${ip}`)
}

function normalizeBody(source: string, ip: number): string {
  const names = new Map<string, string>()
  const counts = new Map<string, number>()
  return functionBody(source, ip)
    .replace(`function _pf${ip}`, 'function block')
    .replace(/_(pf|fn|tv|tl|cl|fx|k)(\d+)/g, whole => {
      const hit = names.get(whole)
      if (hit !== undefined) return hit
      const kind = /^_([a-z]+)/.exec(whole)![1]!
      const made = `_${kind}${counts.get(kind) ?? 0}`
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      names.set(whole, made)
      return made
    })
}

for (const dialect of ['css', 'less'] as const) {
  const loaded = await loadGrammar(dialect, 'ast')
  const prog = encodeTable(loaded.rules, {})
  const resolved = resolveTable(prog)
  const ir = buildRegionIR(resolved, STRICT)
  const emitted = emitAssemblySource(resolved, prog, {
    hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
  })
  const localSources = new Map<string, string>()
  for (const candidate of ir.cover.chunks) {
    if (localSources.has(candidate.key)) continue
    const source = candidate.ownedIps.map(ip => normalizeBody(emitted.source, ip)).join('\n')
    localSources.set(candidate.key, source)
    if (!templateSources.has(candidate.key)) templateSources.set(candidate.key, source)
  }
  for (const template of ir.cover.templates) templates.add(template)
  dialects.push({
    dialect,
    words: prog.code.length,
    regions: ir.regions.length,
    rows: ir.regions.reduce((n, region) => n + region.nodes.length, 0),
    contexts: new Set(ir.regions.map(region => JSON.stringify(region.context))).size,
    candidates: ir.cover.candidates.length,
    chunks: ir.cover.chunks.length,
    templates: ir.cover.templates.length,
    maxOwnedOps: Math.max(...ir.cover.candidates.map(candidate => candidate.ownedIps.length)),
    sourceUpperRaw: Buffer.byteLength([...localSources.values()].join('\n')),
    sourceUpperGzip: gzipSync([...localSources.values()].join('\n')).byteLength,
    digest: ir.digest,
  })
}

const report = {
  protocol: 'region-ir-cover-v1',
  provenance: {
    parseman: { root: realpathSync(pm.root), sha: sha(pm.root), status: status(pm.root) },
    jess: { root: realpathSync(JESS_ROOT), sha: sha(JESS_ROOT), status: status(JESS_ROOT) },
    engine: realpathSync(new URL('../../src/compiler/region-ir.ts', import.meta.url)),
  },
  dialects,
  unionTemplates: templates.size,
  unionSourceUpperRaw: Buffer.byteLength([...templateSources.values()].join('\n')),
  unionSourceUpperGzip: gzipSync([...templateSources.values()].join('\n')).byteLength,
  templateDigest: createHash('sha256').update([...templates].sort().join('\n')).digest('hex'),
}
console.log(JSON.stringify(report, null, 2))
if (dialects.some(row => row.rows === 0 || row.candidates === 0) || templates.size === 0) {
  throw new Error('region census plant: no reachable regions/candidates/templates')
}
