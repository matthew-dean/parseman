/** Types for `graphql-node.js`. */
import type {
  GQLType, GQLObject, GQLValue, GQLArg, GQLDirective, GQLVarDef, GQLSelection, GQLField,
  GQLFragmentSpread, GQLInlineFragment, GQLOperationType, GQLOperationDef, GQLFragmentDef,
} from './parser.ts'
export declare const NamedType: new (name: string) => GQLType
export declare const ListType: new (type: GQLType) => GQLType
export declare const NonNull: new (type: GQLType) => GQLType
export declare const Variable: new (name: string) => GQLObject
export declare const EnumValue: new (value: string) => GQLObject
export declare const Argument: new (name: string, value: GQLValue) => GQLArg
export declare const Directive: new (name: string, args: GQLArg[]) => GQLDirective
export declare const VariableDefinition: new (variable: string, type: GQLType, defaultValue: GQLValue | null) => GQLVarDef
export declare const Field: new (alias: string | null, name: string, args: GQLArg[], directives: GQLDirective[], selectionSet: GQLSelection[] | null) => GQLField
export declare const FragmentSpread: new (name: string, directives: GQLDirective[]) => GQLFragmentSpread
export declare const InlineFragment: new (typeCondition: string | null, directives: GQLDirective[], selectionSet: GQLSelection[]) => GQLInlineFragment
export declare const OperationDefinition: new (operation: GQLOperationType, name: string | null, variables: GQLVarDef[], directives: GQLDirective[], selectionSet: GQLSelection[]) => GQLOperationDef
export declare const FragmentDefinition: new (name: string, typeCondition: string, directives: GQLDirective[], selectionSet: GQLSelection[]) => GQLFragmentDef
