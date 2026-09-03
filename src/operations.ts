/**
 * Turns hand-written GraphQL documents into {@link ToolDescriptor}s — the
 * curated counterpart to `tools.ts`, which projects a whole schema.
 *
 * A generated surface is complete and impersonal: every root field becomes a
 * tool, argument shapes are whatever the schema's generator emitted, and the
 * listing grows with the schema. A hand-written operation is the opposite bet —
 * you name the tool, choose the selection, write the prose, and expose the
 * variables an agent should actually vary. Both surfaces produce the same
 * descriptor shape and run through the same registration, executor, and result
 * formatting, so they compose: an operation tool overrides a generated tool of
 * the same name, exactly as a `tools` entry does.
 *
 * Everything here happens at build time, so a typo in a document is a boot
 * failure with a `file:line:column`, not a failure on the call that hits it.
 *
 * Pure data: no SDK, no executor.
 *
 * Note that input types are **not** deduplicated across operations — each
 * descriptor builds its own, matching the generated path's per-field behaviour.
 * A shared memo would have to be keyed by `scalars` and `nullBranches` as well
 * as by type name, and a memo whose key ignores those is precisely the bug
 * AGENTS.md records under listing size.
 */

import {
  type DocumentNode,
  type GraphQLArgument,
  type GraphQLInputType,
  type GraphQLSchema,
  isInputType,
  Kind,
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
import { buildArgExample, DEFAULT_EXAMPLE_DEPTH } from './argExample.ts';
import { paginationHint } from './pagination.ts';
import {
  annotationsFor,
  applyNameCase,
  describeArgument,
  humanize,
  type MutationHints,
  type NameCase,
  type ToolDescriptor,
} from './tools.ts';
import type { OperationKind } from './types.ts';
import type { AnyZodType, ZodShape } from './zodCompat.ts';
import {
  argsToZodShape,
  DEFAULT_NULL_BRANCHES,
  type InputFieldFilter,
  type NullBranchesSetting,
  type ScalarMapping,
  type ZodShapeOptions,
} from './zodSchema.ts';

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
 */
export function buildOperationTools(
  schema: GraphQLSchema,
  operations: OperationsInput,
  options: BuildOperationToolsOptions = {},
): ToolDescriptor[] {
  const sources = Array.isArray(operations)
    ? (operations as ReadonlyArray<OperationSource>)
    : [operations as OperationSource];
  if (!sources.length) return [];

  const merged = mergeDocuments(sources);
  assertValid(schema, merged);

  // `separateOperations` keys by operation name, and an anonymous operation
  // keys as `''` — so the check has to run over the definitions, before the
  // split silently collapses two anonymous operations into one entry.
  const definitions = merged.definitions.filter(isOperation);
  for (const definition of definitions) assertUsable(definition);
  if (!definitions.length) {
    throw new Error(
      'graphql-mcp: `operations` was given sources but none of them defined an operation. ' +
        'A glob that matched only fragment files, or matched nothing, produces a server with no tools.',
    );
  }

  const separated = separateOperations(merged);
  return definitions.map((definition) => {
    const name = definition.name?.value as string;
    return toDescriptor(schema, definition, separated[name] as DocumentNode, options);
  });
}

/** Parses every source into one document, keeping each node's original `loc`. */
function mergeDocuments(sources: ReadonlyArray<OperationSource>): DocumentNode {
  const definitions = sources.flatMap((source) => toDocument(source).definitions);
  return { kind: Kind.DOCUMENT, definitions };
}

/** Parses one source, re-throwing a syntax error with the package's prefix. */
function toDocument(source: OperationSource): DocumentNode {
  if (typeof source === 'object' && 'kind' in source && source.kind === Kind.DOCUMENT) {
    return source as DocumentNode;
  }
  try {
    return parse(source as string | Source);
  } catch (error) {
    // A `GraphQLError` carries the source it was thrown against, which is the
    // whole reason the option accepts a `Source`: without one the message says
    // *what* is wrong and gives no way to find *which file* it is wrong in.
    const at = error as {
      locations?: ReadonlyArray<{ line: number; column: number }>;
      source?: { name: string };
    };
    throw new Error(
      `graphql-mcp: could not parse an \`operations\` document — ${messageOf(error)}` +
        locationOf(at.locations?.[0], at.source?.name),
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
 */
function assertValid(schema: GraphQLSchema, document: DocumentNode): void {
  const rules = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
  const errors = validate(schema, document, rules);
  if (!errors.length) return;
  throw new Error(
    `graphql-mcp: \`operations\` failed to validate against the schema:\n${errors
      .map((error) => `  - ${error.message}${locationOf(error.locations?.[0], error.source?.name)}`)
      .join('\n')}`,
  );
}

/** Refuses the two operation shapes that cannot become a tool. */
function assertUsable(definition: OperationDefinitionNode): void {
  const where = locationOf(definition.loc?.startToken, definition.loc?.source.name);
  if (!definition.name) {
    throw new Error(
      `graphql-mcp: an \`operations\` document has an anonymous operation${where}. ` +
        'A tool is addressed by name, so every operation needs one.',
    );
  }
  if (definition.operation === 'subscription') {
    throw new Error(
      `graphql-mcp: the subscription \`${definition.name.value}\`${where} cannot become a tool. ` +
        'MCP has no streaming-tool shape, so subscriptions are not supported on any surface.',
    );
  }
}

/** Projects one operation into a descriptor. */
function toDescriptor(
  schema: GraphQLSchema,
  definition: OperationDefinitionNode,
  document: DocumentNode,
  options: BuildOperationToolsOptions,
): ToolDescriptor {
  const operationName = definition.name?.value as string;
  const kind: OperationKind = definition.operation === 'mutation' ? 'mutation' : 'query';
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
    description: buildDescription(
      operationName,
      kind,
      definition,
      args,
      nullBranches,
      options.exampleDepth ?? DEFAULT_EXAMPLE_DEPTH,
      query,
    ),
    inputSchema: toInputSchema(args, variables, options, nullBranches),
    // Deferred, deliberately: a schema derived from the document's selection set
    // (aliases, spreads, inline fragments, type conditions) is its own walker,
    // and nothing observes this today — it is not registered with the SDK (see
    // issue #15), and the description already carries the printed source.
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
    if (!variable.defaultValue || variable.type.kind !== Kind.NON_NULL_TYPE) return;
    const name = args[index].name;
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
 */
function toArgument(schema: GraphQLSchema, variable: VariableDefinitionNode): GraphQLArgument {
  const name = variable.variable.name.value;
  const type = typeFromAST(schema, variable.type);
  // Unreachable in practice — `validate` rejects a variable whose type isn't an
  // input type before this runs — but the cast has to be justified by a check
  // rather than by a comment.
  if (!type || !isInputType(type)) {
    throw new Error(`graphql-mcp: variable \`$${name}\` is not a GraphQL input type.`);
  }
  return {
    name,
    description: leadingComments(variable).join(' ') || undefined,
    type: type as GraphQLInputType,
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

/**
 * The tool's prose: the operation's own `#` comments, its variables through the
 * shared renderer, and the document it will run.
 *
 * The printed source is here for the reason the generated path prints its
 * selection: an agent that cannot choose what comes back will otherwise assume
 * the full return type and plan around fields that never arrive. Here it is
 * also the only place the selection is written down at all.
 */
function buildDescription(
  operationName: string,
  kind: OperationKind,
  definition: OperationDefinitionNode,
  args: ReadonlyArray<GraphQLArgument>,
  nullBranches: NullBranchesSetting,
  exampleDepth: number,
  query: string,
): string {
  const lines: string[] = [];
  const comments = leadingComments(definition);
  lines.push(comments.join('\n') || `The \`${operationName}\` ${kind}.`);
  if (args.length) {
    // The same renderer and the same caveat the generated path uses, so a
    // curated tool and a generated one read identically argument for argument.
    const examples = args.map((arg) => buildArgExample(arg, exampleDepth));
    lines.push('');
    lines.push(
      examples.some(Boolean)
        ? 'Arguments (`shape:` shows a minimal JSON example — required fields only):'
        : 'Arguments:',
    );
    args.forEach((arg, index) => {
      lines.push(`- ${describeArgument(arg, nullBranches)}`);
      const example = examples[index];
      if (example) lines.push(`  shape: ${example}`);
    });
  }
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
 */
function leadingComments(node: { loc?: OperationDefinitionNode['loc'] }): string[] {
  const out: string[] = [];
  let next = node.loc?.startToken;
  let token = next?.prev;
  while (next && token && token.kind === 'Comment') {
    if (next.line - token.line > 1) break;
    if (token.prev && token.prev.line === token.line) break;
    const value = token.value?.trim();
    if (value) out.unshift(value);
    next = token;
    token = token.prev;
  }
  return out;
}

/** Narrows a definition to an operation. */
function isOperation(
  definition: DocumentNode['definitions'][number],
): definition is OperationDefinitionNode {
  return definition.kind === Kind.OPERATION_DEFINITION;
}

/** ` (ops.graphql:4:3)`, or nothing when the source was unnamed or absent. */
function locationOf(at: { line: number; column: number } | undefined, name?: string): string {
  if (!at) return '';
  return ` (${name ?? 'operation'}:${at.line}:${at.column})`;
}

/** An error's message, however it was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
