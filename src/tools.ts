/**
 * Turns a `GraphQLSchema` into a flat list of {@link ToolDescriptor}s — one per
 * `Query`/`Mutation` root field. This is the heart of the wrapper: it reads the
 * SDL (field + argument descriptions, types) and projects each operation into an
 * MCP tool whose name, description, and input schema mirror the GraphQL surface
 * one-to-one.
 *
 * Descriptors are pure data (no SDK, no executor). `registerGraphqlTools` binds
 * them to an executor and an `McpServer`.
 */

import type { GraphQLField, GraphQLObjectType, GraphQLSchema } from 'graphql';
import type { ZodRawShape } from 'zod';
import { buildOperation } from './operation.ts';
import type { OperationKind, ToolAnnotations } from './types.ts';
import { argsToZodShape } from './zodSchema.ts';

/** A schema-derived MCP tool, prior to being bound to an executor/server. */
export interface ToolDescriptor {
  /** Tool name (the GraphQL field name, unless remapped via `toolName`). */
  name: string;
  /** Whether this came from `Query` or `Mutation`. */
  kind: OperationKind;
  /** Human-friendly title (e.g. `Create Todo`). */
  title: string;
  /** Full tool description, derived from the SDL. */
  description: string;
  /** Zod raw shape for the field's arguments (the tool `inputSchema`). */
  inputSchema: ZodRawShape;
  /** MCP behaviour hints, defaulted from the operation kind. */
  annotations: ToolAnnotations;
  /** The pre-built operation document this tool runs. */
  query: string;
  /** The field's argument names (used to pluck variables from validated input). */
  argNames: string[];
}

/** Options controlling which fields become tools and how they're named. */
export interface BuildToolsOptions {
  /** Wrap `Query` fields as tools. Default `true`. */
  includeQueries?: boolean;
  /** Wrap `Mutation` fields as tools. Default `true`. */
  includeMutations?: boolean;
  /** Selection-set depth for return types (see `buildSelectionSet`). Default `2`. */
  selectionDepth?: number;
  /** Keep a field only when this returns `true`. Receives the field and its kind. */
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to a filter
  filter?: (field: GraphQLField<any, any>, kind: OperationKind) => boolean;
  /** Map a field to a custom tool name. Default: the field name verbatim. */
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to naming
  toolName?: (field: GraphQLField<any, any>, kind: OperationKind) => string;
}

/**
 * Builds the {@link ToolDescriptor}s for a schema's root fields.
 *
 * @param schema - The GraphQL schema to wrap.
 * @param options - Inclusion, depth, filtering, and naming options.
 * @returns One descriptor per included root field.
 * @throws If two included fields map to the same tool name (e.g. a query and a
 *   mutation share a name) — resolve the clash with `toolName` or `filter`.
 */
export function buildTools(
  schema: GraphQLSchema,
  options: BuildToolsOptions = {},
): ToolDescriptor[] {
  const { includeQueries = true, includeMutations = true } = options;
  const descriptors: ToolDescriptor[] = [];
  const seen = new Set<string>();

  const collect = (root: GraphQLObjectType | null | undefined, kind: OperationKind) => {
    if (!root) return;
    for (const field of Object.values(root.getFields())) {
      if (options.filter && !options.filter(field, kind)) continue;
      const name = options.toolName ? options.toolName(field, kind) : field.name;
      if (seen.has(name)) {
        throw new Error(
          `graphql-mcp: duplicate tool name '${name}'. A query and mutation field likely ` +
            'collide — disambiguate with the `toolName` or `filter` option.',
        );
      }
      seen.add(name);
      descriptors.push(toDescriptor(name, field, kind, options.selectionDepth));
    }
  };

  if (includeQueries) collect(schema.getQueryType(), 'query');
  if (includeMutations) collect(schema.getMutationType(), 'mutation');
  return descriptors;
}

function toDescriptor(
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
  field: GraphQLField<any, any>,
  kind: OperationKind,
  selectionDepth?: number,
): ToolDescriptor {
  const { query, argNames } = buildOperation(kind, field, selectionDepth);
  return {
    name,
    kind,
    title: humanize(field.name),
    description: buildDescription(field, kind),
    inputSchema: argsToZodShape(field.args),
    annotations: annotationsFor(kind, humanize(field.name)),
    query,
    argNames,
  };
}

/** Composes a tool description from the field's SDL: docstring, signature, and args. */
// biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
function buildDescription(field: GraphQLField<any, any>, kind: OperationKind): string {
  const lines: string[] = [];
  lines.push(field.description?.trim() || `The \`${field.name}\` ${kind}.`);
  lines.push('');
  lines.push(`GraphQL ${kind}: \`${field.name}\` → \`${field.type.toString()}\``);
  if (field.args.length) {
    lines.push('');
    lines.push('Arguments:');
    for (const arg of field.args) {
      const desc = arg.description ? ` — ${arg.description.trim()}` : '';
      lines.push(`- \`${arg.name}\`: \`${arg.type.toString()}\`${desc}`);
    }
  }
  return lines.join('\n');
}

/** Default MCP annotations: queries are read-only/idempotent, mutations are writes. */
function annotationsFor(kind: OperationKind, title: string): ToolAnnotations {
  const isQuery = kind === 'query';
  return {
    title,
    readOnlyHint: isQuery,
    destructiveHint: !isQuery,
    idempotentHint: isQuery,
    // Tools reach a GraphQL backend, whose data lives outside this server.
    openWorldHint: true,
  };
}

/** `createTodo` → `Create Todo`; `me` → `Me`. */
function humanize(fieldName: string): string {
  const spaced = fieldName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}
