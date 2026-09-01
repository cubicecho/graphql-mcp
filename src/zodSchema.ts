/**
 * Converts a GraphQL field's arguments into a Zod "raw shape" — the input-schema
 * form the MCP SDK's `registerTool` expects. Written by hand (rather than pulling
 * in a graphql-to-zod dependency) because the mapping is small and we want full
 * control over nullability, descriptions, and custom-scalar fallbacks.
 *
 * Mapping rules:
 * - `NonNull` → required (no `.nullish()`); a nullable arg/field becomes `.nullish()`
 * - `List` → `z.array(element)`
 * - scalars → the `scalars` option first, then the built-ins (`Int`/`Float` ⇒ number,
 *   `String`/`ID` ⇒ string, `Boolean` ⇒ boolean), then `z.any()` carrying the
 *   scalar's own SDL description (see {@link builtinScalar})
 * - enums → `z.enum([...names])` (enum *names*, the form passed as GraphQL variables)
 * - input objects → a strict `z.object({...})`, recursively; self-references become `z.lazy()`
 *   to model the recursion precisely instead of falling back to `z.any()`. Each
 *   named input type is built once per call and shared, so a type reached by
 *   several routes renders as one `$defs` entry rather than being expanded again
 *   at every site (see {@link Ctx}).
 */

import {
  type GraphQLArgument,
  type GraphQLInputType,
  type GraphQLScalarType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql';
import { z } from 'zod';
import type { AnyZodType, ZodShape } from './zodCompat.ts';

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

/** Options shared by the arg→Zod conversion. */
export interface ZodShapeOptions {
  /**
   * Zod schemas for GraphQL scalars, consulted **before** the built-ins — so
   * this can retype `ID`/`String` as well as fill in custom scalars. Provide the
   * *base* (non-null) schema; list/nullability wrapping is applied around it.
   */
  scalars?: ScalarMapping;
}

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

/** Recursion state: the input-object cycle guard, the memo, and the scalar mapper. */
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
}

/** Normalizes either mapping form into a single lookup function. */
export function toResolver(mapping: ScalarMapping | undefined): ScalarResolver {
  if (!mapping) return () => undefined;
  if (typeof mapping === 'function') return mapping;
  return (scalar) => mapping[scalar.name];
}

/** Applies an element/field type's nullability: required for `NonNull`, else `.nullish()`. */
function fieldToZod(type: GraphQLInputType, ctx: Ctx): AnyZodType {
  if (isNonNullType(type)) {
    return baseToZod(type.ofType, ctx);
  }
  return baseToZod(type, ctx).nullish();
}

/** Builds the Zod type for a (already nullability-stripped) list/named GraphQL type. */
function baseToZod(type: GraphQLInputType, ctx: Ctx): AnyZodType {
  if (isListType(type)) {
    return z.array(fieldToZod(type.ofType, ctx));
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
      shape[name] = describe(fieldToZod(field.type, ctx), field.description);
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
    holder.schema = z.object(shape).strict();
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
  // a different `scalars` mapping would give the same name a different schema.
  const ctx: Ctx = { pending: new Map(), done: new Map(), scalar: toResolver(options.scalars) };
  const shape: ZodShape = {};
  for (const arg of args) {
    shape[arg.name] = describe(fieldToZod(arg.type, ctx), arg.description);
  }
  return shape;
}
