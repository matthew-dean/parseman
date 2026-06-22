import regexpTree from 'regexp-tree'
import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { any, fromRange, union, empty } from './first-set.ts'

function firstSetFromRegex(pattern: string): { firstSet: FirstSet; canMatchNewline: boolean } {
  try {
    const ast = regexpTree.parse(`/${pattern}/`)
    return extractFirstSet(ast.body as unknown as RegexNode)
  } catch {
    return { firstSet: any(), canMatchNewline: true }
  }
}

type RegexNode = {
  type: string
  [key: string]: unknown
}

function canBeEmpty(node: RegexNode | null | undefined): boolean {
  if (!node) return true
  switch (node.type) {
    case 'Repetition': {
      const q = node.quantifier as { kind: string; from?: number }
      return q.kind === '*' || q.kind === '?' || (q.kind === 'Range' && (q.from ?? 1) === 0)
    }
    case 'Alternative': {
      const exprs = node.expressions as RegexNode[]
      return !exprs || exprs.length === 0 || exprs.every(e => canBeEmpty(e))
    }
    case 'Group': return canBeEmpty(node.expression as RegexNode)
    case 'Disjunction': return canBeEmpty(node.left as RegexNode) || canBeEmpty(node.right as RegexNode)
    default: return false
  }
}

function extractFirstSet(node: RegexNode | null | undefined): { firstSet: FirstSet; canMatchNewline: boolean } {
  if (!node) return { firstSet: empty(), canMatchNewline: false }

  switch (node.type) {
    case 'Disjunction': {
      const left = extractFirstSet(node.left as RegexNode)
      const right = extractFirstSet(node.right as RegexNode)
      return {
        firstSet: union(left.firstSet, right.firstSet),
        canMatchNewline: left.canMatchNewline || right.canMatchNewline,
      }
    }
    case 'Alternative': {
      const exprs = node.expressions as RegexNode[]
      if (!exprs || exprs.length === 0) return { firstSet: empty(), canMatchNewline: false }
      // Walk forward through expressions that can match empty, unioning their first-sets.
      // This handles patterns like -?[0-9]+ where the first expr is optional.
      let fs: FirstSet = empty()
      let canNL = false
      for (const expr of exprs) {
        const r = extractFirstSet(expr)
        fs = union(fs, r.firstSet)
        canNL = canNL || r.canMatchNewline
        if (!canBeEmpty(expr)) break
      }
      return { firstSet: fs, canMatchNewline: canNL }
    }
    case 'Char': {
      const kind = node.kind as string
      if (kind === 'simple') {
        const code = (node.codePoint as number | undefined) ?? (node.value as string).codePointAt(0) ?? 0
        return { firstSet: fromRange(code, code), canMatchNewline: code === 0x0a }
      }
      if (kind === 'meta') {
        const val = node.value as string
        if (val === '.') return { firstSet: any(), canMatchNewline: false }
        if (val === 'd') return { firstSet: fromRange(0x30, 0x39), canMatchNewline: false }
        if (val === 'D') return { firstSet: any(), canMatchNewline: true }
        if (val === 'w') return {
          firstSet: union(union(fromRange(0x30, 0x39), fromRange(0x41, 0x5a)),
            union(fromRange(0x61, 0x7a), fromRange(0x5f, 0x5f))),
          canMatchNewline: false,
        }
        if (val === 's') return { firstSet: fromRange(0x09, 0x0d), canMatchNewline: true }
        if (val === 'n') return { firstSet: fromRange(0x0a, 0x0a), canMatchNewline: true }
      }
      return { firstSet: any(), canMatchNewline: true }
    }
    case 'CharacterClass': {
      const expressions = node.expressions as RegexNode[]
      let fs: FirstSet = empty()
      let canNL = false
      for (const expr of expressions) {
        if (expr.type === 'ClassRange') {
          const from = (expr.from as RegexNode).codePoint as number
          const to = (expr.to as RegexNode).codePoint as number
          fs = union(fs, fromRange(from, to))
          if (from <= 0x0a && 0x0a <= to) canNL = true
        } else if (expr.type === 'Char') {
          const r = extractFirstSet(expr)
          fs = union(fs, r.firstSet)
          canNL = canNL || r.canMatchNewline
        }
      }
      if (node.negative) return { firstSet: any(), canMatchNewline: true }
      return { firstSet: fs, canMatchNewline: canNL }
    }
    case 'Repetition': {
      return extractFirstSet(node.expression as RegexNode)
    }
    case 'Group': {
      return extractFirstSet(node.expression as RegexNode)
    }
    default:
      return { firstSet: any(), canMatchNewline: true }
  }
}

function optimizeRegex(source: string, flags: string): string {
  try {
    const result = regexpTree.optimize(`/${source}/${flags}`)
    const str = result.toString()
    const lastSlash = str.lastIndexOf('/')
    return str.slice(1, lastSlash)
  } catch {
    return source
  }
}

export function regex(pattern: string | RegExp, flags = ''): Combinator<string> {
  const source = typeof pattern === 'string' ? pattern : pattern.source
  const resolvedFlags = typeof pattern === 'string' ? flags : pattern.flags

  const optimizedSource = optimizeRegex(source, resolvedFlags)
  const anchored = new RegExp(optimizedSource, 'y' + resolvedFlags.replace(/[gy]/g, ''))

  const { firstSet, canMatchNewline } = firstSetFromRegex(source)
  const meta: ParserMeta = { firstSet, canMatchNewline, isTrivia: false }

  return {
    _tag: 'regex',
    _meta: meta,
    _def: { tag: 'regex', source, flags: resolvedFlags, optimizedSource },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      anchored.lastIndex = pos
      const m = anchored.exec(input)
      if (m === null) {
        return { ok: false, expected: [`/${source}/`], span: { start: pos, end: pos } }
      }
      const span = { start: pos, end: pos + m[0]!.length }
      const leaf = { _tag: 'leaf', value: m[0]!, span }
      if (ctx._cstLeaves) (ctx._cstLeaves as typeof leaf[]).push(leaf)
      if (ctx._cstRawChildren) (ctx._cstRawChildren as typeof leaf[]).push(leaf)
      return { ok: true, value: m[0]!, span }
    },
  }
}
