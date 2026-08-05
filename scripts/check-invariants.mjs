#!/usr/bin/env node
/**
 * INVARIANT GATE — mechanical checks for the defect classes this repo has
 * already paid for, so that a written rule can stop a commit instead of only
 * describing one.
 *
 * Every check here is SOURCE-DECIDABLE: it parses `src/**` with oxc (already a
 * runtime dependency) and decides on the AST. Nothing here times anything,
 * nothing here samples, and nothing here guesses. A check that could not be made
 * to decide without a heuristic was left OUT rather than shipped noisy — see
 * docs/design/invariant-gate.md for the ones that were rejected and why. That is
 * the same argument docs/design/release-gates.md makes about the changelog gate:
 * a gate that fires on a comment typo gets bypassed, and then the gates that
 * matter get bypassed with it.
 *
 * The rules:
 *   INV-1  no accessor descriptor installed with Object.defineProperty
 *   INV-2  no field in a public `*Options` type that nothing reads
 *   INV-3  every module under src/ is reachable from a published entry point
 *   INV-4  no declaration body duplicated across modules
 *   INV-5  no `delete` on an object the enclosing function did not construct
 *
 * Usage:
 *   node scripts/check-invariants.mjs            # gate — exits 1 on any new finding
 *   node scripts/check-invariants.mjs --list     # print every finding, exit 0
 *   node scripts/check-invariants.mjs --json     # machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * `--root=<dir>` points the whole gate at another tree that has a
 * `package.json` and a `src/`. That is how test/unit/invariant-gate.test.ts
 * proves each rule FIRES: it runs this exact script, the way CI runs it,
 * against fixture trees that contain one planted violation each. A gate that
 * has never been observed failing is not known to work.
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : REPO
const SRC = join(ROOT, 'src')
/** The allowlist describes THIS repo; a fixture tree gets none. `--assert-allowlist`
 *  forces it back on, which is how the stale-entry failure is exercised. */
const USE_ALLOW = !rootArg || process.argv.includes('--assert-allowlist')

/* ------------------------------------------------------------------ *
 * ALLOWLIST — loaded from scripts/invariant-allowlist.mjs, which carries the
 * entries, their categories, and the committed count. It is a separate module
 * for two reasons: the count is a single reviewable line rather than a fact
 * buried in a list, and a fixture tree can supply its OWN allowlist so that the
 * checks below can be observed FAILING (test/unit/invariant-gate.test.ts).
 *
 * Three things are enforced here, none of which were before:
 *
 *   RATCHET    `ALLOW.size` must equal the committed `ALLOW_COUNT` exactly.
 *              "THIS LIST MAY ONLY GET SHORTER" was a sentence in a comment;
 *              this is the sentence with teeth. Adding an entry now costs a
 *              deliberate edit to a numbered line that shows up in review on
 *              its own, instead of one more line hiding among sixteen.
 *              It is a ratchet, not a wall: a real architectural change that
 *              retires modules from the export graph raises the count in the
 *              same commit and the gate goes green (proven in the test file).
 *              A ratchet that cannot be raised is a hard block, and a hard
 *              block gets bypassed, taking the rules that matter with it.
 *   STRUCTURE  Every entry declares a category — RULE-BUG / BY-DESIGN / DEBT —
 *              and DEBT declares a tracking ref. An entry with neither owner
 *              nor expiry is a silent, permanent decision to not do the work.
 *   STALENESS  An entry whose finding no longer exists fails the gate, so an
 *              exemption cannot outlive the violation it names. (Pre-existing;
 *              reported alongside the two above.)
 *
 * BY-DESIGN VS DEBT IS THE WHOLE POINT — READ THIS BEFORE ADDING AN ENTRY.
 * The two look identical on the day they are written and could not be more
 * different a year later.
 *
 *   BY-DESIGN  is a finished argument. The code is staying in this shape. The
 *              entry leaves only if the design changes — `src/table/
 *              exec-baseline.ts` is unimported BECAUSE it is a frozen control,
 *              and reference code deliberately retired from the product path
 *              while the measurement harness still reaches it is the same
 *              shape.
 *   DEBT       is an unfinished obligation. Something is owed, and the `ref`
 *              names who owes it.
 *
 * `INV-3 token-alphabet.ts` / `token-scanner.ts` is why this is enforced rather
 * than trusted. The rule CORRECTLY caught built-but-never-wired analysis — the
 * sixth instance of that shape in this project — and the entry stated a real
 * obligation, "wire into the compiler or delete". Nothing enforced the
 * obligation and nothing ever restated it, so over time it read exactly like
 * the frozen-control entries above it: a permanent, accepted exemption. Debt
 * decays into by-design by neglect, never the other way round. Naming the
 * category and PRINTING the DEBT list on every run, pass or fail, is what stops
 * that: debt that is never restated is debt that is never paid.
 * ------------------------------------------------------------------ */
