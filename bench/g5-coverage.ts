/**
 * G5 deliverable 5 — what the prototype's opcode set does NOT yet cover.
 *
 * The projection to the other grammars is only worth anything if it is grounded
 * in which constructs are actually missing, so this walks every real grammar in
 * the repo through `encodeTable` and reports the first construct that has no
 * opcode. The list of tags it names IS the remaining work.
 */
import { encodeTable, UnsupportedConstruct } from '../src/table/encode.ts'
import { reachableOps } from '../src/table/inspect.ts'
import { OP_NAMES } from '../src/table/ops.ts'
import type { Combinator, ParserDef } from '../src/types.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'

/** Every construct tag reachable from a combinator, so the gap is a LIST, not a first failure. */
function tags(p: Combinator<unknown>, seen = new Set<Combinator<unknown>>(), out = new Map<string, number>()): Map<string, number> {
  if (p === undefined || p === null || p._def === undefined) return out
  if (seen.has(p)) return out
  seen.add(p)
  const d = p._def as ParserDef & Record<string, unknown>
  out.set(d.tag, (out.get(d.tag) ?? 0) + 1)
  for (const key of ['parser', 'separator', 'selector', 'otherwise', 'main', 'skipped', 'sentinel']) {
    const c = d[key]
    if (c !== undefined && c !== null && typeof c === 'object' && '_def' in (c as object)) tags(c as Combinator<unknown>, seen, out)
  }
  for (const key of ['parsers', 'skip']) {
    const list = d[key]
    if (Array.isArray(list)) for (const c of list) if (c && typeof c === 'object' && '_def' in c) tags(c as Combinator<unknown>, seen, out)
  }
  if (d.tag === 'lazy') {
    try { tags((d as unknown as { thunk: () => Combinator<unknown> }).thunk(), seen, out) } catch { /* unresolved ref */ }
  }
  return out
}

// Must mirror the `case` arms of `encodeDef` in src/table/encode.ts, plus the
// escape-hatch tags it routes to OP_CALL (scanTo, token, balanced). Drift here
// reports a construct as UNSUPPORTED that the encoder handles fine -- which is
// how `expect` and `keywords` came to be missing after they were implemented.
const SUPPORTED = new Set([
  // encodeDef case arms
  'literal', 'regex', 'sequence', 'choice', 'many', 'optional',
  'transform', 'leaf', 'node', 'lazy', 'not', 'peek',
  'attempt', 'label', 'trivia', 'grammar', 'expect', 'keywords',
  // routed to OP_CALL rather than lowered structurally
  'scanTo', 'token',
  // desugared before encodeDef sees them
  'oneOrMore', 'sepBy',
])

async function main(): Promise<void> {
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}`)
  console.log('')
  console.log('=== opcode coverage across every real grammar in the repo')

  const targets: Array<[string, () => Promise<Combinator<unknown>>]> = [
    ['examples/csv', async () => (await import('../examples/csv/parser.ts')).csvParser as Combinator<unknown>],
    ['examples/json', async () => (await import('../examples/json/parser.ts')).jsonDoc as unknown as Combinator<unknown>],
    ['examples/lang', async () => (await import('../examples/lang/parser.ts')).expr as unknown as Combinator<unknown>],
    ['examples/graphql', async () => (await import('../examples/graphql/parser.ts')).graphqlDoc as unknown as Combinator<unknown>],
    ['examples/css', async () => (await import('../examples/css/parser.ts')).Stylesheet as unknown as Combinator<unknown>],
    ['bench/workloads/less', async () => (await import('./workloads/less.ts')).Stylesheet as unknown as Combinator<unknown>],
  ]

  for (const [name, load] of targets) {
    let root: Combinator<unknown>
    try { root = await load() } catch (e) { console.log(`  ${name.padEnd(24)} SKIP (${(e as Error).message.split('\n')[0]})`); continue }
    const t = tags(root)
    const missing = [...t.entries()].filter(([tag]) => !SUPPORTED.has(tag)).sort((a, b) => b[1] - a[1])
    let encoded = ''
    try {
      const prog = encodeTable({ Root: root })
      const ops = reachableOps(prog)
      encoded = `ENCODES — ${prog.code.length} words, ${[...ops.entries()].map(([o, n]) => `${OP_NAMES[o]}:${n}`).join(' ')}`
    } catch (e) {
      encoded = e instanceof UnsupportedConstruct ? `blocked on '${e.tag}'` : `error: ${(e as Error).message.split('\n')[0]}`
    }
    console.log(`  ${name.padEnd(24)} ${encoded}`)
    if (missing.length > 0) {
      console.log(`      missing opcodes: ${missing.map(([tag, n]) => `${tag}(${n})`).join(' ')}`)
    }
  }
}

void main()
