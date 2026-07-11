// GraphQL query document parser (executable definitions only).
// Follows the GraphQL October 2021 spec — commas are insignificant whitespace.

Document
  = defs:(_ @Definition)+ _
  { return defs }

Definition
  = OperationDefinition
  / FragmentDefinition

// ── Operations ───────────────────────────────────────────────────────────────

OperationDefinition
  = sel:SelectionSet
  { return { kind: "OperationDefinition", operation: "query", name: null, variables: [], directives: [], selectionSet: sel } }
  / op:OperationType _ name:Name? _ vars:VariableDefinitions? _ dirs:Directives? _ sel:SelectionSet
  { return { kind: "OperationDefinition", operation: op, name, variables: vars || [], directives: dirs || [], selectionSet: sel } }

OperationType
  = "query"        { return "query" }
  / "mutation"     { return "mutation" }
  / "subscription" { return "subscription" }

// ── Variables ────────────────────────────────────────────────────────────────

VariableDefinitions
  = "(" _ defs:VariableDefinition+ _ ")"
  { return defs }

VariableDefinition
  = "$" v:Name _ ":" _ t:Type _ def:DefaultValue? _ ","? _
  { return { variable: v, type: t, defaultValue: def } }

Variable
  = "$" name:Name
  { return { kind: "Variable", name } }

DefaultValue
  = "=" _ v:Value
  { return v }

// ── SelectionSet / Field ─────────────────────────────────────────────────────

SelectionSet
  = "{" _ sels:Selection+ _ "}"
  { return sels }

Selection
  = FragmentSpread
  / InlineFragment
  / Field

Field
  = alias:(Name _ ":" _)? name:Name _ args:Arguments? _ dirs:Directives? _ sel:SelectionSet? _ ","? _
  { return { alias: alias ? alias[0] : null, name, arguments: args || [], directives: dirs || [], selectionSet: sel || null } }

// ── Arguments ────────────────────────────────────────────────────────────────

Arguments
  = "(" _ args:Argument+ _ ")"
  { return args }

Argument
  = name:Name _ ":" _ value:Value _ ","? _
  { return { name, value } }

// ── Fragments ────────────────────────────────────────────────────────────────

FragmentSpread
  = "..." _ name:FragmentName _ dirs:Directives? _ ","? _
  { return { kind: "FragmentSpread", name, directives: dirs || [] } }

InlineFragment
  = "..." _ cond:TypeCondition? _ dirs:Directives? _ sel:SelectionSet _ ","? _
  { return { kind: "InlineFragment", typeCondition: cond, directives: dirs || [], selectionSet: sel } }

FragmentDefinition
  = "fragment" _ name:FragmentName _ cond:TypeCondition _ dirs:Directives? _ sel:SelectionSet _
  { return { kind: "FragmentDefinition", name, typeCondition: cond, directives: dirs || [], selectionSet: sel } }

FragmentName
  = !("on" ![_0-9A-Za-z]) name:Name
  { return name }

TypeCondition
  = "on" _ type:Name
  { return type }

// ── Directives ───────────────────────────────────────────────────────────────

Directives
  = dirs:Directive+
  { return dirs }

Directive
  = "@" name:Name _ args:Arguments? _
  { return { name, arguments: args || [] } }

// ── Types ────────────────────────────────────────────────────────────────────

Type
  = t:(ListType / NamedType) nn:"!"?
  { return nn ? { kind: "NonNull", type: t } : t }

NamedType
  = name:Name
  { return { kind: "NamedType", name } }

ListType
  = "[" _ t:Type _ "]"
  { return { kind: "ListType", type: t } }

// ── Values ───────────────────────────────────────────────────────────────────

Value
  = Variable
  / FloatValue
  / IntValue
  / StringValue
  / BooleanValue
  / NullValue
  / ListValue
  / ObjectValue
  / EnumValue

BooleanValue
  = "true"  ![_0-9A-Za-z] { return true  }
  / "false" ![_0-9A-Za-z] { return false }

NullValue
  = "null" ![_0-9A-Za-z] { return null }

EnumValue
  = !BooleanValue !NullValue name:Name
  { return { kind: "EnumValue", value: name } }

IntValue
  = s:$("-"? ("0" / [1-9][0-9]*))
  { return parseInt(s, 10) }

FloatValue
  = s:$("-"? ("0" / [1-9][0-9]*) ("." [0-9]+ ([eE][+-]?[0-9]+)? / [eE][+-]?[0-9]+))
  { return parseFloat(s) }

StringValue
  = '"""' chars:BlockChar* '"""' { return chars.join("") }
  / '"' chars:StringChar* '"'    { return chars.join("") }

BlockChar
  = !'"""' c:. { return c }

StringChar
  = c:[^"\\] { return c }
  / "\\" s:EscapeSeq { return s }

EscapeSeq
  = '"'  { return '"'  }
  / "\\" { return "\\" }
  / "/"  { return "/"  }
  / "b"  { return "\b" }
  / "f"  { return "\f" }
  / "n"  { return "\n" }
  / "r"  { return "\r" }
  / "t"  { return "\t" }
  / "u" d:$([0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
  { return String.fromCharCode(parseInt(d, 16)) }

ListValue
  = "[" _ vals:Value* _ "]"
  { return vals }

ObjectValue
  = "{" _ fields:ObjectField* _ "}"
  { return Object.fromEntries(fields) }

ObjectField
  = name:Name _ ":" _ value:Value _ ","? _
  { return [name, value] }

// ── Lexical ──────────────────────────────────────────────────────────────────

Name
  = $([_A-Za-z][_0-9A-Za-z]*)

_ "whitespace"
  = ([ \t\n\r] / "," / "#" [^\n\r]*)*
