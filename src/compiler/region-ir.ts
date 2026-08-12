import { childSlots } from '../table/child-slots.ts'
import {
  OP_ADJ, OP_GATE, OP_NODE, OP_NODE_TRACK, OP_OPT, OP_RULE, OP_SCOPE, OP_SCOPE_PLAIN,
  OP_SEQ, OP_SEQV,
} from '../table/ops.ts'
import type { ResolvedTable } from '../table/program.ts'
import type { RunCfg } from '../table/assemble.ts'
import { computeSiteLabels, reachableSites, type SiteLabel } from '../table/site-labels.ts'

/** Compiler-only evidence IR. It is deliberately absent from TableProgram. */
export type RegionOperand =
  | { kind: 'scalar' | 'callback' | 'constant' | 'trivia' | 'projection' | 'class' | 'expected'; slot: number; value: number }
  | { kind: 'child'; slot: number; ip: number }

export type RegionNode = {
  localId: number
  ip: number
  opcode: number
  operands: readonly RegionOperand[]
  children: readonly {
    slot: number
    role: 'child' | 'term' | 'arm' | 'selector' | 'fallback' | 'item' | 'separator'
    target: number | null
    boundary: number | null
  }[]
  /** No parallel effect table: executable binders must lower this opcode through one shared authority. */
  effects: { authority: 'table-opcode' }
}

export type Region = {
  id: number
  rootIp: number
  context: SiteLabel
  nodes: readonly RegionNode[]
  boundaries: readonly { id: number; ip: number; reason: 'rule' | 'shared-join' | 'recursive-join' | 'cover-split' }[]
  maximalKey: string
  coverKey: string
}

export type RegionIR = {
  version: 1
  variant: {
    hostCst: boolean
    hostReadsChildren: boolean
    /** Predicate-resolved assembly facts, never the callback itself. */
    nodeFacts: readonly (readonly [
      ip: number, captureWide: boolean, keepChildren: boolean, wantFields: boolean, tracked: boolean,
    ])[]
    trackLines: boolean
    tolerant: boolean
    coverage: boolean
    probe: boolean
    recovery: boolean
  }
  regions: readonly Region[]
  cover: {
    kind: 'cap3+NSVO'
    candidates: readonly { rootIp: number; context: SiteLabel; key: string; ownedIps: readonly number[]; boundaries: number }[]
    chunks: readonly {
      rootIp: number
      key: string
      ownedIps: readonly number[]
      boundaries: readonly { ip: number; reason: 'rule' | 'shared-join' | 'recursive-join' | 'cover-split' }[]
    }[]
    templates: readonly string[]
  }
  digest: string
}

/** Stable evidence digest without pulling a Node-only hash into compiler entry graphs. */
function hash(value: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ (c + i), 0x85ebca6b)
  }
  return `${a >>> 0}:${b >>> 0}:${value.length}`
}

function nodeEligible(t: ResolvedTable, ip: number): boolean {
  if (t.code[ip] !== OP_NODE) return false
  const flags = t.code[ip + 3]!
  return t.code[ip + 1]! >= 0 && t.code[ip + 4]! < 0 && (flags & (64 | 128)) === 0
}

function scopeEligible(t: ResolvedTable, ip: number): boolean {
  const op = t.code[ip]
  if (op !== OP_SCOPE && op !== OP_SCOPE_PLAIN) return false
  if (t.code[ip + 1] !== -1) return false
  if (op === OP_SCOPE && t.code[ip + 3] !== 0) return false
  return true
}

function sequenceEligible(t: ResolvedTable, ip: number): boolean {
  const op = t.code[ip]
  if (op !== OP_SEQ && op !== OP_SEQV) return false
  const n = t.code[ip + 1]!
  if (n !== 2 && n !== 3) return false
  for (let i = 0; i < n; i++) if (t.code[t.code[ip + 2 + i]!] === OP_ADJ) return false
  return true
}

function candidateEdge(t: ResolvedTable, parent: number, child: number): boolean {
  if (t.code[parent] === OP_GATE) return nodeEligible(t, child)
  if (nodeEligible(t, parent)) return scopeEligible(t, child) || sequenceEligible(t, child)
  if (scopeEligible(t, parent)) return sequenceEligible(t, child)
  if (sequenceEligible(t, parent)) return t.code[child] === OP_OPT || nodeEligible(t, child)
  return false
}