const ALLOW_MODULE = 'scripts/invariant-allowlist.mjs'
/** A fixture tree with its own allowlist uses it; otherwise `--assert-allowlist`
 *  means "run THIS repo's allowlist against that tree", which is how the
 *  stale-entry failure is exercised. */
const allowRoot = !USE_ALLOW ? null : existsSync(join(ROOT, ALLOW_MODULE)) ? ROOT : REPO
const allowMod = allowRoot ? await import(pathToFileURL(join(allowRoot, ALLOW_MODULE)).href) : null
/** @type {Map<string, { category: string, why: string, ref?: string }>} */
const ALLOW = allowMod?.ALLOW ?? new Map()
const CATEGORIES = allowMod?.CATEGORIES ?? []

if (allowMod) {
  /** @type {string[]} */
  const bad = []
  for (const [key, entry] of ALLOW) {
    if (!entry || typeof entry !== 'object') { bad.push(`${key} — entry is not an object { category, why, ref? }`); continue }
    if (!CATEGORIES.includes(entry.category)) bad.push(`${key} — category must be one of ${CATEGORIES.join(' / ')}, got ${JSON.stringify(entry.category)}`)
    if (typeof entry.why !== 'string' || !entry.why.trim()) bad.push(`${key} — \`why\` must be a non-empty string`)
    if (entry.category === 'DEBT' && (typeof entry.ref !== 'string' || !entry.ref.trim())) bad.push(`${key} — DEBT requires a \`ref\`: name the lane, doc, or issue that owns the fix`)
  }
  if (bad.length) {
    console.error(`invariant gate: malformed allowlist entr${bad.length === 1 ? 'y' : 'ies'} in ${ALLOW_MODULE}.`)
    console.error('Every entry needs a category (RULE-BUG / BY-DESIGN / DEBT) and a reason; DEBT needs a tracking ref.\n  ' + bad.join('\n  '))
    process.exit(1)
  }
  if (ALLOW.size !== allowMod.ALLOW_COUNT) {
    const verb = ALLOW.size > allowMod.ALLOW_COUNT ? 'GREW' : 'shrank'
    console.error(`invariant gate: the allowlist ${verb} — ${ALLOW.size} entries against a committed ALLOW_COUNT of ${allowMod.ALLOW_COUNT}.`)
    console.error(ALLOW.size > allowMod.ALLOW_COUNT
      ? `The list may only get SHORTER. Fix the code, or argue the invariant is wrong. If the entry is genuinely\nunavoidable, raise ALLOW_COUNT to ${ALLOW.size} in ${ALLOW_MODULE} in the same commit — that edit is the review.`
      : `Lower ALLOW_COUNT to ${ALLOW.size} in ${ALLOW_MODULE}. Leaving it high is slack a later commit spends for free.`)
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ */

/** @returns {string[]} every non-declaration .ts file under src/, repo-relative */
function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(ROOT, p))
  }
  return out
}

/** Depth-first walk of an oxc/ESTree program. `visit` sees every node with a `type`. */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (typeof node.type === 'string') visit(node)
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    walk(node[key], visit)
  }
}

