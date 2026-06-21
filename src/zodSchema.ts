/**
 * Converts a GraphQL field's arguments into a Zod "raw shape" — the input-schema
 * form the MCP SDK's `registerTool` expects. Written by hand (rather than pulling
 * in a graphql-to-zod dependency) because the mapping is small and we want full
 * control over nullability, descriptions, and custom-scalar fallbacks.
 *
 * Mapping rules:
 * - `NonNull` → required (no `.nullish()`); a nullable arg/field becomes `.nullish()`
 * - `List` → `z.array(element)`
 * - built-in scalars → `Int`/`Float` ⇒ number, `String`/`ID` ⇒ string, `Boolean` ⇒ boolean
 * - custom scalars → `z.any()` (the server still validates them) tagged with the scalar name
 * - enums → `z.enum([...names])` (enum *names*, the form passed as GraphQL variables)
 * - input objects → `z.object({...})`, recursively; a recursive input type falls back
 *   to `z.any()` once revisited (a pragmatic MVP guard — see TODO.md)
 */

import {
  type GraphQLArgument,
  type GraphQLInputType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql';
import { type ZodRawShape, type ZodTypeAny, z } from 'zod';

const SCALAR_BUILDERS: Record<string, () => ZodTypeAny> = {
  Int: () => z.number().int(),
  Float: () => z.number(),
  String: () => z.string(),
  Boolean: () => z.boolean(),
  ID: () => z.string(),
};

/** Applies an element/field type's nullability: required for `NonNull`, else `.nullish()`. */
function fieldToZod(type: GraphQLInputType, seen: ReadonlySet<string>): ZodTypeAny {
  if (isNonNullType(type)) {
    return baseToZod(type.ofType, seen);
  }
  return baseToZod(type, seen).nullish();
}

/** Builds the Zod type for a (already nullability-stripped) list/named GraphQL type. */
function baseToZod(type: GraphQLInputType, seen: ReadonlySet<string>): ZodTypeAny {
  if (isListType(type)) {
    return z.array(fieldToZod(type.ofType, seen));
  }
  if (isScalarType(type)) {
    const builder = SCALAR_BUILDERS[type.name];
    return builder ? builder() : z.any().describe(`Custom scalar ${type.name}`);
  }
  if (isEnumType(type)) {
    const names = type.getValues().map((value) => value.name);
    // An enum with no values can't happen in a valid schema, but guard the cast.
    return names.length ? z.enum(names as [string, ...string[]]) : z.string();
  }
  if (isInputObjectType(type)) {
    // Recursive input types (e.g. nested filter inputs) would recurse forever;
    // once a type reappears on the current path, fall back to an opaque value.
    if (seen.has(type.name)) {
      return z.any().describe(`Recursive input ${type.name}`);
    }
    const next = new Set(seen).add(type.name);
    const shape: ZodRawShape = {};
    for (const [name, field] of Object.entries(type.getFields())) {
      shape[name] = describe(fieldToZod(field.type, next), field.description);
    }
    return z.object(shape);
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
 * @returns A Zod raw shape; empty (`{}`) for a field with no arguments.
 */
export function argsToZodShape(args: ReadonlyArray<GraphQLArgument>): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const arg of args) {
    shape[arg.name] = describe(fieldToZod(arg.type, new Set()), arg.description);
  }
  return shape;
}