function nodeKind(t: ResolvedTable, ip: number): string {
  const op = t.code[ip]
  if (op === OP_GATE) return 'G'
  if (op === OP_NODE || op === OP_NODE_TRACK) return `N${t.code[ip + 3]! & (4 | 8 | 16 | 32)}`
  if (op === OP_SCOPE) return 'S'
  if (op === OP_SCOPE_PLAIN) return 'P'
  if (op === OP_SEQ) return `Q${t.code[ip + 1]}`
  if (op === OP_SEQV) return `V${t.code[ip + 1]}`
  if (op === OP_OPT) return 'O'
  return `K${op}`
}

function typedOperands(t: ResolvedTable, ip: number, kids: readonly number[]): RegionOperand[] {
  const child = kids.map((target, ordinal) => ({
    kind: 'child' as const,
    slot: childOperandSlot(t, ip, ordinal),
    ip: target,
  }))
  switch (t.code[ip]) {
    case OP_NODE: case OP_NODE_TRACK:
      return [
        { kind: 'callback', slot: 1, value: t.code[ip + 1]! },
        ...child,
        { kind: 'scalar', slot: 3, value: t.code[ip + 3]! },
        { kind: 'projection', slot: 4, value: t.code[ip + 4]! },
        { kind: 'constant', slot: 5, value: t.code[ip + 5]! },
        { kind: 'constant', slot: 6, value: t.code[ip + 6]! },
      ]
    case OP_SCOPE:
      return [
        { kind: 'trivia', slot: 1, value: t.code[ip + 1]! },
        ...child,
        { kind: 'scalar', slot: 3, value: t.code[ip + 3]! },
      ]
    case OP_SCOPE_PLAIN:
      return [{ kind: 'trivia', slot: 1, value: t.code[ip + 1]! }, ...child]
    case OP_SEQ: case OP_SEQV:
      return [{ kind: 'scalar', slot: 1, value: t.code[ip + 1]! }, ...child]
    case OP_OPT:
      return child
    case OP_GATE:
      return [
        { kind: 'class', slot: 1, value: t.code[ip + 1]! },
        ...child,
        { kind: 'expected', slot: 3, value: t.code[ip + 3]! },
      ]
    default:
      // The first executable cover owns only the rows above. Other opcodes are
      // still inventoried and terminate at a direct Piece boundary; their fixed
      // operands remain authoritative in TableProgram until a later cover adds
      // a typed decoder for them.
      return child
  }
}

function childOperandSlot(t: ResolvedTable, ip: number, ordinal: number): number {
  switch (t.code[ip]) {
    case OP_NODE: case OP_NODE_TRACK: case OP_SCOPE: case OP_SCOPE_PLAIN: case OP_GATE: return 2
    case OP_SEQ: case OP_SEQV: return 2 + ordinal
    case OP_OPT: return 1
    default: return ordinal
  }
}

/**
 * Build deterministic maximal ownership regions plus the admitted cap3+NSVO
 * cover. This is compiler evidence only: it serializes nothing and binds no
 * parser body.
 */