/**
 * Walk carrying the nearest enclosing named function/variable, so a finding's
 * KEY can be `file:enclosingName` instead of `file:line`. A line-numbered key
 * goes stale the moment anything above it moves, which would turn the
 * allowlist into a source of red on unrelated edits — the precise thing that
 * gets a gate switched off.
 */
function walkScoped(node, visit, scope = '<module>') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walkScoped(n, visit, scope); return }
  if (typeof node.type === 'string') {
    visit(node, scope)
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') scope = node.id?.name ?? scope
    else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name
    else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') scope = keyName(node) ?? scope
  }
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    walkScoped(node[key], visit, scope)
  }
}

const isId = (n, name) => n && n.type === 'Identifier' && n.name === name

/** oxc keeps `(…)` and TS assertion wrappers in the tree; look through them. */
function unwrap(n) {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression'
    || n.type === 'TSNonNullExpression' || n.type === 'TSSatisfiesExpression')) n = n.expression
  return n
}

/** Property key as a plain string, or null when computed/unknowable. */
function keyName(p) {
  if (!p || p.computed) return null
  const k = p.key
  if (!k) return null
  if (k.type === 'Identifier') return k.name
  if (k.type === 'Literal' && typeof k.value === 'string') return k.value
  return null
}

/* ================================================================== *
 * Load and parse everything once.
 * ================================================================== */
const files = sources()
/** @type {Map<string, { code: string, ast: any, comments: any[], lineAt: (i: number) => number }>} */
const parsed = new Map()
for (const f of files) {
  const code = readFileSync(join(ROOT, f), 'utf8')
  const r = parseSync(f, code, { lang: 'ts' })
  // Precompute line starts once per file (invariant 10 in jess's V8-ARCHITECTURE:
  // a source-derived fact has one owner and one construction point).
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
  const lineAt = (idx) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
  parsed.set(f, { code, ast: r.program, comments: r.comments ?? [], lineAt })
}

/** @type {{ rule: string, key: string, file: string, line: number, message: string }[]} */
const findings = []
const report = (rule, file, line, message, key) =>
  findings.push({ rule, key: key ?? `${rule}:${file}:${line}`, file, line, message })

/* ================================================================== *
 * INV-1 — no accessor descriptor installed with Object.defineProperty.
 *
 * DECIDES: a `get`/`set` in an `Object.defineProperty` / `defineProperties`
 * descriptor. That installs an ACCESSOR onto an object that already exists,
 * which transitions its hidden class and makes every subsequent read of the
 * object go through a call instead of an inline cache slot.
 *
 * WHY THIS EXACT SHAPE: the 0.44.0 migration aid put throwing accessors on
 * every `run()` result and cost a measured 36.9% on small parses. jess has the
 * same class recorded at 46% of CSS parse time. It is the cheapest defect in
 * the catalogue to detect and the most expensive to ship.
 *
 * NOT BANNED: `get x() {}` in an object LITERAL. That is part of the object's
 * shape from birth — it does not transition anything — and this repo uses it
 * deliberately for lazy materialization (src/functional/doc.ts, src/cst/
 * trivia-entries.ts). Banning it would be the false positive that gets the
 * whole gate turned off.
 * ================================================================== */
for (const [file, { ast, lineAt }] of parsed) {
  walkScoped(ast, (n, scope) => {
    if (n.type !== 'CallExpression') return
    const c = n.callee
    if (!c || c.type !== 'StaticMemberExpression' && c.type !== 'MemberExpression') return
    if (!isId(c.object, 'Object') || c.computed) return
    const which = c.property?.name
    if (which !== 'defineProperty' && which !== 'defineProperties') return
    // defineProperty(o, k, DESC) | defineProperties(o, { k: DESC, … })
    const descs = which === 'defineProperty'
      ? [n.arguments?.[2]]
      : (n.arguments?.[1]?.type === 'ObjectExpression'
        ? n.arguments[1].properties.filter((p) => p.type === 'Property').map((p) => p.value)
        : [])
    for (const d of descs) {
      if (!d || d.type !== 'ObjectExpression') continue
      for (const p of d.properties) {
        if (p.type !== 'Property') continue
        const k = keyName(p)
        if (k === 'get' || k === 'set') {
          report('INV-1', file, lineAt(p.start),
            `accessor descriptor (\`${k}\`) installed via Object.${which} in \`${scope}\` — transitions the hidden class of an object that already exists; use a literal getter at the construction site, or a plain data property`,
            `INV-1:${file}:${scope}`)
        }
      }
    }
  })
}

