/**
 * Experimental build-time Entry/SCC supercompiler for static table assemblies.
 *
 * The table emitter remains the sole semantic backend.  This pass parses that
 * backend's ordinary JavaScript and joins uniquely-owned piece functions with
 * labelled blocks.  It never evaluates source and it never recognizes grammar
 * names or reducer text.  Public entries, value references, shared joins,
 * recursive SCCs, and effect rows are exact outline barriers.
 */
import { parseSync } from 'oxc-parser'
import { OP_ATTEMPT, OP_NODE, OP_NODE_TRACK, OP_REPV, OP_SCAN } from '../table/ops.ts'
import { emitAssemblySource, type EmitResult } from '../table/emit-assembly.ts'
import { defaultAssemblyCfgs } from '../table/emit.ts'
import { resolveTable, type TableProgram } from '../table/program.ts'

type Ast = { type: string; start?: number; end?: number; [key: string]: unknown }

export type EntrySupercompileCfg = {
  readonly hostCst: boolean
  readonly hostReadsChildren?: boolean
  readonly hostCaptureTrivia?: ((type: string) => boolean) | undefined
  readonly trackLines: boolean
  readonly tolerant: boolean
  readonly coverage: boolean
  readonly probe: boolean
}

export type EntrySupercompileStats = {
  readonly activated: boolean
  readonly reason?: string
  readonly functionsBefore: number
  readonly functionsAfter: number
  readonly pieceCallsBefore: number
  readonly pieceCallsAfter: number
  readonly sourceBefore: number
  readonly sourceAfter: number
  readonly regions: number
  readonly largestRegionSource: number
  readonly largestRegionIp?: number
  readonly protocolRegions: Readonly<{ node: number; repv: number; nodeAndRepv: number }>
  readonly barriers: Readonly<Record<string, number>>
}

export type EntrySupercompileResult = EmitResult & { readonly supercompile: EntrySupercompileStats }

type Fn = {
  readonly ip: number
  readonly name: string
  readonly node: Ast
  readonly body: Ast
  readonly calls: Call[]
}

type Call = {
  readonly caller: number
  readonly callee: number
  readonly node: Ast
  readonly statement: Ast
  readonly args: readonly Ast[]
  readonly transformable: boolean
}

type Edit = { readonly start: number; readonly end: number; readonly text: string }

const PIECE = /^_pf(\d+)$/
const WRAP = 'function __parseman_supercompile__(){\n'
const SUFFIX = '\n}'

function ast(value: unknown): Ast | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Ast : undefined
}

function nodes(value: unknown): Ast[] {
  return Array.isArray(value) ? value.filter(v => ast(v) !== undefined) as Ast[] : []
}

function nameOf(node: Ast | undefined): string | undefined {
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined
}

function range(node: Ast): { start: number; end: number } {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') throw new Error('entry supercompiler: AST node without range')
  return { start: node.start - WRAP.length, end: node.end - WRAP.length }
}

function children(node: Ast): Ast[] {
  const out: Ast[] = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    if (Array.isArray(value)) {
      for (const child of value) {
        const c = ast(child)
        if (c !== undefined) out.push(c)
      }
    } else {
      const c = ast(value)
      if (c !== undefined) out.push(c)
    }
  }
  return out
}

function isFunction(node: Ast): boolean {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
}

function isDirectCallUse(call: Ast, parent: Ast | undefined, statement: Ast): boolean {
  if (parent === undefined) return false
  if (parent.type === 'VariableDeclarator') {
    const declarations = statement.type === 'VariableDeclaration' ? nodes(statement.declarations) : []
    return declarations.length === 1 && declarations[0] === parent && parent.init === call
  }
  if (parent.type === 'AssignmentExpression') {
    return statement.type === 'ExpressionStatement' && statement.expression === parent
      && nameOf(ast(parent.left)) !== undefined && parent.right === call && parent.operator === '='
  }
  if (parent.type === 'ReturnStatement') return statement === parent && parent.argument === call
  return false
}

function isListStatement(statement: Ast, parent: Ast | undefined): boolean {
  if (parent?.type === 'BlockStatement') return nodes(parent.body).includes(statement)
  if (parent?.type === 'SwitchCase') return nodes(parent.consequent).includes(statement)
  return false
}

