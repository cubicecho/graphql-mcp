/**
 * Converts a GraphQL field's arguments into a Zod "raw shape" — the input-schema
 * form the MCP SDK's `registerTool` expects. Written by hand (rather than pulling
 * in a graphql-to-zod dependency) because the mapping is small and we want full
 * control over nullability, descriptions, and custom-scalar fallbacks.
 *
 * Mapping rules:
 * - `NonNull` → required (no `.nullish()`); a nullable arg/field becomes `.nullish()`,
 *   or plain `.optional()` under `nullBranches: 'never'` (see {@link ZodShapeOptions})
 * - `List` → `z.array(element)`; a nullable *element* is always `.nullable()`,
 *   since an element can be null but never absent
 * - scalars → the `scalars` option first, then the built-ins (`Int`/`Float` ⇒ number,
 *   `String`/`ID` ⇒ string, `Boolean` ⇒ boolean), then `z.any()` carrying the
 *   scalar's own SDL description (see {@link builtinScalar})
 * - enums → `z.enum([...names])` (enum *names*, the form passed as GraphQL variables)
 * - input objects → a strict `z.object({...})`, recursively; self-references become `z.lazy()`
 *   to model the recursion precisely instead of falling back to `z.any()`. Each
 *   named input type is built once per call and shared, so a type reached by
 *   several routes renders as one `$defs` entry — keyed by its GraphQL type name
 *   — rather than being expanded again at every site (see {@link Ctx}).
 */

import {
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLInputObjectType,
  type GraphQLInputType,
  type GraphQLScalarType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  valueFromASTUntyped,
} from 'graphql';
import { z } from 'zod';
import { type AnyZodType, withDefault, withName, type ZodShape } from './zodCompat.ts';

/**
 * Zod schemas keyed by GraphQL scalar name — the same shape scalar-map
 * generators emit (e.g. `defaultScalarMap` from `@vantreeseba/graphql-zod`), so
 * one can be spread in directly.
 */
export type ScalarMap = Record<string, AnyZodType>;

/**
 * Dynamic form of {@link ScalarMap}: return a schema for the scalar, or
 * `undefined` to fall through to the built-in mapping.
 */
export type ScalarResolver = (scalar: GraphQLScalarType) => AnyZodType | undefined;

/** A scalar mapping: either a name→schema record or a resolver function. */
export type ScalarMapping = ScalarMap | ScalarResolver;

/**
 * How a nullable *input position* is rendered — an argument, or a field of an
 * input object.
 *
 * - `'always'` (default) — a nullable position accepts an explicit `null` as
 *   well as being absent, so it renders an explicit null branch
 *   (`anyOf: [T, {type: 'null'}]`, or `type: [X, 'null']` for a scalar) on top
 *   of being left out of `required`.
 * - `'never'` — a nullable position is merely optional. `required` already says
 *   it may be absent, so the shape is not lost; what *is* lost is the ability to
 *   send an explicit `null`.
 *
 * The choice is a real trade, which is why it is an option rather than a fix.
 * See {@link ZodShapeOptions.nullBranches}.
 */
export type NullBranches = 'always' | 'never';

/** The mode a nullable input position takes when nothing says otherwise. */
export const DEFAULT_NULL_BRANCHES: NullBranches = 'always';

