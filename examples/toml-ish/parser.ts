/**
 * Simple key=value config file parser (INI/TOML-ish subset).
 *
 * Format:
 *   # comment
 *   [section]
 *   key = value        (string)
 *   key = 42           (integer)
 *   key = true/false   (boolean)
 *   key = "quoted str" (string with escapes)
 *
 * No recursion — fully compilable with the macro plugin.
 */
import {
  literal, regex, sequence, choice, many, optional, transform,
  trivia, parse, compile,
} from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const ws = trivia(regex(/[ \t]*/))           // horizontal whitespace only
const lineEnd = regex(/[ \t]*(?:#[^\n]*)?\n/) // optional comment then newline

const key = regex(/[A-Za-z_][A-Za-z0-9_-]*/)

const stringValue = transform(
  sequence(literal('"'), regex(/(?:[^"\\]|\\.)*/), literal('"')),
  ([, s]) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
)
const intValue = transform(regex(/-?[0-9]+/), s => parseInt(s, 10))
const boolValue = transform(choice(literal('true'), literal('false')), s => s === 'true')
const bareValue = regex(/[^\n#]+/)  // fallback: everything to end of line

const value = choice(stringValue, boolValue, intValue, bareValue)

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------
type Entry = { type: 'entry'; key: string; value: string | number | boolean }
type Section = { type: 'section'; name: string }
type Comment = { type: 'comment' }
type Line = Entry | Section | Comment

// Matches blank lines, whitespace-only lines, and comment lines
const commentLine = transform(regex(/[ \t]*(?:#[^\n]*)?\n/), (): Comment => ({ type: 'comment' }))

const sectionLine = transform(
  sequence(ws, literal('['), regex(/[^\]]+/), literal(']'), lineEnd),
  ([, , name]): Section => ({ type: 'section', name: name.trim() })
)

const entryLine = transform(
  sequence(key, literal('='), value, optional(lineEnd)),
  ([k, , v]): Entry => ({ type: 'entry', key: k.trim(), value: typeof v === 'string' ? v.trim() : v })
)

const line: typeof commentLine = choice(commentLine, sectionLine, entryLine)

const configFile = many(line)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export type Config = Record<string, Record<string, string | number | boolean>>

export function parseConfig(input: string): Config {
  const inputWithNewline = input.endsWith('\n') ? input : input + '\n'
  const result = parse(configFile, inputWithNewline, { trivia: ws })
  if (!result.ok) throw new Error(`Config parse error at offset ${result.span.start}`)

  const config: Config = {}
  let currentSection = 'global'
  config[currentSection] = {}

  for (const line of result.value) {
    if (line.type === 'comment') continue
    if (line.type === 'section') {
      currentSection = line.name
      config[currentSection] ??= {}
    } else {
      config[currentSection]![line.key] = line.value
    }
  }
  return config
}

export const compiledConfig = compile(configFile)