function hasInlineScopeHazard(fn: Fn): boolean {
  if (fn.node.async === true || fn.node.generator === true) return true
  let hazard = false
  const walk = (node: Ast): void => {
    if (hazard) return
    if (node.type === 'Identifier' && node.name === 'arguments') hazard = true
    else if (node.type === 'ThisExpression') hazard = true
    else if (node.type === 'VariableDeclaration' && node.kind === 'var') hazard = true
    else if (node.type === 'MetaProperty'
      && nameOf(ast(node.meta)) === 'new' && nameOf(ast(node.property)) === 'target') hazard = true
    else for (const child of children(node)) walk(child)
  }
  walk(fn.body)
  return hazard
}

function hasInlineSignature(fn: Fn): boolean {
  const params = nodes(fn.node.params)
  return params.length === 3
    && nameOf(params[0]) === 'input'
    && nameOf(params[1]) === 'pos'
    && nameOf(params[2]) === 'ctx'
}

function render(source: string, start: number, end: number, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  let at = start
  let out = ''
  for (const edit of ordered) {
    if (edit.start < at || edit.end < edit.start || edit.start < start || edit.end > end) {
      throw new Error('entry supercompiler: overlapping or out-of-range structured edit')
    }
    out += source.slice(at, edit.start) + edit.text
    at = edit.end
  }
  return out + source.slice(at, end)
}

/** Tarjan over the actual emitted piece-call graph. */
function recursiveMembers(fns: ReadonlyMap<number, Fn>): Set<number> {
  let next = 0
  const index = new Map<number, number>()
  const low = new Map<number, number>()
  const stack: number[] = []
  const on = new Set<number>()
  const recursive = new Set<number>()
  const visit = (ip: number): void => {
    index.set(ip, next); low.set(ip, next); next++
    stack.push(ip); on.add(ip)
    for (const call of fns.get(ip)?.calls ?? []) {
      if (!fns.has(call.callee)) continue
      if (!index.has(call.callee)) {
        visit(call.callee)
        low.set(ip, Math.min(low.get(ip)!, low.get(call.callee)!))
      } else if (on.has(call.callee)) low.set(ip, Math.min(low.get(ip)!, index.get(call.callee)!))
    }
    if (low.get(ip) !== index.get(ip)) return
    const component: number[] = []
    for (;;) {
      const member = stack.pop()!
      on.delete(member); component.push(member)
      if (member === ip) break
    }
    if (component.length > 1 || component.some(member => fns.get(member)!.calls.some(c => c.callee === member))) {
      for (const member of component) recursive.add(member)
    }
  }
  for (const ip of fns.keys()) if (!index.has(ip)) visit(ip)
  return recursive
}

function fallback(emitted: EmitResult, reason: string, before: Omit<EntrySupercompileStats, 'activated' | 'reason' | 'functionsAfter' | 'pieceCallsAfter' | 'sourceAfter' | 'regions' | 'largestRegionSource' | 'largestRegionIp' | 'protocolRegions'>): EntrySupercompileResult {
  return {
    ...emitted,
    supercompile: {
      ...before, activated: false, reason,
      functionsAfter: before.functionsBefore,
      pieceCallsAfter: before.pieceCallsBefore,
      sourceAfter: before.sourceBefore,
      regions: before.functionsBefore,
      largestRegionSource: 0,
      protocolRegions: { node: 0, repv: 0, nodeAndRepv: 0 },
    },
  }
}

/**
 * Emit and structurally join one static assembly.  `extraIps` are the same
 * externally-addressable scan roots passed to the canonical emitter.
 */
export function supercompileEntryAssembly(
  prog: TableProgram,
  cfg: EntrySupercompileCfg,
  extraIps: readonly number[] = [],
): EntrySupercompileResult {
  const emitted = emitAssemblySource(resolveTable(prog), prog, cfg, extraIps, true)
  return supercompileEmittedAssembly(prog, cfg, extraIps, emitted)
}

