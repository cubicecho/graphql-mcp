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
 *   `String`/`ID` ⇒ string, `Boolean` ⇒ boolean), then `z.any()` tagged with the name
 * - enums → `z.enum([...names])` (enum *names*, the form passed as GraphQL variables)
 * - input objects → `z.object({...})`, recursively; self-references become `z.lazy()`
 *   to model the recursion precisely instead of falling back to `z.any()`.
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
import { type ZodRawShape, type ZodTypeAny, z } from 'zod';

/**
 * Zod schemas keyed by GraphQL scalar name — the same shape scalar-map
 * generators emit (e.g. `defaultScalarMap` from `@vantreeseba/graphql-zod`), so
 * one can be spread in directly.
 */
export type ScalarMap = Record<string, ZodTypeAny>;

/**
 * Dynamic form of {@link ScalarMap}: return a schema for the scalar, or
 * `undefined` to fall through to the built-in mapping.
 */
export type ScalarResolver = (scalar: GraphQLScalarType) => ZodTypeAny | undefined;

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

const SCALAR_BUILDERS: Record<string, () => ZodTypeAny> = {
  Int: () => z.number().int(),
  Float: () => z.number(),
  String: () => z.string(),
  Boolean: () => z.boolean(),
  ID: () => z.string(),
};

/** Recursion state: the input-object cycle guard plus the resolved scalar mapper. */
interface Ctx {
  /**
   * Input objects whose shape is still being built, keyed by type name. A
   * self-reference found while building links back to the same `z.lazy` node
   * instead of recursing forever.
   */
  pending: Map<string, ZodTypeAny>;
  scalar: ScalarResolver;
}

/** Normalizes either mapping form into a single lookup function. */
export function toResolver(mapping: ScalarMapping | undefined): ScalarResolver {
  if (!mapping) return () => undefined;
  if (typeof mapping === 'function') return mapping;
  return (scalar) => mapping[scalar.name];
}

/** Applies an element/field type's nullability: required for `NonNull`, else `.nullish()`. */
function fieldToZod(type: GraphQLInputType, ctx: Ctx): ZodTypeAny {
  if (isNonNullType(type)) {
    return baseToZod(type.ofType, ctx);
  }
  return baseToZod(type, ctx).nullish();
}

/** Builds the Zod type for a (already nullability-stripped) list/named GraphQL type. */
function baseToZod(type: GraphQLInputType, ctx: Ctx): ZodTypeAny {
  if (isListType(type)) {
    return z.array(fieldToZod(type.ofType, ctx));
  }
  if (isScalarType(type)) {
    // User mapping wins over the built-ins so `ID`/`String` can be retyped.
    const mapped = ctx.scalar(type);
    if (mapped) return mapped;
    const builder = SCALAR_BUILDERS[type.name];
    return builder ? builder() : z.any().describe(`Custom scalar ${type.name}`);
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
    const pending = ctx.pending.get(type.name);
    if (pending) return pending;
    const holder: { schema?: ZodTypeAny } = {};
    // `z.lazy` defers its getter until parse time, which is always after this
    // call returns and sets `holder.schema` — so the cast can't observe undefined.
    ctx.pending.set(
      type.name,
      z.lazy(() => holder.schema as ZodTypeAny),
    );
    const shape: ZodRawShape = {};
    for (const [name, field] of Object.entries(type.getFields())) {
      shape[name] = describe(fieldToZod(field.type, ctx), field.description);
    }
    ctx.pending.delete(type.name);
    holder.schema = z.object(shape);
    return holder.schema;
  }
  // Unreachable for valid input types; keep type-checking happy and fail soft.
  return z.any();
}

function describe(schema: ZodTypeAny, description?: string | null): ZodTypeAny {
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
): ZodRawShape {
  const ctx: Ctx = { pending: new Map(), scalar: toResolver(options.scalars) };
  const shape: ZodRawShape = {};
  for (const arg of args) {
    shape[arg.name] = describe(fieldToZod(arg.type, ctx), arg.description);
  }
  return shape;
}