/* ================================================================== *
 * INV-2 — no field declared in a public `*Options` type that nothing reads.
 *
 * DECIDES: a property name declared in an EXPORTED type/interface whose name
 * ends in `Options`, where that name appears nowhere in `src/**` as a member
 * access, a destructuring key, or a string literal.
 *
 * WHY: `dispatch()` shipped a flag that was set and never read, so the cut did
 * not fire and the parser accepted input both other engines rejected — a
 * silently truncated document, with every test green. A declared-and-unread
 * option is that bug in its general form, and it is exactly the thing a type
 * system CANNOT catch: the type is satisfied by writing the field.
 *
 * FALSE-POSITIVE FLOOR: the read set is deliberately over-broad — ANY `.name`
 * anywhere in src counts, including on unrelated objects, and so does any
 * occurrence of the bare name as a string. That under-reports (a field read
 * only through a same-named property of something else escapes) and it is the
 * right direction: this check fires only when the name occurs NOWHERE in the
 * implementation, which no reader can call a false alarm.
 * ================================================================== */
{
  /** every identifier this codebase could possibly be reading a field by */
  const readNames = new Set()
  for (const [, { ast }] of parsed) {
    walk(ast, (n) => {
      if ((n.type === 'MemberExpression' || n.type === 'StaticMemberExpression') && !n.computed && n.property?.type === 'Identifier') readNames.add(n.property.name)
      if (n.type === 'ObjectPattern') for (const p of n.properties) { const k = keyName(p); if (k) readNames.add(k) }
      if (n.type === 'Literal' && typeof n.value === 'string') readNames.add(n.value)
      if (n.type === 'TemplateElement' && n.value?.raw) for (const w of n.value.raw.split(/[^A-Za-z0-9_$]+/)) readNames.add(w)
    })
  }
  for (const [file, { ast, lineAt }] of parsed) {
    walk(ast, (n) => {
      const isExported = n.type === 'ExportNamedDeclaration' && n.declaration
      if (!isExported) return
      const d = n.declaration
      let name = null, members = null
      if (d.type === 'TSInterfaceDeclaration') { name = d.id?.name; members = d.body?.body }
      else if (d.type === 'TSTypeAliasDeclaration') {
        name = d.id?.name
        const t = d.typeAnnotation
        // `X & { … }` is the common spelling here (`RenderTarget & { … }`), so
        // take the literal members of every literal arm. A `Pick<…>` / mapped
        // arm declares no members of its own and contributes nothing — the
        // fields it selects are checked where they are DECLARED.
        if (t?.type === 'TSTypeLiteral') members = t.members
        else if (t?.type === 'TSIntersectionType') members = t.types.flatMap((a) => a.type === 'TSTypeLiteral' ? a.members : [])
      }
      if (!name || !name.endsWith('Options') || !members || !members.length) return
      for (const m of members) {
        if (m.type !== 'TSPropertySignature') continue
        const k = keyName(m)
        if (!k) continue
        if (!readNames.has(k)) {
          report('INV-2', file, lineAt(m.start),
            `\`${name}.${k}\` is declared in a public options type and is never read anywhere in src/ — a caller can set it and nothing happens`,
            `INV-2:${name}.${k}`)
        }
      }
    })
  }
}