/**
 * Plugin-only final splice for an ordinary macro replacement. The table
 * compiler emits its canonical callback-free public artifact first; this pass
 * then finds the precompiled assembly through the table object's AST shape and
 * replaces only that factory body. Any mismatch returns the canonical source.
 */
export function supercompileRuleMapReplacement(prog: TableProgram, replacement: string): string {
  const cfg = defaultAssemblyCfgs(prog)[0]
  if (cfg === undefined) return replacement
  const extraIps: number[] = []
  for (const scan of prog.scans ?? []) {
    for (const ref of scan.skip) extraIps.push(ref[0])
    if (scan.sentinel !== undefined) extraIps.push(scan.sentinel[0])
  }
  for (const set of prog.scanSkip ?? []) for (const ref of set) extraIps.push(ref[0])

  let canonical: EmitResult
  let candidate: EntrySupercompileResult
  try {
    canonical = emitAssemblySource(resolveTable(prog), prog, cfg, extraIps, true)
    candidate = supercompileEmittedAssembly(prog, cfg, extraIps, canonical)
  } catch {
    return replacement
  }
  if (!candidate.supercompile.activated) return replacement

  const prefix = 'const __parseman_macro_replacement__='
  const parsed = parseSync('parseman-entry-supercompile-replacement.js', prefix + replacement)
  if (parsed.errors.length > 0) return replacement
  const program = parsed.program as unknown as Ast
  const declaration = nodes(program.body)[0]
  const declarator = nodes(declaration?.declarations)[0]
  const call = ast(declarator?.init)
  const table = nodes(call?.arguments)[0]
  if (declaration?.type !== 'VariableDeclaration' || declarator?.type !== 'VariableDeclarator'
    || call?.type !== 'CallExpression' || table?.type !== 'ObjectExpression') return replacement

  const property = (object: Ast, key: string): Ast | undefined => nodes(object.properties).find(prop =>
    prop.type === 'Property' && nameOf(ast(prop.key)) === key)
  const assembliesProp = property(table, 'a')
  const assemblies = nodes(ast(assembliesProp?.value)?.elements)
  if (assembliesProp === undefined || assemblies.length !== 1 || assemblies[0]?.type !== 'ObjectExpression') return replacement
  const factoryProp = property(assemblies[0]!, 'factory')
  const factory = ast(factoryProp?.value)
  const body = ast(factory?.body)
  if (factory?.type !== 'FunctionExpression' || body?.type !== 'BlockStatement') return replacement
  if (typeof body.start !== 'number' || typeof body.end !== 'number') return replacement
  const start = body.start - prefix.length + 1
  const end = body.end - prefix.length - 1
  if (replacement.slice(start, end) !== canonical.source + '\n') return replacement
  const transformed = replacement.slice(0, start) + candidate.source + '\n' + replacement.slice(end)
  const checked = parseSync('parseman-entry-supercompile-replacement-result.js', prefix + transformed)
  return checked.errors.length === 0 ? transformed : replacement
}

