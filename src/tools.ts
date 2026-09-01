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

import type { GraphQLArgument, GraphQLField, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { isNonNullType, print } from 'graphql';
import { buildOperation } from './operation.ts';
import { buildOutputSchema } from './outputSchema.ts';
import { paginationHint } from './pagination.ts';
import { compileRules } from './rules.ts';
import { DEFAULT_SELECTION_DEPTH } from './selection.ts';
import type { OperationKind, ToolAnnotations } from './types.ts';
import type { AnyZodType, ZodShape } from './zodCompat.ts';
import {
  argsToZodShape,
  type NullBranches,
  type ScalarMapping,
  type ZodShapeOptions,
} from './zodSchema.ts';

/** A schema-derived MCP tool, prior to being bound to an executor/server. */
export interface ToolDescriptor {
  /** Tool name (the field name under `nameCase`, unless remapped via `toolName`). */
  name: string;
  /** Whether this came from `Query` or `Mutation`. */
  kind: OperationKind;
  /** Human-friendly title (e.g. `Create Todo`). */
  title: string;
  /** Full tool description, derived from the SDL. */
  description: string;
  /** Zod raw shape for the field's arguments (the tool `inputSchema`). */
  inputSchema: ZodShape;
  /**
   * Zod schema describing the field's return type, mirroring the selection set
   * this tool sends. A structural hint for introspection — the server does not
   * validate results against it (see issue #15).
   */
  outputSchema: AnyZodType;
  /** MCP behaviour hints, defaulted from the operation kind. */
  annotations: ToolAnnotations;
  /** The pre-built operation document this tool runs. */
  query: string;
  /** The operation name inside `query` (the root-field name — not the tool name). */
  operationName: string;
  /** The field's argument names (used to pluck variables from validated input). */
  argNames: string[];
  /**
   * The selection depth `query` and {@link ToolDescriptor.outputSchema} were
   * built at. Always set by {@link buildTools}; optional so a hand-built
   * descriptor need not carry one.
   *
   * Settable from `decorate`, which rebuilds the operation, the description, and
   * the output schema at the new depth — the three would otherwise disagree
   * about what the tool returns. Prefer a `selectionDepth` callback in the
   * options when the depth is a function of the field, which is the common case;
   * that decides the depth before anything is built instead of after.
   */
  selectionDepth?: number;
  /**
   * Advice naming the field's pagination argument, appended to a result's
   * truncation note. Absent when the field takes no recognised paging argument.
   */
  pageHint?: string;
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

/**
 * Selection depth for a schema's tools: one number for every field, or a
 * callback deciding per field.
 *
 * The callback exists because depth is a per-field trade-off that a generated
 * schema gives you nowhere to record. A field returning a large collection of
 * rich objects wants depth 1; its neighbours are cheap at 2 and far more useful
 * there. With a single number the worst field sets the depth and every other
 * tool pays for it.
 */
export type SelectionDepth =
  | number
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to depth
  | ((field: GraphQLField<any, any>, kind: OperationKind) => number);

/**
 * How a GraphQL field name is cased when projected into a tool name.
 * `'snake'` (the default) matches the convention MCP servers use; `'preserve'`
 * keeps the field name exactly as the schema spells it.
 */
export type NameCase = 'snake' | 'preserve';

/** Options controlling which fields become tools and how they're named. */
export interface BuildToolsOptions {
  /** Wrap `Query` fields as tools. Default `true`. */
  includeQueries?: boolean;
  /** Wrap `Mutation` fields as tools. Default `true`. */
  includeMutations?: boolean;
  /**
   * Project fields carrying `@deprecated` into tools. Default `true` — the
   * schema is the source of truth, and a deprecated field is often still the
   * only way to do something, so it stays callable with the reason stated
   * loudly in its description. Set `false` to drop them, which is the right
   * call when a replacement already exists and you'd rather an agent never
   * reach for the old one.
   */
  includeDeprecated?: boolean;
  /**
   * Selection-set depth for return types (see `buildSelectionSet`). Default `2`.
   * Also drives `outputSchema`, so the descriptor's schema always matches what
   * the generated operation actually selects.
   *
   * A callback sets it per field — `(field, kind) => field.name === 'runs' ? 1 : 2`
   * — which is how a schema you don't hand-write (and so can't annotate with
   * `extensions.mcp.selectionDepth`) gives its one expensive field a shallower
   * selection without flattening every other tool to match. See
   * {@link SelectionDepth}.
   */
  selectionDepth?: SelectionDepth;
  /**
   * Zod schemas for GraphQL scalars, keyed by scalar name (or a resolver
   * function). Consulted before the built-in mapping, so custom scalars stop
   * falling back to `z.any()` — and `ID`/`String` can be retyped. A generated
   * map (e.g. `defaultScalarMap` from `@vantreeseba/graphql-zod`) can be spread
   * in directly.
   */
  scalars?: ScalarMapping;
  /**
   * Whether a nullable argument advertises an explicit `null` branch alongside
   * being absent from `required`. Default `'always'`.
   *
   * `'never'` drops the branch, which roughly halves the node count of a
   * filter-heavy input schema and removes the one shape that has no legal
   * draft-07 rendering downstream (`anyOf: [{$ref}, {type: 'null'}]`). The cost
   * is that an explicit `null` becomes a validation error, so a mutation whose
   * schema uses `null` to *clear* a field can no longer express that. See
   * {@link ZodShapeOptions.nullBranches}.
   */
  nullBranches?: NullBranches;
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
  /**
   * Case convention for generated tool names. Default `'snake'`, which converts
   * the GraphQL field name to `snake_case` (`createTodo` → `create_todo`) —
   * every example in the MCP spec names tools that way, and it's what agents
   * see across other servers. `'preserve'` keeps the field name verbatim.
   *
   * Only the *name* changes: the humanized `title` (`Create Todo`) and the
   * description still carry the real field name, and `include`/`exclude`
   * patterns match the GraphQL field name either way.
   */
  nameCase?: NameCase;
  /**
   * Map a field to a custom tool name. Default: the field name under `nameCase`.
   * A name returned here is used verbatim — `nameCase` is not applied on top.
   */
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
  const { includeQueries = true, includeMutations = true, includeDeprecated = true } = options;
  // A present-but-empty `include` denies everything (matching `compileRules([])`);
  // only an omitted `include` keeps every field.
  const included = options.include ? compileRules(options.include) : null;
  const excluded = options.exclude ? compileRules(options.exclude) : null;
  const descriptors: ToolDescriptor[] = [];
  const seen = new Set<string>();

  const collect = (root: GraphQLObjectType | null | undefined, kind: OperationKind) => {
    if (!root) return;
    for (const field of Object.values(root.getFields())) {
      if (!includeDeprecated && field.deprecationReason) continue;
      if (excluded?.(field.name, kind)) continue;
      if (included && !included(field.name, kind)) continue;
      if (options.filter && !options.filter(field, kind)) continue;
      const ext = (field.extensions as { mcp?: McpFieldExtensions } | undefined)?.mcp;
      if (ext?.hidden) continue;

      const baseName = options.toolName
        ? options.toolName(field, kind)
        : applyNameCase(field.name, options.nameCase);
      const shape = { scalars: options.scalars, nullBranches: options.nullBranches };
      const depth = ext?.selectionDepth ?? depthFor(options.selectionDepth, field, kind);
      let descriptor = toDescriptor(baseName, field, kind, depth, shape);
      if (ext) descriptor = applyExtensions(descriptor, ext);
      const patch = options.decorate?.(descriptor, field, kind);
      if (patch) {
        // A patched depth changes what the operation selects, so everything
        // derived from the selection is rebuilt rather than left describing the
        // old one. The patch is then applied over the rebuilt descriptor, so an
        // explicit `query` or `description` alongside it still wins.
        if (
          patch.selectionDepth !== undefined &&
          patch.selectionDepth !== descriptor.selectionDepth
        ) {
          descriptor = toDescriptor(baseName, field, kind, patch.selectionDepth, shape);
          if (ext) descriptor = applyExtensions(descriptor, ext);
        }
        descriptor = applyPatch(descriptor, patch);
      }

      if (seen.has(descriptor.name)) {
        throw new Error(
          `graphql-mcp: duplicate tool name '${descriptor.name}'. A query and mutation field ` +
            'likely collide, or two field names differ only in case — disambiguate with ' +
            "`nameCase: 'preserve'`, `toolName`, `extensions.mcp.name`, `decorate`, or a " +
            'filtering option.',
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
  shape: ZodShapeOptions = {},
): ToolDescriptor {
  const { query, operationName, argNames, selection } = buildOperation(kind, field, selectionDepth);
  const pageHint = paginationHint(field.args);
  return {
    name,
    kind,
    title: humanize(field.name),
    description: buildDescription(field, kind, selection, shape.nullBranches ?? 'always'),
    inputSchema: argsToZodShape(field.args, shape),
    // `nullBranches` is an *input* concern: it trades away the ability to send
    // an explicit null. An output schema only describes what comes back, where
    // a null is not a thing the caller chooses, so it keeps its null branches.
    outputSchema: buildOutputSchema(field.type, selectionDepth, shape.scalars),
    annotations: annotationsFor(kind, humanize(field.name)),
    query,
    operationName,
    argNames,
    selectionDepth: selectionDepth ?? DEFAULT_SELECTION_DEPTH,
    ...(pageHint ? { pageHint } : {}),
  };
}

/** The depth for one field: a callback is asked, a number is taken as-is. */
function depthFor(
  selectionDepth: SelectionDepth | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant to depth
  field: GraphQLField<any, any>,
  kind: OperationKind,
): number | undefined {
  return typeof selectionDepth === 'function' ? selectionDepth(field, kind) : selectionDepth;
}

/** Composes a tool description from the field's SDL: docstring, signature, args, and result. */
function buildDescription(
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
  field: GraphQLField<any, any>,
  kind: OperationKind,
  selection: string,
  nullBranches: NullBranches = 'always',
): string {
  const lines: string[] = [];
  lines.push(field.description?.trim() || `The \`${field.name}\` ${kind}.`);
  // Directly under the summary, where it can't be missed: a tool that reads as
  // ordinary is one an agent will pick as readily as its replacement.
  if (field.deprecationReason) {
    lines.push('');
    lines.push(`DEPRECATED — ${field.deprecationReason.trim()}`);
  }
  lines.push('');
  lines.push(`GraphQL ${kind}: \`${field.name}\` → \`${field.type.toString()}\``);
  if (field.args.length) {
    lines.push('');
    lines.push('Arguments:');
    for (const arg of field.args) {
      lines.push(`- ${describeArg(arg, nullBranches)}`);
    }
  }
  // The return type alone doesn't tell an agent which fields arrive: the
  // selection is built automatically and truncated at `selectionDepth`, so a
  // nested object may come back with only some of its fields. Show the real
  // selection rather than letting the agent assume the full type.
  if (selection) {
    lines.push('');
    lines.push('Returns this fixed selection (chosen automatically — not requestable):');
    lines.push(selection);
  }
  return lines.join('\n');
}

/**
 * One argument's description line: name, type, its default, and any deprecation.
 *
 * The default matters as much as the type. An agent told only `\`limit\`: \`Int\``
 * can't tell whether omitting it returns everything or a server-chosen page, so
 * it either guesses a value or is surprised by the result.
 */
function describeArg(arg: GraphQLArgument, nullBranches: NullBranches): string {
  const parts = [`\`${arg.name}\`: \`${arg.type.toString()}\``];
  const fallback = defaultOf(arg);
  // "default: 10" reads as "10 is what you get unless you say otherwise", and an
  // explicit `null` is very much saying otherwise — GraphQL treats a passed null
  // as null, not as a request for the default. An agent that sends null to mean
  // "no preference" gets null. Say which lever actually reaches the default, and
  // only warn about null where null can still be sent (`nullBranches: 'never'`
  // rejects it outright, so the warning would describe an impossible call).
  if (fallback) {
    const nullable = !isNonNullType(arg.type) && nullBranches !== 'never';
    parts.push(
      nullable
        ? `(omit for the default \`${fallback}\`; an explicit \`null\` is sent as null)`
        : `(omit for the default \`${fallback}\`)`,
    );
  }
  if (arg.deprecationReason) parts.push(`(deprecated: ${arg.deprecationReason.trim()})`);
  const description = arg.description?.trim();
  const suffix = description ? ` — ${description}` : '';
  return `${parts.join(' ')}${suffix}`;
}

/**
 * An argument's default rendered as GraphQL source, or `undefined` if it has
 * none. The AST node is preferred over the coerced `defaultValue` because an
 * enum's internal value need not be its SDL name — printing the AST always gives
 * the literal a caller would actually write.
 */
function defaultOf(arg: GraphQLArgument): string | undefined {
  const node = arg.astNode?.defaultValue;
  if (node) return print(node);
  // Schemas built programmatically carry no AST; fall back to the coerced value.
  return arg.defaultValue === undefined ? undefined : JSON.stringify(arg.defaultValue);
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

/**
 * `createTodo` → `create_todo`; `getHTTPResponse` → `get_http_response`; `me` → `me`.
 *
 * The second pattern splits an acronym run from the word that follows it, so a
 * run of capitals stays one word rather than becoming one underscore per letter.
 * GraphQL names are already `[_A-Za-z][_0-9A-Za-z]*`, so the result is always a
 * valid tool name; a field already spelled `snake_case` comes through unchanged.
 */
function toSnakeCase(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Applies the `nameCase` option to a field name. */
function applyNameCase(fieldName: string, nameCase: NameCase = 'snake'): string {
  return nameCase === 'preserve' ? fieldName : toSnakeCase(fieldName);
}

/** `createTodo` → `Create Todo`; `me` → `Me`. */
function humanize(fieldName: string): string {
  const spaced = fieldName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}