/** Options shared by the arg→Zod conversion. */
export interface ZodShapeOptions {
  /**
   * Zod schemas for GraphQL scalars, consulted **before** the built-ins — so
   * this can retype `ID`/`String` as well as fill in custom scalars. Provide the
   * *base* (non-null) schema; list/nullability wrapping is applied around it.
   */
  scalars?: ScalarMapping;
  /**
   * Whether a nullable input position advertises an explicit `null` branch.
   * Default `'always'`, which is what GraphQL actually permits.
   *
   * `'never'` exists because the branch is expensive and, in one shape, not
   * portable. It roughly doubles the node count of a filter-heavy schema —
   * optionality is stated twice, and the second statement is the costly one —
   * and when the surviving branch is a `$ref` there is *no* legal draft-07
   * rendering of "nullable" for a downstream consumer to collapse it to:
   * siblings of `$ref` are ignored there and strict validators reject them, so
   * a consumer either keeps a combinator its backend refuses or emits an
   * illegal node.
   *
   * It is not free. `'never'` makes an explicit `null` a *validation error*,
   * which breaks the common mutation idiom of passing `null` to clear a field
   * (`updateUser(bio: null)`) — absent and null are the same thing to many
   * GraphQL servers, but not to all of them, and only the schema's author knows
   * which kind theirs is. That is why the default keeps the branch.
   *
   * List *elements* are unaffected either way: an element cannot be absent, so
   * a nullable element always renders its null branch.
   */
  nullBranches?: NullBranches;
  /**
   * Whether a field of an input object is advertised at all. Return `false` to
   * prune it. Default: every field is kept.
   *
   * The knob every other option lacks: `include`, `filter`, `decorate` and the
   * rest all address a *root field*, so the transitive closure behind a
   * generated `where` was take-it-or-leave-it. On a generated CRUD surface that
   * closure is most of the listing — relation filters pull in each other's
   * whole filter type, measured at 92% of a 378 kB listing for capability that
   * went unused across 100 logged calls.
   *
   * ```ts
   * // drop relation filters from the MCP projection; the API keeps them
   * inputField: (field) => !/ListRelationFilter/.test(String(field.type))
   * ```
   *
   * **It must be a pure function of the type**, which is why it receives the
   * field and its parent and *not* the root field it was reached through.
   * Input objects are cached and named by GraphQL type name alone, so one name
   * has to mean one schema; a prune that varied by route would put two bodies
   * under one name and throw `Duplicate schema id` during JSON Schema
   * conversion. Deciding per type keeps the cache key correct by construction.
   *
   * Pruning a **non-null** field throws instead: the server still requires it,
   * so the tool would be advertised as callable and rejected on every call.
   */
  inputField?: InputFieldFilter;
}

/**
 * Decides whether one field of an input object is advertised. See
 * {@link ZodShapeOptions.inputField}.
 */
export type InputFieldFilter = (
  field: GraphQLInputField,
  parent: GraphQLInputObjectType,
) => boolean;

const SCALAR_BUILDERS: Record<string, () => AnyZodType> = {
  Int: () => z.number().int(),
  Float: () => z.number(),
  String: () => z.string(),
  Boolean: () => z.boolean(),
  ID: () => z.string(),
};

/**
 * The schema for a scalar with no entry in the user's `scalars` mapping: the
 * built-in for a standard scalar, otherwise an opaque value.
 *
 * The opaque case carries the scalar's *own* SDL description, because that is
 * where the wire format is documented (`"""An ISO-8601 timestamp.""" scalar
 * DateTime`). Describing it as nothing but its name leaves an agent guessing at
 * a format the schema spells out. Shared with `outputSchema.ts` so both sides
 * describe a scalar identically.
 *
 * @param type - The scalar type to map.
 */
export function builtinScalar(type: GraphQLScalarType): AnyZodType {
  const builder = SCALAR_BUILDERS[type.name];
  if (builder) return builder();
  const hint = type.description?.trim();
  return z
    .any()
    .describe(hint ? `Custom scalar ${type.name} — ${hint}` : `Custom scalar ${type.name}`);
}

/** Recursion state: the input-object cycle guard, the memo, and the render options. */
interface Ctx {
  /**
   * Input objects whose shape is still being built, keyed by type name. A
   * self-reference found while building links back to the same `z.lazy` node
   * instead of recursing forever.
   */
  pending: Map<string, AnyZodType>;
  /**
   * Input objects already built, keyed by type name — the *same* Zod instance is
   * returned every time a type is met again.
   *
   * Identity is the whole point. `pending` only guards the path being walked and
   * is cleared on the way back up, so without this a type reached twice by two
   * different routes was rebuilt into two structurally identical but distinct
   * schemas. `toJSONSchema` deduplicates by instance, so those became two
   * expansions rather than a `$ref`, and a schema where several tables filter
   * through one another grew multiplicatively: one real `where` argument
   * rendered at 2.8 MB, and its whole tool listing at 18 MB, which is past what
   * any model will read. Sharing the instance turns the walk into a DAG and the
   * repeats into `$defs`.
   */
  done: Map<string, AnyZodType>;
  scalar: ScalarResolver;
  nullBranches: NullBranches;
  inputField: InputFieldFilter | undefined;
}

