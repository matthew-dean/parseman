let scope: (() => void)[] | undefined

/** Run `settle` once the `rules()` factory building this node has its references defined.
 * Outside a factory there is nothing to wait for. */
export function afterLink(settle: () => void): void {
  scope?.push(settle)
}

/** Collect what `build` asks to run after linking. A `rules()` nested in a factory uses
 * the outer list, because its nodes can read the outer grammar's references too. */
export function collectAfterLink<T>(pending: (() => void)[], build: () => T): T {
  const outer = scope
  scope = outer ?? pending
  try {
    return build()
  } finally {
    scope = outer
  }
}
