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
  /** Directory names never descended into. */
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
  const ignore = new Set(options.ignoreDirs ?? DEFAULT_IGNORE)
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const exts = new Set(options.extensions.map(e => e.toLowerCase()))

  const missingRoots: string[] = []
  const skippedLarge: string[] = []
  const files = new Set<string>()
  const visited = new Set<string>()

  const walk = (dir: string): void => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ignore.has(item.name)) continue
      const full = join(dir, item.name)
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
        walk(full)
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
      files.add(full)
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
    walk(full)
  }

  const entries = [...files]
    .sort()
    .map(full => ({ id: idOf(base, full), source: readFileSync(full, 'utf8') }))
  return { entries, missingRoots, skippedLarge: skippedLarge.sort() }
}

/** Always POSIX-separated, so a Windows run and a POSIX run agree. */
function idOf(base: string, full: string): string {
  return relative(base, full).split(sep).join('/')
}