export function buildRegionIR(t: ResolvedTable, cfg: RunCfg): RegionIR {
  const roots = Object.values(t.rules)
  const labels = computeSiteLabels(t.code, roots, cfg.hostCst)
  const sites = [...reachableSites(t.code, roots)].sort((a, b) => a - b)
  const children = new Map<number, number[]>()
  const incoming = new Map<number, number>()
  for (const ip of sites) {
    const out: number[] = []
    if (!childSlots(t.code, ip, out)) throw new Error(`region IR: unknown opcode ${String(t.code[ip])}`)
    children.set(ip, out)
    for (const kid of out) incoming.set(kid, (incoming.get(kid) ?? 0) + 1)
  }
  const ruleRoots = new Set(roots)
  const regionRoots = sites.filter(ip => ruleRoots.has(ip) || t.code[ip] === OP_RULE || (incoming.get(ip) ?? 0) !== 1)
  const regionByIp = new Map<number, number>()
  const recursiveEdges = new Set<string>()
  const rows: Array<{ root: number; ips: number[] }> = []
  for (const root of regionRoots) {
    if (regionByIp.has(root) && (incoming.get(root) ?? 0) === 1) continue
    const ips: number[] = []
    const gray = new Set<number>()
    const visit = (ip: number): void => {
      if (regionByIp.has(ip)) return
      regionByIp.set(ip, rows.length)
      ips.push(ip)
      gray.add(ip)
      const out = children.get(ip) ?? []
      for (const kid of out) {
        if (gray.has(kid)) { recursiveEdges.add(`${ip}>${kid}`); continue }
        if ((incoming.get(kid) ?? 0) === 1 && t.code[kid] !== OP_RULE) visit(kid)
      }
      gray.delete(ip)
    }
    visit(root)
    rows.push({ root, ips })
  }
  if (regionByIp.size !== sites.length) throw new Error('region IR: reachable site omission')

  const shape = (ip: number, local: ReadonlySet<number>, seen = new Set<number>()): string => {
    if (!local.has(ip) || seen.has(ip)) return 'K'
    seen.add(ip)
    return `${nodeKind(t, ip)}(${(children.get(ip) ?? []).map(kid => recursiveEdges.has(`${ip}>${kid}`)
      ? 'K' : shape(kid, local, seen)).join(',')})`
  }
  const cover = (
    ip: number, local: ReadonlySet<number>, depth: number, trail: readonly string[], seen = new Set<number>(),
  ): { key: string; ips: number[]; boundaries: number } => {
    if (!local.has(ip) || seen.has(ip)) return { key: 'K', ips: [], boundaries: 1 }
    seen.add(ip)
    const head = nodeKind(t, ip)
    const here = [...trail, head]
    const ips = [ip]
    let boundaries = 0
    const parts = (children.get(ip) ?? []).map(kid => {
      const nsvo = here.join('>') === 'N0>S>V2' && t.code[kid] === OP_OPT
      if (recursiveEdges.has(`${ip}>${kid}`) || !candidateEdge(t, ip, kid) || (depth + 1 >= 3 && !nsvo)) {
        boundaries++
        return 'K'
      }
      const result = cover(kid, local, depth + 1, here, seen)
      ips.push(...result.ips)
      boundaries += result.boundaries
      return result.key
    })
    return { key: `${head}(${parts.join(',')})`, ips, boundaries }
  }
  const contextKey = (ip: number): string => {
    const at = labels.at(ip)
    const tri = at.tri === -2 ? 'U' : at.tri === -1 ? 'N' : 'T'
    return `A${tri}${at.buf ? 1 : 0}${at.cap}`
  }

  const regions: Region[] = rows.map((row, id) => {
    const local = new Set(row.ips)
    const boundaryByIp = new Map<number, number>()
    const boundaries: Region['boundaries'][number][] = []
    const boundary = (ip: number, reason: Region['boundaries'][number]['reason']): number => {
      const hit = boundaryByIp.get(ip)
      if (hit !== undefined) return hit
      const made = boundaries.length
      boundaryByIp.set(ip, made)
      boundaries.push({ id: made, ip, reason })
      return made
    }
    const localId = new Map(row.ips.map((ip, i) => [ip, i]))
    const nodes: RegionNode[] = row.ips.map((ip, i) => {
      const out = children.get(ip) ?? []
      const op = t.code[ip]!
      const role = (slot: number): RegionNode['children'][number]['role'] => {
        if (op === OP_SEQ || op === OP_SEQV) return 'term'
        return 'child'
      }
      return {
        localId: i,
        ip,
        opcode: t.code[ip]!,
        operands: typedOperands(t, ip, out),
        children: out.map((kid, ordinal) => {
          const slot = childOperandSlot(t, ip, ordinal)
          const target = localId.get(kid)
          if (target !== undefined && !recursiveEdges.has(`${ip}>${kid}`)) return { slot, role: role(slot), target, boundary: null }
          const reason = t.code[kid] === OP_RULE ? 'rule'
            : recursiveEdges.has(`${ip}>${kid}`) ? 'recursive-join' : 'shared-join'
          return { slot, role: role(slot), target: null, boundary: boundary(kid, reason) }
        }),
        effects: { authority: 'table-opcode' },
      }
    })
    return {
      id,
      rootIp: row.root,
      context: labels.at(row.root),
      nodes,
      boundaries,
      maximalKey: shape(row.root, local),
      coverKey: `${contextKey(row.root)}:${cover(row.root, local, 0, []).key}`,
    }
  })
  const candidates = sites.flatMap(rootIp => {
    // OP_GATE is an assembly-selected alias in tolerant/probe modes. It is not
    // a regional runtime branch and therefore cannot be a cover root there.
    if ((cfg.tolerant || cfg.probe) && t.code[rootIp] === OP_GATE) return []
    if (!(children.get(rootIp) ?? []).some(kid => candidateEdge(t, rootIp, kid))) return []
    const regionId = regionByIp.get(rootIp)!
    const local = new Set(rows[regionId]!.ips)
    const result = cover(rootIp, local, 0, [])
    return [{ rootIp, context: labels.at(rootIp), key: `${contextKey(rootIp)}:${result.key}`, ownedIps: result.ips, boundaries: result.boundaries }]
  })
  const candidateByRoot = new Map(candidates.map(candidate => [candidate.rootIp, candidate]))
  const chunks: RegionIR['cover']['chunks'][number][] = []
  const visited = new Set<number>()
  const select = (ip: number): void => {
    if (visited.has(ip)) return
    const candidate = candidateByRoot.get(ip)
    if (candidate === undefined) {
      visited.add(ip)
      for (const kid of children.get(ip) ?? []) select(kid)
      return
    }
    const owned = new Set(candidate.ownedIps)
    for (const site of owned) visited.add(site)
    const boundaryByIp = new Map<number, RegionIR['cover']['chunks'][number]['boundaries'][number]>()
    for (const site of owned) {
      for (const kid of children.get(site) ?? []) {
        if (owned.has(kid) || boundaryByIp.has(kid)) continue
        const parentRegion = regionByIp.get(site)
        const childRegion = regionByIp.get(kid)
        const reason = recursiveEdges.has(`${site}>${kid}`) ? 'recursive-join'
          : childRegion === parentRegion ? 'cover-split'
          : t.code[kid] === OP_RULE ? 'rule'
            : childRegion === undefined ? 'recursive-join' : 'shared-join'
        boundaryByIp.set(kid, { ip: kid, reason })
      }
    }
    chunks.push({
      rootIp: ip,
      key: candidate.key,
      ownedIps: candidate.ownedIps,
      boundaries: [...boundaryByIp.values()].sort((a, b) => a.ip - b.ip),
    })
    for (const row of boundaryByIp.values()) select(row.ip)
  }
  for (const root of regionRoots) select(root)
  // A node reachable only through a join already visited from another root is
  // intentionally not cloned. Anything else is an authority omission.
  if (visited.size !== sites.length) throw new Error('region cover: reachable site omission')
  const templates = [...new Set(chunks.map(chunk => chunk.key))].sort()
  const variant: RegionIR['variant'] = {
    hostCst: cfg.hostCst,
    hostReadsChildren: cfg.hostReadsChildren !== false,
    nodeFacts: sites.flatMap(ip => {
      if (t.code[ip] !== OP_NODE && t.code[ip] !== OP_NODE_TRACK) return []
      const flags = t.code[ip + 3]!
      const build = t.code[ip + 1]! >= 0
      const proj = t.code[ip + 4]!
      const type = t.k[t.code[ip + 5]!]
      const trailingTrivia = (flags & 128) !== 0
      const structural = !build && proj < 0
      const grammarCapture = (flags & 1) !== 0 || trailingTrivia
      const hostCapture = structural && cfg.hostCaptureTrivia !== undefined && typeof type === 'string'
        ? cfg.hostCaptureTrivia(type)
        : undefined
      const captureWide = (flags & 4) !== 0 || cfg.hostCst
        ? !structural || grammarCapture || hostCapture !== false
        : hostCapture === true
      const keepChildren = !structural || cfg.hostReadsChildren !== false
        || (flags & (32 | 64)) !== 0
      return [[ip, captureWide, keepChildren, (flags & 16) !== 0 || cfg.hostCst,
        t.code[ip] === OP_NODE_TRACK] as const]
    }),
    trackLines: cfg.trackLines,
    tolerant: cfg.tolerant,
    coverage: cfg.coverage,
    probe: cfg.probe,
    recovery: t.prog.rec === 1 && cfg.tolerant,
  }
  const canonical = JSON.stringify({ variant, regions: regions.map(region => ({
    rootIp: region.rootIp,
    context: region.context,
    nodes: region.nodes,
    boundaries: region.boundaries,
    maximalKey: region.maximalKey,
    coverKey: region.coverKey,
  })), chunks })
  return {
    version: 1,
    variant,
    regions,
    cover: { kind: 'cap3+NSVO', candidates, chunks, templates },
    digest: hash(canonical),
  }
}
