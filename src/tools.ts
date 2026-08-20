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
import { compileRules } from './rules.ts';
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
  /** The operation name inside `query` (the root-field name — not the tool name). */
  operationName: string;
  /** The field's argument names (used to pluck variables from validated input). */
  argNames: string[];
}

/**
 * Per-field MCP metadata read from `field.extensions.mcp`, set where the schema
 * is defined. Applied over the SDL-derived defaults (and under `decorate`).
 */
export interface McpFieldExtensions {
  /** Skip this field entirely. */
  hidden?: boolean;
  /** Override the tool name (wins over the `toolName` option). */
  name?: string;
  /** Override the humanized title (also reflected in `annotations.title`). */
  title?: string;
  /** Replace the SDL-derived description. */
  description?: string;
  /** Append to the description (after a blank line) instead of replacing it. */
  appendDescription?: string;
  /** Shallow-merged over the kind-derived default annotations. */
  annotations?: Partial<ToolAnnotations>;
  /** Per-field selection depth (overrides the `selectionDepth` option). */
  selectionDepth?: number;
}

/** Options controlling which fields become tools and how they're named. */
export interface BuildToolsOptions {
  /** Wrap `Query` fields as tools. Default `true`. */
  includeQueries?: boolean;
  /** Wrap `Mutation` fields as tools. Default `true`. */
  includeMutations?: boolean;
  /** Selection-set depth for return types (see `buildSelectionSet`). Default `2`. */
  selectionDepth?: number;
  /**
   * Keep only fields matching one of these patterns (`compileRules` syntax:
   * `'todos'`, `'Query.*'`, `'delete*'`). Omit to keep every field; a present
   * but empty array matches nothing and so exposes no tools.
   */
  include?: string[];
  /** Drop fields matching one of these patterns. Wins over `include` and `filter`. */
  exclude?: string[];
  /** Keep a field only when this returns `true`. Receives the field and its kind. */
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to a filter
  filter?: (field: GraphQLField<any, any>, kind: OperationKind) => boolean;
  /** Map a field to a custom tool name. Default: the field name verbatim. */
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to naming
  toolName?: (field: GraphQLField<any, any>, kind: OperationKind) => string;
  /**
   * Adjust a generated descriptor last, after `extensions.mcp` metadata. Return
   * a full or partial descriptor to merge, or nothing to keep it as-is. Keys set
   * to `undefined` are ignored and `annotations` merge over the existing ones.
   * If you override `query`, `argNames`, or `operationName`, they must stay
   * mutually consistent.
   */
  decorate?: (
    descriptor: ToolDescriptor,
    // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
    field: GraphQLField<any, any>,
    kind: OperationKind,
  ) => ToolDescriptor | Partial<ToolDescriptor> | undefined;
}

/**
 * Builds the {@link ToolDescriptor}s for a schema's root fields.
 *
 * Each field runs through a fixed pipeline: `exclude`/`include` rules → the
 * `filter` callback → `extensions.mcp.hidden` → SDL-derived defaults →
 * `extensions.mcp` metadata → the `decorate` callback. Later stages win; the
 * rule/filter stages only drop fields, never rename them.
 *
 * @param schema - The GraphQL schema to wrap.
 * @param options - Inclusion, depth, filtering, naming, and decoration options.
 * @returns One descriptor per included root field.
 * @throws If two included fields map to the same final tool name (e.g. a query
 *   and a mutation share a name) — resolve the clash with `toolName`,
 *   `extensions.mcp.name`, `decorate`, or a filtering option. Also if an
 *   `include`/`exclude` pattern has a prefix other than `Query`/`Mutation`.
 */
export function buildTools(
  schema: GraphQLSchema,
  options: BuildToolsOptions = {},
): ToolDescriptor[] {
  const { includeQueries = true, includeMutations = true } = options;
  // A present-but-empty `include` denies everything (matching `compileRules([])`);
  // only an omitted `include` keeps every field.
  const included = options.include ? compileRules(options.include) : null;
  const excluded = options.exclude ? compileRules(options.exclude) : null;
  const descriptors: ToolDescriptor[] = [];
  const seen = new Set<string>();

  const collect = (root: GraphQLObjectType | null | undefined, kind: OperationKind) => {
    if (!root) return;
    for (const field of Object.values(root.getFields())) {
      if (excluded?.(field.name, kind)) continue;
      if (included && !included(field.name, kind)) continue;
      if (options.filter && !options.filter(field, kind)) continue;
      const ext = (field.extensions as { mcp?: McpFieldExtensions } | undefined)?.mcp;
      if (ext?.hidden) continue;

      const baseName = options.toolName ? options.toolName(field, kind) : field.name;
      let descriptor = toDescriptor(
        baseName,
        field,
        kind,
        ext?.selectionDepth ?? options.selectionDepth,
      );
      if (ext) descriptor = applyExtensions(descriptor, ext);
      const patch = options.decorate?.(descriptor, field, kind);
      if (patch) descriptor = applyPatch(descriptor, patch);

      if (seen.has(descriptor.name)) {
        throw new Error(
          `graphql-mcp: duplicate tool name '${descriptor.name}'. A query and mutation field ` +
            'likely collide — disambiguate with the `toolName`, `extensions.mcp.name`, ' +
            '`decorate`, or a filtering option.',
        );
      }
      seen.add(descriptor.name);
      descriptors.push(descriptor);
    }
  };

  if (includeQueries) collect(schema.getQueryType(), 'query');
  if (includeMutations) collect(schema.getMutationType(), 'mutation');
  return descriptors;
}

/**
 * Merges a `decorate` return value onto the descriptor. Keys explicitly set to
 * `undefined` are ignored (so a patch never blanks a required field),
 * `annotations` merge rather than replace, and a patched `title` mirrors into
 * `annotations.title` unless the patch sets that itself — the SDK advertises
 * both, so they must not drift apart.
 */
function applyPatch(
  d: ToolDescriptor,
  patch: ToolDescriptor | Partial<ToolDescriptor>,
): ToolDescriptor {
  const merged: ToolDescriptor = { ...d };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.annotations) merged.annotations = { ...d.annotations, ...patch.annotations };
  if (patch.title !== undefined && patch.annotations?.title === undefined) {
    merged.annotations = { ...merged.annotations, title: patch.title };
  }
  return merged;
}

/** Overlays `field.extensions.mcp` metadata onto the SDL-derived descriptor. */
function applyExtensions(d: ToolDescriptor, ext: McpFieldExtensions): ToolDescriptor {
  let description = ext.description ?? d.description;
  if (ext.appendDescription) description = `${description}\n\n${ext.appendDescription}`;
  return {
    ...d,
    name: ext.name ?? d.name,
    title: ext.title ?? d.title,
    description,
    annotations: {
      ...d.annotations,
      ...(ext.title ? { title: ext.title } : {}),
      ...ext.annotations,
    },
  };
}

function toDescriptor(
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
  field: GraphQLField<any, any>,
  kind: OperationKind,
  selectionDepth?: number,
): ToolDescriptor {
  const { query, operationName, argNames } = buildOperation(kind, field, selectionDepth);
  return {
    name,
    kind,
    title: humanize(field.name),
    description: buildDescription(field, kind),
    inputSchema: argsToZodShape(field.args),
    annotations: annotationsFor(kind, humanize(field.name)),
    query,
    operationName,
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
