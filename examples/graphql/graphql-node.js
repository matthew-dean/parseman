// The GraphQL example's nodes, built by `new` calls rather than object literals: a `new`
// call has no allocation site, so V8 cannot pretenure the nodes a parse keeps (see
// `examples/css/css-node.js`). Each prototype is `Object.prototype`, so every node is a
// plain object. Plain JavaScript because TypeScript cannot declare a function
// constructor without a cast; `graphql-node.d.ts` types it.

export function NamedType(name) { this.kind = 'NamedType'; this.name = name }
export function ListType(type) { this.kind = 'ListType'; this.type = type }
export function NonNull(type) { this.kind = 'NonNull'; this.type = type }
export function Variable(name) { this.kind = 'Variable'; this.name = name }
export function EnumValue(value) { this.kind = 'EnumValue'; this.value = value }
export function Argument(name, value) { this.name = name; this.value = value }
export function Directive(name, args) { this.name = name; this.arguments = args }
export function VariableDefinition(variable, type, defaultValue) {
  this.variable = variable
  this.type = type
  this.defaultValue = defaultValue
}
export function Field(alias, name, args, directives, selectionSet) {
  this.alias = alias
  this.name = name
  this.arguments = args
  this.directives = directives
  this.selectionSet = selectionSet
}
export function FragmentSpread(name, directives) {
  this.kind = 'FragmentSpread'
  this.name = name
  this.directives = directives
}
export function InlineFragment(typeCondition, directives, selectionSet) {
  this.kind = 'InlineFragment'
  this.typeCondition = typeCondition
  this.directives = directives
  this.selectionSet = selectionSet
}
export function OperationDefinition(operation, name, variables, directives, selectionSet) {
  this.kind = 'OperationDefinition'
  this.operation = operation
  this.name = name
  this.variables = variables
  this.directives = directives
  this.selectionSet = selectionSet
}
export function FragmentDefinition(name, typeCondition, directives, selectionSet) {
  this.kind = 'FragmentDefinition'
  this.name = name
  this.typeCondition = typeCondition
  this.directives = directives
  this.selectionSet = selectionSet
}

for (const F of [NamedType, ListType, NonNull, Variable, EnumValue, Argument, Directive, VariableDefinition,
  Field, FragmentSpread, InlineFragment, OperationDefinition, FragmentDefinition]) F.prototype = Object.prototype
