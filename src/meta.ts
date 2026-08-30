/**
 * Schema-exploration ("meta") tools — the alternative to one-tool-per-field for
 * schemas too large to enumerate. Instead of projecting every root field, expose
 * a handful of tools that let an agent navigate the schema itself: look up a
 * type, search for a field, check a document, run one.
 *
 * These are opt-in (`metaTools`) because they widen what an agent can reach: a
 * generated tool can only run its own pre-built operation, whereas `execute`
 * runs a document the agent wrote. To keep the two consistent, `execute` applies
 * the **same `include`/`exclude` rules** as tool generation to every root field
 * of the incoming document, and rejects anything that doesn't pass — otherwise a
 * raw document would be a way around the allow-list.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type DocumentNode,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  parse,
  printType,
  type SelectionSetNode,
  validate,
} from 'graphql';
import { z } from 'zod';
import { DEFAULT_MAX_CHARS, runExecutor, text, toCallToolResult } from './result.ts';
import { compileRules, type RuleMatcher } from './rules.ts';
import type { CustomTool } from './server.ts';
import type { GraphqlExecutor, OperationKind } from './types.ts';

/** The available meta tools. */
export type MetaToolName = 'introspect' | 'search' | 'validate' | 'execute';

const ALL_META_TOOLS: MetaToolName[] = ['introspect', 'search', 'validate', 'execute'];

/** Options for {@link buildMetaTools}. */
export interface MetaToolsOptions {
  /** Which meta tools to expose. Default: all four. */
  tools?: MetaToolName[];
  /** Prefix for the tool names. Default `'graphql_'`. */
  prefix?: string;
  /**
   * Restrict which root fields `execute` may call, in `compileRules` syntax.
   * Defaults to the server's own `include`/`exclude` so the raw-document path
   * can't reach past the generated tool surface.
   */
  include?: string[];
  /** Root fields `execute` must refuse. Wins over `include`. */
  exclude?: string[];
  /** Let `execute` run mutations. Defaults to the server's `includeMutations`. */
  allowMutations?: boolean;
  /** Character budget for a meta-tool result before truncation. Default `50_000`. */
  maxChars?: number;
}

/** What {@link buildMetaTools} needs from the server layer. */
export interface MetaToolDeps {
  /** The schema to explore (post-`extend`, matching the generated tools). */
  schema: GraphQLSchema;
  /** Where `execute` runs its documents. */
  executor: GraphqlExecutor;
  /** Resolves the per-call GraphQL context from the MCP `extra`. */
  resolveContext?: (extra: unknown) => Promise<unknown>;
}

/**
 * Builds the opt-in schema-exploration tools as {@link CustomTool}s, ready to
 * register alongside (or instead of) the generated per-field tools.
 *
 * @param deps - Schema, executor, and context resolution.
 * @param options - Which tools, naming, and the rules `execute` enforces.
 * @returns One {@link CustomTool} per requested meta tool.
 */
export function buildMetaTools(deps: MetaToolDeps, options: MetaToolsOptions = {}): CustomTool[] {
  const prefix = options.prefix ?? 'graphql_';
  const wanted = options.tools ?? ALL_META_TOOLS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const included = options.include ? compileRules(options.include) : null;
  const excluded = options.exclude ? compileRules(options.exclude) : null;
  const allowMutations = options.allowMutations ?? true;
  const allows = (name: string, kind: OperationKind) => {
    if (excluded?.(name, kind)) return false;
    return !included || included(name, kind);
  };

  const built: CustomTool[] = [];
  for (const name of wanted) {
    switch (name) {
      case 'introspect':
        built.push(introspectTool(prefix, deps.schema, allows, maxChars));
        break;
      case 'search':
        built.push(searchTool(prefix, deps.schema, allows, maxChars));
        break;
      case 'validate':
        built.push(validateTool(prefix, deps.schema));
        break;
      case 'execute':
        built.push(executeTool(prefix, deps, allows, allowMutations, maxChars));
        break;
    }
  }
  return built;
}

/* ------------------------------------------------------------------ tools -- */

