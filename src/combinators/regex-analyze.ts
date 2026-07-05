/**
 * First-set analysis for `regex()` terminals, backed by `regexp-tree`.
 *
 * This is the SOLE runtime importer of `regexp-tree` (a ~264 KB compile-time
 * regex-analysis library). It is deliberately isolated behind the
 * `RegexFirstSetAnalyzer` injection seam in `regex.ts`: only `index.ts` (the
 * interpreter/library entry) imports and registers it, so a consumer who ships
 * only compiled grammars — or imports `regex` from the combinator subpath
 * without the full entry — never pulls this module (or `regexp-tree`) into
 * their bundle. `regex()` falls back to a permissive `any()` first-set when no
 * analyzer is registered, which only disables choice-dispatch fast paths (never
 * changes what matches).
 *
 * To eventually drop `regexp-tree` for interpreter users too, replace the
 * `regexpTree.parse` call below with a hand-rolled first-set parser producing
 * the same AST shape `extractFirstSet` consumes — nothing else needs to change,
 * and `regexp-tree` can then become a dev-only differential-test oracle.
 */
import regexpTree from 'regexp-tree'
import type { FirstSet } from '../types.ts'
import { any, fromRange, union, empty } from './first-set.ts'

export function firstSetFromRegex(pattern: string): { firstSet: FirstSet; canMatchNewline: boolean } {
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
