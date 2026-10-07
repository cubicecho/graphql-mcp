/**
 * Turns hand-written GraphQL documents into {@link ToolDescriptor}s, the curated counterpart to `tools.ts`, which
 * projects a whole schema.
 *
 * Both surfaces produce the same descriptor shape and run through the same registration, executor and result
 * formatting, so an operation tool overrides a generated tool of the same name. Everything here happens at build
 * time, so a typo in a document is a boot failure with a `file:line:column`. Input types are not deduplicated across
 * operations, because a shared memo would have to be keyed by `scalars` and `nullBranches` as well as by type name.
 */

import {
  type DocumentNode,
  type GraphQLArgument,
  GraphQLError,
  type GraphQLSchema,
  isInputType,
  Kind,
  type NameNode,
  NoUnusedFragmentsRule,
  type OperationDefinitionNode,
  parse,
  print,
  type Source,
  separateOperations,
  specifiedRules,
  typeFromAST,
  type VariableDefinitionNode,
  validate,
} from 'graphql';
import { z } from 'zod';
import { DEFAULT_EXAMPLE_DEPTH, DEFAULT_NULL_BRANCHES } from '../core/defaults.ts';
import { messageOf, packageError } from '../core/errors.ts';
import type { OperationKind } from '../core/types.ts';
import type { AnyZodType, ZodShape } from '../core/zod-compat.ts';
import {
  argsToZodShape,
  type InputFieldFilter,
  type NullBranchesSetting,
  type ScalarMapping,
  type ZodShapeOptions,
} from '../input/zod-schema.ts';
import { paginationHint } from '../output/pagination.ts';
import { kindOf } from './operation.ts';
import {
  annotationsFor,
  applyNameCase,
  describeArguments,
  humanize,
  type MutationHints,
  type NameCase,
  type ToolDescriptor,
} from './tools.ts';

/**
 * One document, as source text, a named `Source`, or an already-parsed AST.
 *
 * Prefer a `Source` when the text came from a file: its name is what puts a
 * path into every parse and validation error, which is the difference between
 * "Unknown field `titel`" and a boot message you can click.
 */
export type OperationSource = string | Source | DocumentNode;

/** One document or several. Fragments may live in a document of their own. */
export type OperationsInput = OperationSource | ReadonlyArray<OperationSource>;

/**
 * The subset of {@link BuildToolsOptions} an operation can honour.
 *
 * Deliberately narrow. `include`/`exclude`/`filter` match GraphQL *field* names
 * and govern schema projection, so applying them here would make the headline
 * `include: []` example expose nothing at all; `selectionDepth`,
 * `includeDeprecated`, `toolName` and `extensions.mcp` have no operation
 * counterpart, because you wrote the selection and the name yourself. Edit the
 * document instead of decorating it.
 */
export interface BuildOperationToolsOptions {
  /** Tool naming from the operation name. Default `'snake'` (`listTodos` → `list_todos`). */
  nameCase?: NameCase;
  /** Zod schemas for GraphQL scalars, keyed by scalar name (or a resolver). */
  scalars?: ScalarMapping;
  /** Whether nullable variables advertise an explicit `null` branch. Default `'always'`. */
  nullBranches?: NullBranchesSetting;
  /**
   * Prune fields from the input types these tools advertise. Return `false` to
   * drop a field; pruning a non-null field throws. See
   * {@link ZodShapeOptions.inputField}.
   *
   * It applies here for the same reason it applies to generated tools: a
   * hand-written document reaches the same `where` types, and a projection that
   * pruned one surface but not the other would advertise one GraphQL type two
   * ways across the listing.
   */
  inputField?: InputFieldFilter;
  /** How a mutation's write hints are derived. Default `'uniform'`. */
  mutationHints?: MutationHints;
  /**
   * How deep a variable's `shape:` example expands, `0` to omit them. Default
   * {@link DEFAULT_EXAMPLE_DEPTH}. A number rather than a callback: you are
   * writing these documents one at a time, so the per-operation decision is
   * already in your hands.
   */
  exampleDepth?: number;
}

/**
 * Builds one {@link ToolDescriptor} per operation in `operations`, validated
 * against `schema`.
 *
 * Documents are merged before validation so a fragment defined in one file
 * resolves from an operation in another, then split back apart with
 * `separateOperations`, which carries each operation's transitive fragments
 * with it. Each descriptor's `query` is therefore self-contained.
 *
 * Throws — naming the source and line — on a syntax error, a validation error,
 * an anonymous operation, a subscription, or a non-empty source list that
 * yielded no operations at all.
 *
 * @param schema - The schema the operations are validated against.
 * @param operations - One document or a list of them, each as text, a named `Source` or a parsed AST.
 * @param [options] - Naming, scalar, null-branch, pruning, hint and example settings.
 * @returns One descriptor per operation in source order; empty when given an empty source list.
 */
