import * as fs from 'node:fs'
import * as path from 'node:path'

/** Resolve bootstrap4.css (or set CSS_FIXTURE_ROOT). */
export function resolveCssFixture(name = 'bootstrap4.css'): string {
  if (process.env.CSS_FIXTURE_ROOT) {
    return path.join(process.env.CSS_FIXTURE_ROOT, name)
  }
  const candidates = [
    path.resolve(import.meta.dirname, '../fixtures/css', name),
    path.resolve(import.meta.dirname, '../../../../less.js/packages/test-data/tests-config/3rd-party', name),
    path.resolve(process.env.HOME ?? '', 'git/oss/less.js/packages/test-data/tests-config/3rd-party', name),
  ]
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) {
    throw new Error(
      `CSS fixture ${name} not found. Copy it to fixtures/css/ or set CSS_FIXTURE_ROOT.`,
    )
  }
  return found
}

export function readCssFixture(name = 'bootstrap4.css'): string {
  return fs.readFileSync(resolveCssFixture(name), 'utf8')
}
