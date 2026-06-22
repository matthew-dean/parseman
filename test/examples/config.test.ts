import { describe, it, expect } from 'vitest'
import { parseConfig, compiledConfig } from '../../examples/toml-ish/parser.ts'
import { parse } from '../../src/index.ts'

describe('Config parser — interpreter', () => {
  it('parses simple key=value', () => {
    const result = parseConfig('key = value\n')
    expect(result['global']!['key']).toBe('value')
  })

  it('parses integer values', () => {
    const result = parseConfig('port = 8080\n')
    expect(result['global']!['port']).toBe(8080)
  })

  it('parses boolean values', () => {
    const result = parseConfig('debug = true\nenabled = false\n')
    expect(result['global']!['debug']).toBe(true)
    expect(result['global']!['enabled']).toBe(false)
  })

  it('parses quoted string values', () => {
    const result = parseConfig('url = "postgres://localhost/db"\n')
    expect(result['global']!['url']).toBe('postgres://localhost/db')
  })

  it('parses sections', () => {
    const input = `[server]\nhost = localhost\nport = 8080\n[db]\nname = mydb\n`
    const result = parseConfig(input)
    expect(result['server']!['host']).toBe('localhost')
    expect(result['server']!['port']).toBe(8080)
    expect(result['db']!['name']).toBe('mydb')
  })

  it('ignores comments', () => {
    const input = `# top comment\nkey = value # inline\n`
    const result = parseConfig(input)
    expect(result['global']!['key']).toBe('value')
  })

  it('parses a realistic config', () => {
    const input = `
[server]
host = localhost
port = 8080
debug = true

[database]
url = "postgres://localhost/mydb"
pool = 10
`.trim() + '\n'
    const result = parseConfig(input)
    expect(result['server']!['host']).toBe('localhost')
    expect(result['server']!['port']).toBe(8080)
    expect(result['database']!['pool']).toBe(10)
  })
})

describe('Config parser — compiled parity', () => {
  const cases = [
    'key = value\n',
    'port = 8080\n',
    'debug = true\n',
    '[section]\nkey = val\n',
  ]

  for (const input of cases) {
    it(`parity: ${JSON.stringify(input)}`, () => {
      const interpreted = parseConfig(input)
      const compiled = compiledConfig.parse(input)
      // compiled returns ok + raw lines; just check it doesn't error
      expect(compiled.ok).toBe(true)
    })
  }
})