/** Normalizes either mapping form into a single lookup function. */
export function toResolver(mapping: ScalarMapping | undefined): ScalarResolver {
  if (!mapping) return () => undefined;
  if (typeof mapping === 'function') return mapping;
  return (scalar) => mapping[scalar.name];
}

/**
 * Applies a type's nullability. `NonNull` is required either way; a nullable
 * type depends on where it sits.
 *
 * A **property** (an argument, or a field of an input object) can be left out,
 * so `required` already carries "may be absent" and the null branch adds only
 * "may be explicitly null" — which {@link ZodShapeOptions.nullBranches} can
 * turn off.
 *
 * An **element** of a list cannot be absent — there is no such thing as a hole
 * in a JSON array — so `.nullable()` is the only way to say `[String]` permits
 * nulls, and dropping it there would change the type rather than compress it.
 */
function fieldToZod(
  type: GraphQLInputType,
  ctx: Ctx,
  position: 'property' | 'element',
): AnyZodType {
  if (isNonNullType(type)) {
    return baseToZod(type.ofType, ctx);
  }
  const base = baseToZod(type, ctx);
  if (position === 'element') return base.nullable();
  return ctx.nullBranches === 'never' ? base.optional() : base.nullish();
}

/** Builds the Zod type for a (already nullability-stripped) list/named GraphQL type. */
function baseToZod(type: GraphQLInputType, ctx: Ctx): AnyZodType {
  if (isListType(type)) {
    return z.array(fieldToZod(type.ofType, ctx, 'element'));
  }
  if (isScalarType(type)) {
    // User mapping wins over the built-ins so `ID`/`String` can be retyped.
    const mapped = ctx.scalar(type);
    return mapped ?? builtinScalar(type);
  }
  if (isEnumType(type)) {
    const names = type.getValues().map((value) => value.name);
    // An enum with no values can't happen in a valid schema, but guard the cast.
    return names.length ? z.enum(names as [string, ...string[]]) : z.string();
  }
  if (isInputObjectType(type)) {
    // Self-referential input types (e.g. a nested filter tree) resolve to the
    // `z.lazy` node registered before the shape is built, so the recursion is
    // modelled precisely instead of collapsing to an opaque `z.any()`.
    // A type already finished is reused outright; one still on the stack resolves
    // to its `z.lazy` placeholder, which is what makes a cycle terminate.
    const built = ctx.done.get(type.name);
    if (built) return built;
    const pending = ctx.pending.get(type.name);
    if (pending) return pending;
    const holder: { schema?: AnyZodType } = {};
    // `z.lazy` defers its getter until parse time, which is always after this
    // call returns and sets `holder.schema` — so the cast can't observe undefined.
    ctx.pending.set(
      type.name,
      z.lazy(() => holder.schema as AnyZodType),
    );
    const shape: ZodShape = {};
    for (const [name, field] of Object.entries(type.getFields())) {
      if (ctx.inputField && !ctx.inputField(field, type)) {
        // A pruned non-null field is not a smaller tool, it is a broken one:
        // the schema stops advertising a field the server still requires, so
        // every call is rejected for a reason the agent cannot see from the
        // tool. Refusing at build time is the same bargain the operation
        // refusals make — fail where a human is reading, not per call.
        if (isNonNullType(field.type)) {
          throw new Error(
            `graphql-mcp: \`inputField\` pruned \`${type.name}.${name}\`, which is non-null. ` +
              'The GraphQL server still requires it, so every call to a tool using this type ' +
              'would fail. Keep the field, or make it nullable in the schema.',
          );
        }
        // Never walked, so nothing it referenced is reachable either — a type
        // reached only through a pruned field never enters `definitions`.
        continue;
      }
      shape[name] = withArgDefault(
        describe(fieldToZod(field.type, ctx, 'property'), field.description),
        field,
      );
    }
    ctx.pending.delete(type.name);
    // `.strict()`, not the default `strip`: the JSON Schema the SDK renders from
    // this object already advertises `additionalProperties: false`, and a plain
    // `z.object` silently drops the unknown key instead of rejecting it. For a
    // caller that is a model, silence is the expensive failure — a misspelled
    // field name comes back `isError: false` with a success payload, so nothing
    // signals that part of the intent was discarded and nothing prompts a retry.
    // Strict makes the enforced contract match the advertised one and names the
    // offending field, the way the GraphQL endpoint itself would.
    // Named after the GraphQL type: a shared input object is hoisted into the
    // rendered `definitions`, and without a name the entry is keyed by position
    // (`__schema0`), which strips the one piece of context an agent needs to
    // read a `where` argument. See {@link withName}.
    holder.schema = withName(z.object(shape).strict(), type.name);
    ctx.done.set(type.name, holder.schema);
    return holder.schema;
  }
  // Unreachable for valid input types; keep type-checking happy and fail soft.
  return z.any();
}