export function buildOperationTools(
  schema: GraphQLSchema,
  operations: OperationsInput,
  options: BuildOperationToolsOptions = {},
): ToolDescriptor[] {
  const sources = isSourceList(operations) ? operations : [operations];
  if (!sources.length) {
    return [];
  }

  const merged = mergeDocuments(sources);
  assertValid(schema, merged);

  // `separateOperations` keys an anonymous operation as `''`, so this check runs over the definitions before the
  // split can collapse two anonymous operations into one entry.
  const definitions: NamedOperation[] = [];
  for (const definition of merged.definitions.filter(isOperation)) {
    assertUsable(definition);
    definitions.push(definition);
  }
  if (!definitions.length) {
    throw packageError(
      '`operations` was given sources but none of them defined an operation. ' +
        'A glob that matched only fragment files, or matched nothing, produces a server with no tools.',
    );
  }

  const separated = separateOperations(merged);
  return definitions.map((definition) => toDescriptor(schema, definition, separated[definition.name.value], options));
}

/** An operation {@link assertUsable} has passed: it has a name. */
type NamedOperation = OperationDefinitionNode & { name: NameNode };

/**
 * `Array.isArray` alone does not narrow a readonly array out of a union.
 *
 * @param operations - One document or a list of them.
 * @returns `true` when the input is a list.
 */
function isSourceList(operations: OperationsInput): operations is ReadonlyArray<OperationSource> {
  return Array.isArray(operations);
}

/**
 * Parses every source into one document, keeping each node's original `loc`.
 *
 * @param sources - The documents to merge, parsed or still text.
 * @returns One document holding every definition in source order.
 */
function mergeDocuments(sources: ReadonlyArray<OperationSource>): DocumentNode {
  const definitions = sources.flatMap((source) => toDocument(source).definitions);
  return { kind: Kind.DOCUMENT, definitions };
}

/**
 * Already parsed, as opposed to text or a named `Source` still to parse.
 *
 * @param source - One document in any accepted form.
 * @returns `true` when the source is a parsed document node.
 */
function isDocument(source: OperationSource): source is DocumentNode {
  return typeof source === 'object' && 'kind' in source && source.kind === Kind.DOCUMENT;
}

/**
 * Parses one source, re-throwing a syntax error with the package's prefix.
 *
 * @param source - One document as text, a named `Source` or a parsed AST.
 * @returns The parsed document; one that was already parsed is returned as it is.
 */
function toDocument(source: OperationSource): DocumentNode {
  if (isDocument(source)) {
    return source;
  }
  try {
    return parse(source);
  } catch (error) {
    // A `GraphQLError` carries the source it was thrown against, so a named `Source` puts the file into the
    // message.
    const at = error instanceof GraphQLError ? error : undefined;
    throw packageError(
      `could not parse an \`operations\` document — ${messageOf(error, 'the parser gave no reason')}` +
        locationOf(at?.locations?.[0], at?.source?.name),
      { cause: error },
    );
  }
}

/**
 * Validates the merged document, minus `NoUnusedFragmentsRule`.
 *
 * That one rule is dropped deliberately: a shared `fragments.graphql` passed
 * alongside a glob of operation files legitimately defines fragments that not
 * every run uses. Everything else is kept, which is where duplicate operation
 * names, unknown fields (with graphql-js's "Did you mean"), and mistyped
 * variables are caught — each with the file and line the source was named with.
 *
 * @param schema - The schema the document is validated against.
 * @param document - The merged document holding every operation and fragment.
 */
function assertValid(schema: GraphQLSchema, document: DocumentNode): void {
  const rules = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
  const errors = validate(schema, document, rules);
  if (!errors.length) {
    return;
  }
  throw packageError(
    `\`operations\` failed to validate against the schema:\n${errors
      .map((error) => `  - ${error.message}${locationOf(error.locations?.[0], error.source?.name)}`)
      .join('\n')}`,
  );
}

/**
 * Refuses the two operation shapes that cannot become a tool.
 *
 * @param definition - The operation to check; an anonymous operation or a subscription throws.
 */
