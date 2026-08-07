/**
 * Dump the EMITTED assembly source for a grammar + option set.
 *
 * The wiring sweep rewrites this exact text, so it has to come from the shipped
 * emitter (`src/table/emit-assembly.ts`), not from a reconstruction.
 */
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import type { RunCfg } from '../../src/table/assemble.ts'
import type { Combinator } from '../../src/types.ts'

export const STRICT: RunCfg = {
  hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
}

export function emitFor(rules: Record<string, Combinator<unknown>>, cfg: RunCfg = STRICT): {
  source: string
  ips: number[]
} {
  const prog = encodeTable(rules, {})
  const t = resolveTable(prog)
  const extraIps: number[] = []
  for (const s of prog.scans ?? []) {
    for (const r of s.skip) extraIps.push(r[0])
    if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
  }
  for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])
  const em = emitAssemblySource(t, prog, cfg, extraIps)
  const ips = [...new Set([...em.source.matchAll(/\b_pf(\d+)\b/g)].map(m => Number(m[1])))]
  return { source: em.source, ips }
}
