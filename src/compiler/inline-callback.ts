const INLINE_BUILTINS = new Set([
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Math', 'JSON',
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Source text for a transform callback — macro `fnSrc` or arrow `toString()`. */
export function transformFnSource(fn: Function, fnSrc?: string | null): string | null {
  if (fnSrc) return fnSrc.trim()
  const s = fn.toString().trim()
  if (s.includes('[native code]')) return null
  return s
}

function replaceParam(body: string, param: string, valueVar: string): string {
  return body.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, 'g'), valueVar)
}

function stripForIdCheck(body: string): string {
  return body
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/\bas\s+const\b/g, '')
    .replace(/\b[A-Za-z_$][\w$]*\s*:/g, ':')
}

function hasFreeIdentifiers(body: string, allowed: ReadonlySet<string>): boolean {
  const stripped = stripForIdCheck(body)
  const ids = stripped.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []
  for (const id of ids) {
    if (INLINE_BUILTINS.has(id)) continue
    if (allowed.has(id)) continue
    return true
  }
  return false
}

/** `s => expr` / `() => expr` when expr only uses the param (+ builtins). */
export function tryInlineUnaryTransform(src: string, valueVar: string): string | null {
  const allowed = new Set([valueVar])
  const nullary = src.match(/^\(\s*\)\s*=>\s*(.+)$/)
  if (nullary) {
    const body = nullary[1]!.trim()
    return hasFreeIdentifiers(body, allowed) ? null : body
  }
  const m = src.match(/^(\w+)\s*=>\s*(.+)$/)
  if (!m) return null
  const body = replaceParam(m[2]!.trim(), m[1]!, valueVar)
  return hasFreeIdentifiers(body, allowed) ? null : body
}

/** Parse `[a, , c]` destructuring slots (null = ignore). */
export function parseArrayDestructure(pattern: string, arity: number): (string | null)[] {
  const slots: (string | null)[] = []
  for (const part of pattern.split(',')) {
    const name = part.trim()
    slots.push(name === '' || name === '_' ? null : name)
  }
  while (slots.length < arity) slots.push(null)
  return slots.slice(0, arity)
}

/**
 * `([x, y]) => body` — substitute destructure names with sequence value vars.
 * Caller must ensure body only references slotted params (+ builtins).
 */
export function tryInlineDestructureTransform(
  src: string,
  valueVars: string[],
): string | null {
  const m = src.match(/^\(\s*\[([^\]]*)\]\s*\)\s*=>\s*(.+)$/s)
  if (!m) return null
  const slots = parseArrayDestructure(m[1]!, valueVars.length)
  let body = m[2]!.trim()
  const allowed = new Set(valueVars)
  for (let i = 0; i < slots.length; i++) {
    const name = slots[i]
    if (name) body = replaceParam(body, name, valueVars[i]!)
  }
  return hasFreeIdentifiers(body, allowed) ? null : body
}