/* ================================================================== *
 * INV-5 — no `delete` on an object the enclosing function did not construct.
 *
 * DECIDES: a `delete X.p` / `delete X[e]` whose ROOT identifier is not bound,
 * anywhere inside the enclosing function, by a declaration whose initializer
 * is a fresh object (`{…}`, `[…]`, `new …`, `Object.create(…)`). Parameters,
 * closure variables, and aliases of somebody else's object (`const m = x._meta`)
 * all fail that test; a scratch object built and discarded in the same call
 * passes it.
 *
 * WHY THIS EXACT SHAPE: one `delete` flips `%HasFastProperties` to false on an
 * object of this shape, and RE-ADDING THE PROPERTY DOES NOT RESTORE IT. That is
 * survivable on a scratch object that dies at the end of the call. It is a
 * catastrophe on a long-lived one: `delete ctx._triviaLog` runs per token and
 * per leaf on `ctx`, the single object every combinator reads on every step, so
 * the FIRST `token()` in a parse can put it in dictionary mode for the
 * remainder. Same class as INV-1, and the reason this rule is separate from a
 * blanket "no delete" is that a blanket ban would fire on the scratch case,
 * which is fine and common — and a rule that fires on fine code gets switched
 * off, taking the rules that matter with it.
 *
 * NOT A CLAIM THAT THE CODE IS WRONG. The `ctx` deletes are not gratuitous:
 * restoration there is by PRESENCE — readers test whether the property exists —
 * so `delete` is the semantically correct expression of "restore to absent" and
 * `= undefined` is not a drop-in. This is correct code with a catastrophic
 * shape consequence, which is precisely the kind a test suite cannot see.
 *
 * FALSE-POSITIVE FLOOR: the "constructed here" test is deliberately generous —
 * it searches the WHOLE enclosing function subtree, nested functions included,
 * so a locally-built object exempts the delete even when the binding is not in
 * the immediately enclosing block. That under-reports, which is the right
 * direction. Every one of the 17 findings on this tree is a genuinely
 * long-lived object; none is a scratch local.
 * ================================================================== */
for (const [file, { ast, lineAt }] of parsed) {
  /** The nearest enclosing function node, so "did THIS call build it?" is answerable. */
  const fnStack = []
  const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
    || n.type === 'ArrowFunctionExpression'

  /** Names bound in `node`'s subtree to a FRESHLY CONSTRUCTED value. */
  const constructedIn = (fn) => {
    const names = new Set()
    walk(fn, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier') return
      const init = unwrap(n.init)
      if (!init) return
      if (init.type === 'ObjectExpression' || init.type === 'ArrayExpression'
        || init.type === 'NewExpression'
        || (init.type === 'CallExpression' && init.callee?.property?.name === 'create')) names.add(n.id.name)
    })
    return names
  }
  const cache = new Map()

  const visit = (node, scope) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) visit(n, scope); return }
    if (typeof node.type === 'string') {
      if (isFn(node)) fnStack.push(node)
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') scope = node.id?.name ?? scope
      else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
        && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name
      else if (node.type === 'Property' && (node.value?.type === 'FunctionExpression' || node.value?.type === 'ArrowFunctionExpression')) scope = keyName(node) ?? scope
      else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') scope = keyName(node) ?? scope

      if (node.type === 'UnaryExpression' && node.operator === 'delete') {
        let base = unwrap(node.argument)
        let prop = null
        while (base && base.type.endsWith('MemberExpression')) {
          if (prop === null) prop = base.computed ? '<computed>' : base.property?.name ?? '<computed>'
          base = unwrap(base.object)
        }
        if (base && base.type === 'Identifier') {
          let built = false
          for (const fn of fnStack) {
            if (!cache.has(fn)) cache.set(fn, constructedIn(fn))
            if (cache.get(fn).has(base.name)) { built = true; break }
          }
          if (!built) {
            report('INV-5', file, lineAt(node.start),
              `\`delete ${base.name}.${prop}\` in \`${scope}\` — \`${base.name}\` is not constructed by this function, so the delete lands on a LONG-LIVED object. One delete flips %HasFastProperties to false and re-adding the property does not restore it; every later read of that object goes through the dictionary`,
              `INV-5:${file}:${scope}:${base.name}.${prop}`)
          }
        }
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
      visit(node[key], scope)
    }
    if (typeof node.type === 'string' && isFn(node)) fnStack.pop()
  }
  visit(ast, '<module>')
}

