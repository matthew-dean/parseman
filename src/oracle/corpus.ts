/**
 * Loading a file corpus for the identity oracle.
 *
 * Small, and here rather than left to each consumer, because the two ways to get
 * this wrong both produce a gate that looks fine:
 *
 *  - **Absolute ids.** An id derived from an absolute path bakes the checkout
 *    directory into every digest, so two machines — or one machine and its CI —
 *    can never agree, and the first cross-machine comparison reads as a total
 *    regression. Ids here are always relative to an explicit `base`.
 *  - **A root that silently is not there.** A corpus root behind an optional
 *    dependency, or a path that moved, yields a SMALLER corpus and therefore a
 *    different-but-plausible aggregate. Missing roots throw by default; opt out
 *    and you get them listed back so the report can record what was skipped.
 *
 * Symlinks are followed (a workspace corpus usually lives behind one), with
 * realpath cycle detection, and the listing is sorted, so the result does not
 * depend on directory order.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { CorpusEntry } from './identity.ts'

export type LoadCorpusOptions = {
  /** Ids are relative to this directory. Required — see the note above. */
  base: string
  /** Directories to walk, relative to `base` (or absolute). */
  roots: readonly string[]
  /** File extensions to include, with the dot: `['.less', '.css']`. */
  extensions: readonly string[]
  /**
   * Skip files larger than this. A handful of enormous generated fixtures can
   * dominate the runtime of a gate meant to be run on every edit.
   */
  maxBytes?: number
  /**
   * Directories never descended into. An entry with no `/` matches a directory
   * NAME anywhere; an entry containing `/` matches a path suffix, in POSIX form,
   * relative to the root being walked — so `node_modules/.cache` skips the cache
   * without skipping the package tree around it.
   */
  ignoreDirs?: readonly string[]
  /** Tolerate a root that does not exist, reporting it in `missingRoots`. */
  allowMissingRoots?: boolean
}

export type LoadedCorpus = {
  entries: CorpusEntry[]
  /** Roots that did not resolve. Non-empty only with `allowMissingRoots`. */
  missingRoots: string[]
  /** Files skipped for exceeding `maxBytes`, by id. */
  skippedLarge: string[]
}

const DEFAULT_IGNORE = ['.git', 'node_modules/.cache']

export function loadCorpus(options: LoadCorpusOptions): LoadedCorpus {
  const base = resolve(options.base)
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE
  // A NAME pattern matches any directory so called; a PATH pattern (one containing
  // a separator) matches a suffix of the path relative to the root. Splitting them
  // here rather than testing `Set.has(item.name)` is the whole fix for a default
  // that read `node_modules/.cache` and matched nothing: a basename is never equal
  // to a path, so the declared exclusion silently admitted every cache file it
  // named — and a digest that includes a local build cache is exactly the
  // filesystem-dependent reading this module exists to prevent.
  const ignoreNames = new Set(ignoreDirs.filter(d => !d.includes('/')))
  const ignorePaths = ignoreDirs
    .filter(d => d.includes('/'))
    .map(d => d.replace(/^\.?\/+/, '').replace(/\/+$/, ''))
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const exts = new Set(options.extensions.map(e => e.toLowerCase()))

  const missingRoots: string[] = []
  const skippedLarge: string[] = []
  // Keyed by REALPATH, so one physical file reached through two aliased roots is
  // one entry. The value is the id we keep; see the tie-break at the insert site.
  const files = new Map<string, string>()

  const isIgnored = (name: string, relFromRoot: string): boolean => {
    if (ignoreNames.has(name)) return true
    return ignorePaths.some(p => relFromRoot === p || relFromRoot.endsWith(`/${p}`))
  }

  const walk = (dir: string, root: string, visited: Set<string>): void => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    // Cycle detection only, and scoped to THIS root's traversal. A set shared across
    // roots made the second of two aliased roots return here immediately, so it
    // contributed nothing and swapping the root order changed every id it owned.
    if (visited.has(real)) return
    visited.add(real)
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, item.name)
      if (isIgnored(item.name, relative(root, full).split(sep).join('/'))) continue
      // A symlink reports neither isDirectory nor isFile, so stat through it.
      let isDir = item.isDirectory()
      let isFile = item.isFile()
      let size = 0
      if (item.isSymbolicLink() || (!isDir && !isFile)) {
        try {
          const st = statSync(full)
          isDir = st.isDirectory()
          isFile = st.isFile()
          size = st.size
        } catch {
          continue
        }
      }
      if (isDir) {
        walk(full, root, visited)
        continue
      }
      if (!isFile) continue
      const dot = item.name.lastIndexOf('.')
      if (dot < 0 || !exts.has(item.name.slice(dot).toLowerCase())) continue
      if (size === 0) {
        try {
          size = statSync(full).size
        } catch {
          continue
        }
      }
      if (size > maxBytes) {
        skippedLarge.push(idOf(base, full))
        continue
      }
      // One physical file can be reached through several aliased roots. Keep the
      // SMALLEST id rather than the first one seen, so the corpus is a function of
      // the files and the base alone — not of the order `roots` happens to be in.
      let realFile: string
      try {
        realFile = realpathSync(full)
      } catch {
        continue
      }
      const id = idOf(base, full)
      const existing = files.get(realFile)
      if (existing === undefined || id < existing) files.set(realFile, id)
    }
  }

  for (const root of options.roots) {
    const full = resolve(base, root)
    try {
      if (!statSync(full).isDirectory()) throw new Error('not a directory')
    } catch {
      if (!options.allowMissingRoots) {
        throw new Error(
          `loadCorpus: root ${JSON.stringify(root)} does not resolve to a directory (${full}). A corpus that `
          + 'quietly shrank produces a different aggregate that looks like a grammar change. Fix the root, or pass '
          + 'allowMissingRoots and record `missingRoots` alongside the digest.',
        )
      }
      missingRoots.push(root)
      continue
    }
    walk(full, full, new Set())
  }

  const entries = [...files.values()]
    .sort()
    .map(id => ({ id, source: readFileSync(resolve(base, id), 'utf8') }))
  return { entries, missingRoots, skippedLarge: skippedLarge.sort() }
}

/** Always POSIX-separated, so a Windows run and a POSIX run agree. */
function idOf(base: string, full: string): string {
  return relative(base, full).split(sep).join('/')
}
