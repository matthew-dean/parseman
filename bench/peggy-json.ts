/**
 * Peggy JSON parser for benchmark comparison.
 * Implements the same JSON subset as examples/json/parser.ts.
 */
import peggy from 'peggy'

const GRAMMAR = String.raw`
Value
  = _ value:(Object / Array / String / Number / True / False / Null) _
  { return value }

True  = "true"  { return true }
False = "false" { return false }
Null  = "null"  { return null }

Object
  = "{" _ "}" { return {} }
  / "{" _ head:Pair tail:(_ "," _ p:Pair { return p })* _ "}"
  {
    const obj = Object.create(null)
    obj[head[0]] = head[1]
    for (const [k, v] of tail) obj[k] = v
    return obj
  }

Pair
  = key:String _ ":" _ value:Value
  { return [key, value] }

Array
  = "[" _ "]" { return [] }
  / "[" _ head:Value tail:(_ "," _ v:Value { return v })* _ "]"
  { return [head, ...tail] }

String
  = '"' chars:StringChar* '"'
  { return chars.join("") }

StringChar
  = char:[^"\\] { return char }
  / "\\" seq:EscapeSequence { return seq }

EscapeSequence
  = '"'  { return '"' }
  / '\\' { return '\\' }
  / '/'  { return '/' }
  / 'b'  { return '\b' }
  / 'f'  { return '\f' }
  / 'n'  { return '\n' }
  / 'r'  { return '\r' }
  / 't'  { return '\t' }
  / 'u' h:$([0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
  { return String.fromCharCode(parseInt(h, 16)) }

Number
  = n:$("-"? ("0" / [1-9][0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?)
  { return parseFloat(n) }

_ = [ \t\n\r]*
`

export function buildPeggyJSON(): (input: string) => unknown {
  const parser = peggy.generate(GRAMMAR)
  return (input: string) => parser.parse(input.trim())
}
