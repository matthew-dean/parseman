import { describe, expect, it } from 'vitest'
import { choice, node, noTrivia, optional, rules, sequence, literal, type Combinator } from '../../src/index.ts'
import { buildRegionIR } from '../../src/compiler/region-ir.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_OPT, OP_SEQV } from '../../src/table/ops.ts'
import { ownTableProgram, resolveTable, type TableProgram } from '../../src/table/program.ts'

const grammar = rules<Record<string, Combinator<unknown>>>(g => ({
  Entry: node('Entry', noTrivia(sequence(optional(literal('a')), literal('b'))), children => ({ children })),
  Left: sequence(literal('l'), g.Shared),
  Right: sequence(literal('r'), g.Shared),
  Shared: literal('s'),
})) as unknown as Record<string, Combinator<unknown>>

const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
function regionIr(prog: TableProgram = encodeTable(grammar), cfg = STRICT) {
  return buildRegionIR(resolveTable(prog), cfg)
}

describe('compiler-only RegionIR cover', () => {
  it('inventories every reachable row once and cuts shared joins', () => {
    const prog = encodeTable(grammar)
    const ir = regionIr(prog)
    const reached = [...reachableIps(prog)].sort((a, b) => a - b)
    const inventoried = ir.regions.flatMap(region => region.nodes.map(row => row.ip)).sort((a, b) => a - b)
    expect(inventoried).toEqual(reached)
    expect(new Set(inventoried).size).toBe(inventoried.length)

    const sharedIp = prog.rules.Shared!
    const incomingBoundaries = ir.regions.flatMap(region => region.boundaries).filter(row => row.ip === sharedIp)
    expect(incomingBoundaries.length).toBeGreaterThan(0)
    expect(incomingBoundaries.every(row => row.reason === 'rule' || row.reason === 'shared-join')).toBe(true)
  })

  it('builds the generic cap3 plus NSVO cover with typed scalar captures', () => {
    const prog = encodeTable(grammar)
    const ir = regionIr(prog)
    const candidate = ir.cover.candidates.find(row => row.key.match(/:N0\([SP]\(V2\(O\(K\),K\)\)\)$/))
    expect(candidate).toBeDefined()
    expect(candidate!.key).toMatch(/^A[UNT][01][012]:N0\([SP]\(V2\(O\(K\),K\)\)\)$/)
    expect(candidate!.ownedIps.map(ip => prog.code[ip])).toContain(OP_SEQV)
    expect(candidate!.ownedIps.map(ip => prog.code[ip])).toContain(OP_OPT)
    expect(candidate!.key).not.toMatch(/Entry|Shared|\d{3,}/)

    const nodeRow = ir.regions.flatMap(region => region.nodes).find(row => row.ip === candidate!.rootIp)!
    expect(nodeRow.operands.some(operand => operand.kind === 'callback')).toBe(true)
    expect(nodeRow.operands.some(operand => operand.kind === 'constant')).toBe(true)
    expect(nodeRow.effects).toEqual({ authority: 'table-opcode' })

    const gate = ir.regions.flatMap(region => region.nodes).find(row => row.opcode === prog.code[prog.rules.Entry!])!
    if (gate.opcode === 12) {
      expect(gate.operands.some(operand => operand.kind === 'class')).toBe(true)
      expect(gate.operands.some(operand => operand.kind === 'expected')).toBe(true)
    }

    const selected = ir.cover.chunks.flatMap(chunk => chunk.ownedIps)
    expect(new Set(selected).size).toBe(selected.length)
    expect(ir.cover.chunks.some(chunk => chunk.boundaries.some(row => row.reason === 'cover-split'))).toBe(true)
  })

  it('keys assembly-selected variants and statically removes GATE cover roots in probe/tolerant modes', () => {
    const strict = regionIr()
    const probe = regionIr(undefined, { ...STRICT, probe: true })
    const tolerant = regionIr(undefined, { ...STRICT, tolerant: true })
    expect(strict.variant).not.toEqual(probe.variant)
    expect(strict.variant).not.toEqual(tolerant.variant)
    expect(probe.cover.chunks.every(chunk => !chunk.key.includes(':G('))).toBe(true)
    expect(tolerant.cover.chunks.every(chunk => !chunk.key.includes(':G('))).toBe(true)
  })

  it('cuts an indegree-one recursive backedge instead of expanding it into its own region', () => {
    const recursive = rules<Record<string, Combinator<unknown>>>(g => ({
      Entry: choice(sequence(literal('('), g.Entry, literal(')')), literal('x')),
    })) as unknown as Record<string, Combinator<unknown>>
    const ir = regionIr(encodeTable(recursive))
    expect(ir.regions.flatMap(region => region.boundaries).some(row => row.reason === 'recursive-join')).toBe(true)
    expect(ir.regions.flatMap(region => region.nodes).length).toBe(reachableIps(encodeTable(recursive)).size)
  })

  it('is stable under rule-root visitation order and types GATE operands non-vacuously', () => {
    const prog = encodeTable(grammar)
    const clean = regionIr(prog)
    const reversedRules = Object.fromEntries(Object.entries(prog.rules).reverse())
    const reversed = regionIr(ownTableProgram({ ...prog, rules: reversedRules }))
    const canonical = (ir: ReturnType<typeof regionIr>) => ir.cover.chunks
      .map(chunk => ({ key: chunk.key, owned: [...chunk.ownedIps].sort((a, b) => a - b), boundaries: chunk.boundaries }))
      .sort((a, b) => a.owned[0]! - b.owned[0]!)
    expect(canonical(reversed)).toEqual(canonical(clean))

    const gate = clean.regions.flatMap(region => region.nodes).find(row => row.opcode === 12)!
    expect(gate.operands.map(operand => operand.kind)).toContain('class')
    expect(gate.operands.map(operand => operand.kind)).toContain('expected')
    // Recorded RED plant: treating +1/+3 as generic scalars preserves both
    // numbers while destroying the binders' ability to distinguish a class
    // predicate from its authored expected-set authority.
    expect(gate.operands.find(operand => operand.slot === 1)!.kind).toBe('class')
    expect(gate.operands.find(operand => operand.slot === 3)!.kind).toBe('expected')
  })

  it('has a non-vacuous structural plant: hiding the optional edge changes the authority', () => {
    const prog = encodeTable(grammar)
    const clean = regionIr(prog)
    const candidate = clean.cover.candidates.find(row => row.key.match(/:N0\([SP]\(V2\(O\(K\),K\)\)\)$/))!
    const seqIp = candidate.ownedIps.find(ip => prog.code[ip] === OP_SEQV)!
    const optIp = candidate.ownedIps.find(ip => prog.code[ip] === OP_OPT)!
    const code = [...prog.code]
    const childSlot = code[seqIp + 2] === optIp ? seqIp + 2 : seqIp + 3
    // Recorded RED plant: point the sequence slot at its ordinary sibling. This
    // used to leave a superficially plausible plan if the cover inventoried only
    // opcode counts. Full edge authority must change.
    code[childSlot] = code[childSlot === seqIp + 2 ? seqIp + 3 : seqIp + 2]!
    const planted = regionIr(ownTableProgram({ ...prog, code }))
    expect(planted.digest).not.toBe(clean.digest)
    expect(planted.cover.candidates.map(row => row.key)).not.toEqual(clean.cover.candidates.map(row => row.key))
  })
})