function introspectTool(
  prefix: string,
  schema: GraphQLSchema,
  allows: RuleMatcher,
  maxChars: number,
): CustomTool {
  return {
    name: `${prefix}introspect`,
    title: 'Introspect GraphQL Schema',
    description:
      'Print the SDL for a GraphQL type. Call with no arguments for an overview: the callable ' +
      'root fields and the names of every type in the schema. Then call again with a `type` ' +
      "name to see that type's fields. Use this before writing a document for " +
      `\`${prefix}execute\`.`,
    inputSchema: {
      type: z
        .string()
        .optional()
        .describe('Type name to print (e.g. `Todo`). Omit for the schema overview.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      const typeName = args.type as string | undefined;
      if (!typeName) return text(overview(schema, allows), maxChars);
      const type = schema.getType(typeName);
      if (!type || isIntrospectionType(type)) {
        return errorText(
          `Unknown type '${typeName}'.${suggest(typeName, typeNames(schema))} ` +
            'Call with no arguments to list every type.',
        );
      }
      return text(printType(type), maxChars);
    },
  };
}

function searchTool(
  prefix: string,
  schema: GraphQLSchema,
  allows: RuleMatcher,
  maxChars: number,
): CustomTool {
  return {
    name: `${prefix}search`,
    title: 'Search GraphQL Schema',
    description:
      'Find types and fields by substring, matching names and descriptions (case-insensitive). ' +
      'Use this to locate the right operation in a large schema — e.g. search "todo" to find ' +
      'every todo-related field — then introspect the types it mentions.',
    inputSchema: {
      query: z.string().min(1).describe('Substring to look for in type and field names.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum matches to return. Default 50.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      const needle = String(args.query).toLowerCase();
      const limit = (args.limit as number | undefined) ?? 50;
      const hits = search(schema, needle, limit, allows);
      if (!hits.length) return text(`No type or field matches '${args.query}'.`, maxChars);
      return text(hits.join('\n'), maxChars);
    },
  };
}

function validateTool(prefix: string, schema: GraphQLSchema): CustomTool {
  return {
    name: `${prefix}validate`,
    title: 'Validate GraphQL Document',
    description:
      'Check a GraphQL document against the schema without running it. Returns the validation ' +
      `errors, or confirms it is valid. Cheaper than a failed \`${prefix}execute\` — use it ` +
      'when unsure about field names or argument types.',
    inputSchema: {
      query: z.string().min(1).describe('The GraphQL document to check.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      const parsed = tryParse(String(args.query));
      if ('error' in parsed) return errorText(parsed.error);
      const errors = validate(schema, parsed.document);
      if (errors.length) {
        return errorText(`Invalid document:\n${errors.map((e) => `- ${e.message}`).join('\n')}`);
      }
      return text('Valid.');
    },
  };
}

function executeTool(
  prefix: string,
  deps: MetaToolDeps,
  allows: RuleMatcher,
  allowMutations: boolean,
  maxChars: number,
): CustomTool {
  return {
    name: `${prefix}execute`,
    title: 'Execute GraphQL Operation',
    description:
      'Run a GraphQL document against the API and return its result. Pass argument values via ' +
      '`variables`, never inlined into the document. Not every root field is callable — the ' +
      `server restricts them; \`${prefix}introspect\` lists the ones that are.`,
    inputSchema: {
      query: z.string().min(1).describe('The GraphQL document to run.'),
      variables: z
        .record(z.string(), z.any())
        .optional()
        .describe('Variable values keyed by variable name (without the `$`).'),
      operationName: z
        .string()
        .optional()
        .describe('Which operation to run. Required only if the document defines more than one.'),
    },
    annotations: {
      readOnlyHint: !allowMutations,
      destructiveHint: allowMutations,
      openWorldHint: true,
    },
    handler: async (args, extra) => {
      const query = String(args.query);
      const parsed = tryParse(query);
      if ('error' in parsed) return errorText(parsed.error);

      const errors = validate(deps.schema, parsed.document);
      if (errors.length) {
        return errorText(`Invalid document:\n${errors.map((e) => `- ${e.message}`).join('\n')}`);
      }

      const operationName = args.operationName as string | undefined;
      const picked = pickOperation(parsed.document, operationName);
      if ('error' in picked) return errorText(picked.error);
      const { operation } = picked;

      if (operation.operation === 'subscription') {
        return errorText('Subscriptions are not supported over MCP.');
      }
      const kind: OperationKind = operation.operation === 'mutation' ? 'mutation' : 'query';
      if (kind === 'mutation' && !allowMutations) {
        return errorText('This server does not allow mutations through the execute tool.');
      }

      // The allow-list check that keeps a hand-written document from reaching
      // past the surface the generated tools expose.
      const roots = rootFieldNames(parsed.document, operation);
      const denied = roots.filter((name) => name !== '__typename' && !allows(name, kind));
      if (denied.length) {
        return errorText(
          `Not permitted: ${denied.map((n) => `\`${n}\``).join(', ')}. ` +
            `This server exposes only part of its schema — use \`${prefix}introspect\` to see ` +
            'which root fields are callable.',
        );
      }

      const context = await deps.resolveContext?.(extra);
      const result = await runExecutor(deps.executor, {
        query,
        variables: (args.variables as Record<string, unknown> | undefined) ?? {},
        ...(operationName ? { operationName } : {}),
        context,
      });
      return toCallToolResult(result, maxChars);
    },
  };
}

/* ---------------------------------------------------------------- helpers -- */

/** Root-field names of `operation`, expanding fragment spreads and inline fragments. */
function rootFieldNames(document: DocumentNode, operation: OperationDefinitionNode): string[] {
  const fragments = new Map<string, SelectionSetNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def.selectionSet);
  }
  const names: string[] = [];
  const visited = new Set<string>();

  const walk = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        names.push(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet);
      } else {
        // A fragment spread at the root would otherwise hide the fields it selects.
        const name = selection.name.value;
        if (visited.has(name)) continue;
        visited.add(name);
        const set = fragments.get(name);
        if (set) walk(set);
      }
    }
  };

  walk(operation.selectionSet);
  return [...new Set(names)];
}