/* ================================================================== *
 * INV-3 — every module under src/ is reachable from a published entry point.
 *
 * DECIDES: import-graph reachability from the targets of package.json
 * `exports` and `bin` (mapped dist/*.js -> src/*.ts). Static imports,
 * re-exports, `export *`, and `import()` with a literal specifier all count as
 * edges; a type-only import counts too.
 *
 * WHY: 87 KB of lowering analysis sat in the tree, never imported by the code
 * that needed it. An unreachable module is not merely dead weight in the
 * artifact — it is a piece of reasoning the shipped code is NOT doing, while
 * looking from the outside as though it does.
 *
 * FALSE-POSITIVE FLOOR: zero heuristics. If a module is genuinely bench-only,
 * it goes in ALLOW with a reason (two are there today).
 * ================================================================== */
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const distToSrc = (p) => relative(ROOT, join(ROOT, String(p).replace(/^\.\/dist\//, 'src/').replace(/\.c?js$/, '.ts')))
  const roots = []
  for (const e of Object.values(pkg.exports ?? {})) if (e?.import) roots.push(distToSrc(e.import))
  for (const b of Object.values(typeof pkg.bin === 'string' ? { _: pkg.bin } : pkg.bin ?? {})) roots.push(distToSrc(b))

  /** @type {Map<string, string[]>} */
  const edges = new Map()
  for (const [file, { ast }] of parsed) {
    const out = []
    const add = (spec) => {
      if (typeof spec !== 'string' || !spec.startsWith('.')) return
      const target = relative(ROOT, resolve(ROOT, dirname(file), spec))
      if (parsed.has(target)) out.push(target)
      else if (parsed.has(target.replace(/\.js$/, '.ts'))) out.push(target.replace(/\.js$/, '.ts'))
      else if (parsed.has(join(target, 'index.ts'))) out.push(join(target, 'index.ts'))
    }
    walk(ast, (n) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') add(n.source?.value)
      if (n.type === 'ImportExpression') add(n.source?.value)
    })
    edges.set(file, out)
  }
  const seen = new Set()
  const stack = roots.filter((r) => parsed.has(r))
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const t of edges.get(f) ?? []) stack.push(t)
  }
  for (const f of files) {
    if (seen.has(f)) continue
    report('INV-3', f, 1,
      'module is not reachable by import from any published entry point (package.json exports/bin) — it is analysis the shipped code does not run',
      `INV-3:${f}`)
  }
}

/* ================================================================== *
 * INV-4 — no constant table or function body duplicated across modules.
 *
 * DECIDES: two top-level declarations in DIFFERENT files whose initializer or
 * body is byte-identical after comments and whitespace are removed, and whose
 * normalized form is at least MIN_DUP_CHARS long.
 *
 * WHY: three copies of one ASCII fold shipped, ONE OF THEM WRONG; two copies
 * of `packInts`, one unbounded; a decoder left duplicated after its encoder
 * was deduplicated. A copy that drifts is worse than no copy, and the drift is
 * invisible to every behavioural test because each copy has its own callers.
 *
 * FALSE-POSITIVE FLOOR: byte-identity after comment/whitespace removal, so
 * there is no similarity threshold to argue about. The length floor exists
 * only to stop matching one-liners that are identical by coincidence
 * (`return x.length`); it is set high enough that a hit is a real table or a
 * real algorithm, never an idiom.
 * ================================================================== */