function describe(schema: AnyZodType, description?: string | null): AnyZodType {
  return description ? schema.describe(description) : schema;
}

/**
 * An argument or input field's default as the JSON a caller would actually
 * send, or `undefined` when it has none.
 *
 * The AST literal is preferred over the coerced `defaultValue` because the two
 * disagree exactly where it matters: an enum's *internal* value need not be its
 * SDL name, and the name is what crosses the wire as a GraphQL variable.
 * `valueFromASTUntyped` reads the literal without a type, which yields the name
 * for an enum and the plain JS value for everything else — precisely the JSON
 * form. A programmatically built schema carries no AST, so the coerced value is
 * the fallback.
 *
 * Exported for `argExample.ts`, which needs the same JSON form for the same
 * reason — an example printing an enum's internal value would be one an agent
 * cannot send. Not re-exported from `index.ts`.
 */
export function defaultJsonOf(source: GraphQLArgument | GraphQLInputField): unknown {
  const node = source.astNode?.defaultValue;
  if (node) return valueFromASTUntyped(node);
  return source.defaultValue;
}

/**
 * Attaches the JSON Schema `default` keyword when there is one to attach.
 * Advisory only — see {@link withDefault} for why this is metadata rather than
 * a Zod `.default()`.
 */
function withArgDefault(
  schema: AnyZodType,
  source: GraphQLArgument | GraphQLInputField,
): AnyZodType {
  const value = defaultJsonOf(source);
  return value === undefined ? schema : withDefault(schema, value);
}

/**
 * Builds a Zod raw shape (`{ argName: ZodType }`) from a GraphQL field's
 * arguments, ready to pass as a tool's `inputSchema`. Non-null args are required;
 * nullable args are optional. Each arg's GraphQL description is carried onto its
 * Zod type so it shows up in the tool's generated JSON Schema.
 *
 * @param args - The field's arguments (`field.args`).
 * @param options - Scalar mapping overrides.
 * @returns A Zod raw shape; empty (`{}`) for a field with no arguments.
 */
export function argsToZodShape(
  args: ReadonlyArray<GraphQLArgument>,
  options: ZodShapeOptions = {},
): ZodShape {
  // Both maps live for this call only: the memo is keyed by type name alone, and
  // a different `scalars` mapping or `nullBranches` setting would give the same
  // name a different schema.
  const ctx: Ctx = {
    pending: new Map(),
    done: new Map(),
    scalar: toResolver(options.scalars),
    nullBranches: options.nullBranches ?? 'always',
    inputField: options.inputField,
  };
  const shape: ZodShape = {};
  for (const arg of args) {
    shape[arg.name] = withArgDefault(
      describe(fieldToZod(arg.type, ctx, 'property'), arg.description),
      arg,
    );
  }
  return shape;
}