function assertUsable(definition: OperationDefinitionNode): asserts definition is NamedOperation {
  const where = locationOf(definition.loc?.startToken, definition.loc?.source.name);
  if (!definition.name) {
    throw packageError(
      `an \`operations\` document has an anonymous operation${where}. ` +
        'A tool is addressed by name, so every operation needs one.',
    );
  }
  if (definition.operation === 'subscription') {
    throw packageError(
      `the subscription \`${definition.name.value}\`${where} cannot become a tool. ` +
        'MCP has no streaming-tool shape, so subscriptions are not supported on any surface.',
    );
  }
}

/**
 * Projects one operation into a descriptor.
 *
 * @param schema - The schema that resolves the operation's variable types.
 * @param definition - The named operation the tool runs.
 * @param document - The self-contained document for this operation, with the fragments it uses.
 * @param options - Naming, scalar, null-branch, pruning, hint and example settings.
 * @returns The descriptor, whose `outputSchema` is always `z.unknown()`.
 */
function toDescriptor(
  schema: GraphQLSchema,
  definition: NamedOperation,
  document: DocumentNode,
  options: BuildOperationToolsOptions,
): ToolDescriptor {
  const operationName = definition.name.value;
  const kind = kindOf(definition);
  const variables = definition.variableDefinitions ?? [];
  const args = variables.map((variable) => toArgument(schema, variable));
  const title = humanize(operationName);
  const query = print(document);
  const nullBranches = options.nullBranches ?? DEFAULT_NULL_BRANCHES;
  const pageHint = paginationHint(args);
  return {
    name: applyNameCase(operationName, options.nameCase),
    kind,
    title,
    description: buildDescription({
      operationName,
      kind,
      definition,
      args,
      nullBranches,
      exampleDepth: options.exampleDepth ?? DEFAULT_EXAMPLE_DEPTH,
      query,
    }),
    inputSchema: toInputSchema(args, variables, options, nullBranches),
    // Deferred deliberately: deriving a schema from the document's selection set needs its own walker, and nothing
    // observes this today because it is not registered with the SDK (see issue #15).
    outputSchema: z.unknown(),
    // `byName` reads the *operation* name here, which is a better signal than a
    // generated field name: the author chose it.
    annotations: annotationsFor(kind, operationName, title, options.mutationHints),
    query,
    operationName,
    argNames: args.map((arg) => arg.name),
    ...(pageHint ? { pageHint } : {}),
  };
}

/**
 * The advertised argument shape, with one correction the generated path never
 * needs.
 *
 * `query listTasks($limit: Int! = 20)` means *"you may omit it; it is never
 * null"* — the default is applied during variable coercion. `argsToZodShape`
 * maps `NonNull` to required, which is right for a field argument (and
 * `buildOperation` never emits a variable default), but here it would force an
 * agent to send a value the document already chose. So a non-null variable
 * carrying a default becomes optional, *after* the shape is built, leaving the
 * advertised `default` keyword in place.
 *
 * @param args - The operation's variables as arguments, in the same order as `variables`.
 * @param variables - The operation's variable definitions, read for their defaults and nullability.
 * @param options - The source of the scalar mapping and the input-field filter.
 * @param nullBranches - The resolved null-branch setting for this operation.
 * @returns The Zod raw shape, keyed by variable name.
 */
function toInputSchema(
  args: ReadonlyArray<GraphQLArgument>,
  variables: ReadonlyArray<VariableDefinitionNode>,
  options: BuildOperationToolsOptions,
  nullBranches: NullBranchesSetting,
): ZodShape {
  const shape = argsToZodShape(args, {
    scalars: options.scalars,
    nullBranches,
    inputField: options.inputField,
  });
  variables.forEach((variable, index) => {
    if (!variable.defaultValue || variable.type.kind !== Kind.NON_NULL_TYPE) {
      return;
    }
    const name = args[index].name;
    // Cast: every Zod schema has `optional()`; the cross-major alias does not declare it.
    shape[name] = (shape[name] as AnyZodType & { optional(): AnyZodType }).optional();
  });
  return shape;
}

/**
 * A variable definition, dressed as the `GraphQLArgument` every renderer in
 * this package already knows how to read.
 *
 * The synthetic `astNode` is what makes both default readers correct with no
 * branch of their own: `defaultJsonOf` runs `valueFromASTUntyped` over it and
 * gets an enum's *name* (which is what crosses the wire), and `defaultOf`
 * prints the GraphQL literal a caller would actually write. Keeping the
 * construction in one place is also the mitigation for graphql v17, which
 * reworks `defaultValue`.
 *
 * @param schema - The schema that resolves the variable's type.
 * @param variable - The variable definition to convert.
 * @returns An argument with the variable's name, type, comments as its description, and default on `astNode`.
 */