/** Build-hook form: transform the exact canonical source already selected. */
export function supercompileEmittedAssembly(
  prog: TableProgram,
  _cfg: EntrySupercompileCfg,
  extraIps: readonly number[],
  emitted: EmitResult,
): EntrySupercompileResult {
  const source = emitted.source
  const parsed = parseSync('parseman-entry-supercompile.js', WRAP + source + SUFFIX)
  if (parsed.errors.length > 0) {
    const zero = { functionsBefore: 0, pieceCallsBefore: 0, sourceBefore: source.length, barriers: {} }
    return fallback(emitted, 'canonical emitted source did not parse', zero)
  }
  const program = parsed.program as unknown as Ast
  const wrapper = nodes(program.body)[0]
  const wrapperBody = ast(wrapper?.body)
  if (wrapper?.type !== 'FunctionDeclaration' || wrapperBody?.type !== 'BlockStatement') {
    const zero = { functionsBefore: 0, pieceCallsBefore: 0, sourceBefore: source.length, barriers: {} }
    return fallback(emitted, 'missing compiler wrapper', zero)
  }

  const fns = new Map<number, Fn>()
  for (const statement of nodes(wrapperBody.body)) {
    if (statement.type !== 'FunctionDeclaration') continue
    const name = nameOf(ast(statement.id))
    const hit = name === undefined ? undefined : PIECE.exec(name)
    const body = ast(statement.body)
    if (hit !== undefined && hit !== null && body?.type === 'BlockStatement') {
      const ip = Number(hit[1])
      fns.set(ip, { ip, name: name!, node: statement, body, calls: [] })
    }
  }

  const externalRefs = new Set<number>()
  let reservedCollision = false
  const allCalls: Call[] = []
  const walk = (
    node: Ast,
    current: Fn | undefined,
    parent: Ast | undefined,
    statement: Ast | undefined,
    statementParent: Ast | undefined,
  ): void => {
    if (isFunction(node) && node !== current?.node) {
      const own = node.type === 'FunctionDeclaration' ? nameOf(ast(node.id)) : undefined
      const hit = own === undefined ? undefined : PIECE.exec(own)
      if (hit !== undefined && hit !== null) {
        const fn = fns.get(Number(hit[1]))
        if (fn !== undefined) {
          for (const child of children(node)) {
            if (child !== ast(node.id)) walk(child, fn, node, undefined, undefined)
          }
          return
        }
      }
      // Non-piece closures may retain piece values.  They are external roots;
      // do not treat their returns as exits from a piece being joined.
      current = undefined
    }

    let owner = statement
    let ownerParent = statementParent
    if (parent?.type === 'BlockStatement' && nodes(parent.body).includes(node)) { owner = node; ownerParent = parent }
    if (parent?.type === 'SwitchCase' && nodes(parent.consequent).includes(node)) { owner = node; ownerParent = parent }

    if (node.type === 'CallExpression') {
      const calleeName = nameOf(ast(node.callee))
      const hit = calleeName === undefined ? undefined : PIECE.exec(calleeName)
      if (hit !== undefined && hit !== null) {
        const callee = Number(hit[1])
        const args = nodes(node.arguments)
        const transformable = current !== undefined && owner !== undefined && args.length === 3
          && nameOf(args[0]) === 'input' && nameOf(args[2]) === 'ctx'
          && isDirectCallUse(node, parent, owner) && isListStatement(owner, ownerParent)
        if (current === undefined || owner === undefined) externalRefs.add(callee)
        else {
          const call = { caller: current.ip, callee, node, statement: owner, args, transformable }
          current.calls.push(call); allCalls.push(call)
        }
      }
    }
    if (node.type === 'Identifier') {
      if (typeof node.name === 'string' && /^_z\d/.test(node.name)) reservedCollision = true
      const hit = typeof node.name === 'string' ? PIECE.exec(node.name) : null
      if (hit !== null) {
        const isDecl = parent?.type === 'FunctionDeclaration' && parent.id === node
        const isCall = parent?.type === 'CallExpression' && parent.callee === node
        if (!isDecl && !isCall) externalRefs.add(Number(hit[1]))
      }
    }
    for (const child of children(node)) walk(child, current, node, owner, ownerParent)
  }
  for (const statement of nodes(wrapperBody.body)) walk(statement, undefined, wrapperBody, undefined, undefined)

  if (reservedCollision) {
    const before = { functionsBefore: fns.size, pieceCallsBefore: allCalls.length, sourceBefore: source.length, barriers: { name: 1 } }
    return fallback(emitted, 'canonical source uses the reserved _z<N> supercompiler prefix', before)
  }

  const pieceCallsBefore = allCalls.length
  const recursive = recursiveMembers(fns)
  const incoming = new Map<number, Call[]>()
  for (const call of allCalls) {
    const list = incoming.get(call.callee) ?? []
    list.push(call); incoming.set(call.callee, list)
  }
  const publicRoots = new Set([...Object.values(prog.rules), ...extraIps])
  const barrier = new Map<number, string>()
  for (const ip of fns.keys()) {
    if (publicRoots.has(ip) || externalRefs.has(ip)) barrier.set(ip, 'public')
    else if (recursive.has(ip)) barrier.set(ip, 'recursive')
    else if (prog.code[ip] === OP_ATTEMPT || prog.code[ip] === OP_SCAN) barrier.set(ip, 'effect')
    else if (hasInlineScopeHazard(fns.get(ip)!)) barrier.set(ip, 'scope')
    else if (!hasInlineSignature(fns.get(ip)!)) barrier.set(ip, 'shape')
    else if ((incoming.get(ip)?.length ?? 0) !== 1) barrier.set(ip, 'shared')
    else if (!incoming.get(ip)![0]!.transformable) barrier.set(ip, 'shape')
  }

  const roots = [...fns.keys()].filter(ip => barrier.has(ip))
  const owner = new Map<number, number>()
  const absorb = (ip: number, root: number): void => {
    if (owner.has(ip)) return
    owner.set(ip, root)
    for (const call of fns.get(ip)?.calls ?? []) {
      if (!fns.has(call.callee) || barrier.has(call.callee) || !call.transformable) continue
      absorb(call.callee, root)
    }
  }
  for (const root of roots) absorb(root, root)
  for (const ip of fns.keys()) if (!owner.has(ip)) { barrier.set(ip, 'shared'); absorb(ip, ip) }

  let serial = 0
  const src = (node: Ast): string => { const r = range(node); return source.slice(r.start, r.end) }
  const renderBody = (ip: number, embedded: { result: string; label: string } | undefined): string => {
    const fn = fns.get(ip)!
    const bodyRange = range(fn.body)
    const start = bodyRange.start + 1
    const end = bodyRange.end - 1
    const edits: Edit[] = []
    const callsByStatement = new Map<Ast, Call[]>()
    for (const call of fn.calls) {
      if (owner.get(call.callee) !== owner.get(ip) || barrier.has(call.callee) || !call.transformable) continue
      const list = callsByStatement.get(call.statement) ?? []
      list.push(call); callsByStatement.set(call.statement, list)
    }
    const returns: Ast[] = []
    const collectReturns = (node: Ast): void => {
      if (node !== fn.body && isFunction(node)) return
      if (node.type === 'ReturnStatement') returns.push(node)
      for (const child of children(node)) collectReturns(child)
    }
    if (embedded !== undefined) collectReturns(fn.body)

    const callPrefix = (call: Call): { prefix: string; value: string } => {
      const id = serial++
      const result = `_z${id}r`
      const label = `_z${id}`
      const at = `_z${id}p`
      const nested = renderBody(call.callee, { result, label })
      return {
        value: result,
        prefix: `let ${result},${at}=${src(call.args[1]!)}\n${label}:{let pos=${at}\n${nested}\n}\n`,
      }
    }

    for (const [statement, calls] of callsByStatement) {
      let prefix = ''
      const replacements: Edit[] = []
      for (const call of calls) {
        const made = callPrefix(call)
        prefix += made.prefix
        const cr = range(call.node)
        replacements.push({ start: cr.start, end: cr.end, text: made.value })
      }
      if (statement.type === 'ReturnStatement' && embedded !== undefined) {
        const sr = range(statement)
        const arg = ast(statement.argument)
        const value = arg === undefined ? 'undefined' : render(source, range(arg).start, range(arg).end, replacements)
        edits.push({ start: sr.start, end: sr.end, text: `{${prefix}${embedded.result}=${value};break ${embedded.label}}` })
      } else {
        const sr = range(statement)
        edits.push({ start: sr.start, end: sr.start, text: prefix })
        edits.push(...replacements)
      }
    }
    if (embedded !== undefined) {
      for (const statement of returns) {
        if (callsByStatement.has(statement)) continue
        const sr = range(statement)
        const arg = ast(statement.argument)
        edits.push({
          start: sr.start, end: sr.end,
          text: `{${embedded.result}=${arg === undefined ? 'undefined' : src(arg)};break ${embedded.label}}`,
        })
      }
    }
    return render(source, start, end, edits)
  }

  const regionSizes = new Map<number, number>()
  const regionProtocol = new Map<number, number>()
  for (const [ip, root] of owner) {
    const r = range(fns.get(ip)!.node)
    regionSizes.set(root, (regionSizes.get(root) ?? 0) + r.end - r.start)
    const op = prog.code[ip]
    const bits = (op === OP_NODE || op === OP_NODE_TRACK ? 1 : 0) | (op === OP_REPV ? 2 : 0)
    regionProtocol.set(root, (regionProtocol.get(root) ?? 0) | bits)
  }
  const oversized = new Set<number>()
  for (const [ip, size] of regionSizes) if (size > 180_000) oversized.add(ip)
  if (oversized.size > 0) {
    const counts = Object.fromEntries([...barrier.values()].map(k => [k, 0]))
    for (const kind of barrier.values()) counts[kind] = (counts[kind] ?? 0) + 1
    const before = { functionsBefore: fns.size, pieceCallsBefore, sourceBefore: source.length, barriers: counts }
    return fallback(emitted, 'a region exceeded the 180KB source cap', before)
  }

  const topEdits: Edit[] = []
  for (const [ip, fn] of fns) {
    if (owner.get(ip) === ip) {
      const br = range(fn.body)
      topEdits.push({ start: br.start + 1, end: br.end - 1, text: renderBody(ip, undefined) })
    } else {
      const fr = range(fn.node)
      topEdits.push({ start: fr.start, end: fr.end, text: '' })
    }
  }
  const candidate = render(source, 0, source.length, topEdits)
  const counts: Record<string, number> = {}
  for (const kind of barrier.values()) counts[kind] = (counts[kind] ?? 0) + 1
  const before = { functionsBefore: fns.size, pieceCallsBefore, sourceBefore: source.length, barriers: counts }
  if (candidate.length > Math.ceil(source.length * 1.05)) {
    return fallback(emitted, `candidate exceeded the 5% total source cap (${candidate.length} > ${Math.ceil(source.length * 1.05)})`, before)
  }
  const functionsAfter = roots.length
  const removed = fns.size - functionsAfter
  // Parse the RESULT, not merely the input. A range bug (notably a UTF-8 byte
  // offset mistaken for a JS UTF-16 index) or a malformed labelled exit must
  // fail closed before one byte is serialized. Then prove every remaining
  // piece identifier has a declaration: internal bodies are suppressed only
  // after this reachable-reference relink check.
  const checked = parseSync('parseman-entry-supercompile-result.js', WRAP + candidate + SUFFIX)
  if (checked.errors.length > 0) return fallback(emitted, 'structured candidate did not parse', before)
  const declared = new Set<string>()
  const referenced = new Set<string>()
  const checkRefs = (node: Ast, parent?: Ast): void => {
    if (node.type === 'FunctionDeclaration') {
      const name = nameOf(ast(node.id))
      if (name !== undefined && PIECE.test(name)) declared.add(name)
    }
    if (node.type === 'Identifier' && typeof node.name === 'string' && PIECE.test(node.name)) {
      const isDeclaration = parent?.type === 'FunctionDeclaration' && parent.id === node
      if (!isDeclaration) referenced.add(node.name)
    }
    for (const child of children(node)) checkRefs(child, node)
  }
  checkRefs(checked.program as unknown as Ast)
  if (declared.size !== functionsAfter || [...referenced].some(name => !declared.has(name))) {
    return fallback(emitted, 'deleted piece body remains reachable after structured relinking', before)
  }
  const largestRegion = [...regionSizes].sort((a, b) => b[1] - a[1])[0]
  const protocolRegions = {
    node: [...regionProtocol.values()].filter(bits => (bits & 1) !== 0).length,
    repv: [...regionProtocol.values()].filter(bits => (bits & 2) !== 0).length,
    nodeAndRepv: [...regionProtocol.values()].filter(bits => bits === 3).length,
  }
  return {
    ...emitted,
    source: candidate,
    supercompile: {
      ...before,
      activated: removed > 0,
      ...(removed > 0 ? {} : { reason: 'no uniquely-owned region bodies' }),
      functionsAfter,
      pieceCallsAfter: pieceCallsBefore - removed,
      sourceAfter: candidate.length,
      regions: roots.length,
      largestRegionSource: Math.max(0, ...regionSizes.values()),
      ...(largestRegion === undefined ? {} : { largestRegionIp: largestRegion[0] }),
      protocolRegions,
    },
  }
}