const MIN_DUP_CHARS = 160
{
  /** @type {Map<string, { file: string, line: number, name: string }[]>} */
  const byHash = new Map()
  for (const [file, { code, ast, comments, lineAt }] of parsed) {
    // Blank every comment once, so the normalized slice below is comment-free
    // without re-scanning the source per declaration.
    const blanked = code.split('')
    for (const c of comments) for (let i = c.start; i < c.end && i < blanked.length; i++) blanked[i] = ' '
    const clean = blanked.join('')
    const norm = (a, b) => clean.slice(a, b).replace(/\s+/g, '')

    const record = (node, name, start, end) => {
      const s = norm(start, end)
      if (s.length < MIN_DUP_CHARS) return
      if (!byHash.has(s)) byHash.set(s, [])
      byHash.get(s).push({ file, line: lineAt(start), name })
    }
    for (const stmt of ast.body ?? []) {
      const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
      if (!d) continue
      if (d.type === 'FunctionDeclaration' && d.body) record(d, d.id?.name ?? '<anon>', d.body.start, d.body.end)
      else if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) {
          if (!v.init || v.id?.type !== 'Identifier') continue
          const init = unwrap(v.init)
          const body = unwrap((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') ? init.body : init)
          record(v, v.id.name, body.start, body.end)
        }
      }
    }
  }
  for (const [, sites] of byHash) {
    const distinct = [...new Set(sites.map((s) => s.file))]
    if (distinct.length < 2) continue
    const where = sites.map((s) => `${s.file}:${s.line} \`${s.name}\``).join(' , ')
    const first = sites[0]
    report('INV-4', first.file, first.line,
      `identical declaration body duplicated across modules — ${where}. Import one; a copy that drifts is worse than no copy`,
      `INV-4:${sites.map((s) => `${s.file}:${s.name}`).sort().join('|')}`)
  }
}

/* ================================================================== *
 * Report.
 * ================================================================== */
const listOnly = process.argv.includes('--list')
const asJson = process.argv.includes('--json')
findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)

const isAllowed = (f) => USE_ALLOW && ALLOW.has(f.key)
const allowed = findings.filter(isAllowed)
const live = findings.filter((f) => !isAllowed(f))
const staleAllow = USE_ALLOW ? [...ALLOW.keys()].filter((k) => !findings.some((f) => f.key === k)) : []

/** Every DEBT entry, restated on every run. Debt nobody says out loud is debt
 *  nobody pays: these are the entries that carry a promise to do work, and the
 *  gate going green is the only moment anyone is reliably looking at it. */
const debt = [...ALLOW].filter(([, e]) => e.category === 'DEBT')

if (asJson) {
  console.log(JSON.stringify({
    live,
    allowed: allowed.map((f) => f.key),
    staleAllow,
    allowCount: ALLOW.size,
    debt: debt.map(([key, e]) => ({ key, why: e.why, ref: e.ref })),
  }, null, 2))
} else {
  for (const f of live) console.log(`${f.rule}  ${f.file}:${f.line}\n    ${f.message}\n`)
  if (allowed.length) {
    // One line per allowlist ENTRY, with its category and the site count it
    // covers — several sites can share one entry (six `delete ctx._triviaLog`
    // calls in one function are one exemption, not six).
    const byKey = new Map()
    for (const f of allowed) byKey.set(f.key, (byKey.get(f.key) ?? 0) + 1)
    console.log(`${byKey.size} allowlisted pre-existing entr${byKey.size === 1 ? 'y' : 'ies'} covering ${allowed.length} site${allowed.length === 1 ? '' : 's'}:`)
    for (const [k, n] of byKey) console.log(`  [${ALLOW.get(k).category}] ${k}${n > 1 ? `  (x${n})` : ''}`)
  }
  if (debt.length) {
    console.log(`\n${debt.length} outstanding DEBT entr${debt.length === 1 ? 'y' : 'ies'} — these are owed, not accepted:`)
    for (const [key, e] of debt) console.log(`  ${key}  →  ${e.ref}`)
  }
  console.log(`\ninvariant gate: ${files.length} modules examined, ${live.length} finding${live.length === 1 ? '' : 's'}`)
}

// A stale allowlist entry is a FAILURE, not a shrug: it means the violation is
// gone and the exemption is now a standing licence to reintroduce it. The list
// may only get shorter, and this is what makes that mechanical rather than
// aspirational.
if (staleAllow.length && !listOnly) {
  console.error(`\ninvariant gate: allowlist entries no longer match any finding — DELETE them:\n  ${staleAllow.join('\n  ')}`)
  process.exit(1)
}
if (live.length && !listOnly) process.exit(1)