function toArgument(schema: GraphQLSchema, variable: VariableDefinitionNode): GraphQLArgument {
  const name = variable.variable.name.value;
  const type = typeFromAST(schema, variable.type);
  // Unreachable in practice, because `validate` rejects a variable whose type is not an input type, but the cast
  // below needs a check to justify it.
  if (!type || isInputType(type) === false) {
    throw packageError(`variable \`$${name}\` is not a GraphQL input type.`);
  }
  return {
    name,
    description: leadingComments(variable).join(' ') || undefined,
    type,
    defaultValue: undefined,
    deprecationReason: undefined,
    extensions: Object.create(null),
    astNode: {
      kind: Kind.INPUT_VALUE_DEFINITION,
      name: variable.variable.name,
      type: variable.type,
      ...(variable.defaultValue ? { defaultValue: variable.defaultValue } : {}),
    },
  } as GraphQLArgument;
}

/** What an operation's description is written from. */
interface OperationProse {
  operationName: string;
  kind: OperationKind;
  definition: OperationDefinitionNode;
  args: ReadonlyArray<GraphQLArgument>;
  nullBranches: NullBranchesSetting;
  exampleDepth: number;
  /** The printed document the tool runs. */
  query: string;
}

/**
 * The tool's prose: the operation's own `#` comments, its variables through the
 * shared renderer, and the document it will run.
 *
 * The printed source is here for the reason the generated path prints its
 * selection: an agent that cannot choose what comes back will otherwise assume
 * the full return type and plan around fields that never arrive. Here it is
 * also the only place the selection is written down at all.
 *
 * @param prose - The operation, its kind, its variables as arguments, the printed document and the two settings.
 * @returns The description as lines joined with newlines.
 */
function buildDescription({
  operationName,
  kind,
  definition,
  args,
  nullBranches,
  exampleDepth,
  query,
}: OperationProse): string {
  const lines: string[] = [];
  const comments = leadingComments(definition);
  lines.push(comments.join('\n') || `The \`${operationName}\` ${kind}.`);
  // The same renderer and the same caveat the generated path uses, so a
  // curated tool and a generated one read identically argument for argument.
  lines.push(...describeArguments(args, nullBranches, exampleDepth));
  lines.push('');
  lines.push('Runs this operation (written by hand — the selection is not requestable):');
  lines.push(query);
  return lines.join('\n');
}

/**
 * The `#` comment block immediately above `node`, in source order.
 *
 * GraphQL gives an operation and its variables no description syntax, so
 * comments are the only place a curated surface can carry prose — and per
 * *variable* prose is the one thing a generated tool gets from the SDL and an
 * operation otherwise cannot get at all.
 *
 * Two rules, both about not stealing someone else's comment: a blank line ends
 * the block, so a file header isn't captured by the first operation, and a
 * comment sharing a line with a preceding token is a trailing comment on that
 * line, not a leading one on this node.
 *
 * The token chain (`loc.startToken.prev`) is a lexer detail rather than part of
 * graphql-js's documented surface, so a document with no `loc` at all (parsed
 * with `noLocation`, or re-`print`ed) simply yields nothing and the caller
 * falls back to a generic summary.
 *
 * @param node - A node whose `loc`, when present, gives the token the search starts from.
 * @returns The trimmed comment lines from top to bottom; empty when there are none or the node has no `loc`.
 */
function leadingComments(node: { loc?: OperationDefinitionNode['loc'] }): string[] {
  const out: string[] = [];
  let next = node.loc?.startToken;
  let token = next?.prev;
  while (next && token && token.kind === 'Comment') {
    if (next.line - token.line > 1) {
      break;
    }
    if (token.prev && token.prev.line === token.line) {
      break;
    }
    const value = token.value?.trim();
    if (value) {
      out.unshift(value);
    }
    next = token;
    token = token.prev;
  }
  return out;
}

/**
 * Narrows a definition to an operation.
 *
 * @param definition - Any top-level definition of a document.
 * @returns `true` when the definition is an operation.
 */
function isOperation(definition: DocumentNode['definitions'][number]): definition is OperationDefinitionNode {
  return definition.kind === Kind.OPERATION_DEFINITION;
}

/**
 * ` (ops.graphql:4:3)`, or nothing when the position is unknown.
 *
 * @param at - The line and column to report, or `undefined` when the position is unknown.
 * @param [name] - The name of the source; `operation` is printed when it is absent.
 * @returns The location in parentheses after a leading space, or an empty string when `at` is `undefined`.
 */
function locationOf(at: { line: number; column: number } | undefined, name?: string): string {
  if (!at) {
    return '';
  }
  return ` (${name ?? 'operation'}:${at.line}:${at.column})`;
}