/** Picks the operation to run, matching graphql-js's rules for an omitted name. */
function pickOperation(
  document: DocumentNode,
  operationName: string | undefined,
): { operation: OperationDefinitionNode } | { error: string } {
  const operations = document.definitions.filter(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operations.length) return { error: 'The document defines no operation.' };
  if (operationName) {
    const found = operations.find((op) => op.name?.value === operationName);
    return found ? { operation: found } : { error: `No operation named '${operationName}'.` };
  }
  if (operations.length > 1) {
    const names = operations.map((op) => op.name?.value ?? '<anonymous>').join(', ');
    return { error: `The document defines multiple operations (${names}) — pass operationName.` };
  }
  // Length is exactly 1 here.
  return { operation: operations[0] as OperationDefinitionNode };
}

function tryParse(query: string): { document: DocumentNode } | { error: string } {
  try {
    return { document: parse(query) };
  } catch (cause) {
    return { error: `Syntax error: ${(cause as Error).message}` };
  }
}

/** The no-argument `introspect` response: callable root fields plus every type name. */
function overview(schema: GraphQLSchema, allows: RuleMatcher): string {
  const lines: string[] = [];
  for (const [root, kind] of [
    [schema.getQueryType(), 'query'],
    [schema.getMutationType(), 'mutation'],
  ] as const) {
    if (!root) continue;
    const fields = Object.values(root.getFields()).filter((field) => allows(field.name, kind));
    if (!fields.length) continue;
    lines.push(`type ${root.name} {`);
    for (const field of fields) lines.push(`  ${signature(field)}`);
    lines.push('}', '');
  }
  const names = typeNames(schema);
  lines.push(`Types (${names.length}): ${names.join(', ')}`);
  return lines.join('\n');
}

function search(
  schema: GraphQLSchema,
  needle: string,
  limit: number,
  allows: RuleMatcher,
): string[] {
  const rootKinds = new Map<string, OperationKind>();
  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();
  if (queryType) rootKinds.set(queryType.name, 'query');
  if (mutationType) rootKinds.set(mutationType.name, 'mutation');

  const hits: string[] = [];
  const matches = (...values: (string | null | undefined)[]) =>
    values.some((value) => value?.toLowerCase().includes(needle));

  for (const type of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(type) || type.name.startsWith('__')) continue;
    if (hits.length >= limit) break;
    if (matches(type.name, type.description)) {
      hits.push(`${kindWord(type)} ${type.name}${describeSuffix(type.description)}`);
    }
    if (!isObjectType(type) && !isInterfaceType(type) && !isInputObjectType(type)) continue;
    const kind = rootKinds.get(type.name);
    for (const field of Object.values(type.getFields())) {
      if (hits.length >= limit) break;
      // Don't advertise a root field the execute tool would refuse.
      if (kind && !allows(field.name, kind)) continue;
      if (!matches(field.name, field.description)) continue;
      const shown = 'args' in field ? signature(field) : `${field.name}: ${field.type}`;
      hits.push(`${type.name}.${shown}${describeSuffix(field.description)}`);
    }
  }
  return hits;
}

// biome-ignore lint/suspicious/noExplicitAny: signatures are printed for any root field
function signature(field: GraphQLField<any, any>): string {
  const args = field.args.length
    ? `(${field.args.map((arg: GraphQLArgument) => `${arg.name}: ${arg.type}`).join(', ')})`
    : '';
  return `${field.name}${args}: ${field.type}`;
}

function kindWord(type: GraphQLNamedType): string {
  if (isObjectType(type)) return 'type';
  if (isInterfaceType(type)) return 'interface';
  if (isInputObjectType(type)) return 'input';
  return 'type';
}

function describeSuffix(description?: string | null): string {
  return description ? ` — ${description.trim().split('\n')[0]}` : '';
}

function typeNames(schema: GraphQLSchema): string[] {
  return Object.values(schema.getTypeMap())
    .filter((type) => !isIntrospectionType(type) && !type.name.startsWith('__'))
    .map((type) => type.name);
}

/** `'Toodo'` → `" Did you mean 'Todo'?"` — a cheap prefix/substring nudge. */
function suggest(input: string, candidates: string[]): string {
  const lower = input.toLowerCase();
  const near = candidates.filter(
    (name) =>
      name.toLowerCase().startsWith(lower.slice(0, 3)) || name.toLowerCase().includes(lower),
  );
  return near.length
    ? ` Did you mean ${near
        .slice(0, 3)
        .map((n) => `'${n}'`)
        .join(', ')}?`
    : '';
}

function errorText(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}
