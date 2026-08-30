/**
 * Derives a Zod schema for a field's GraphQL *return* type — a machine-readable
 * companion to {@link buildSelectionSet}.
 *
 * It must mirror `selection.ts` exactly, because the selection set is what the
 * tool actually asks for: a schema describing fields the query never fetches
 * would be a lie. So the same three rules apply, for the same reasons — fields
 * requiring arguments are skipped, composite fields past `maxDepth` or already
 * on the current path are *omitted* (not stubbed), and `__typename` is always
 * present.
 *
 * Wrappers are carried over faithfully: `List` → `z.array(...)`, `NonNull` →
 * required, and a nullable field → `.nullable()` (GraphQL includes a selected
 * nullable field in the response as `null`, so it is never simply absent).
 *
 * This is a structural *hint* for descriptor introspection, not a validator the
 * server runs — see TODO.md on registering it with the MCP SDK.
 */

import {
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  getNamedType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import { type ZodRawShape, type ZodTypeAny, z } from 'zod';
import { type ScalarMapping, type ScalarResolver, toResolver } from './zodSchema.ts';

const SCALAR_BUILDERS: Record<string, () => ZodTypeAny> = {
  Int: () => z.number().int(),
  Float: () => z.number(),
  String: () => z.string(),
  Boolean: () => z.boolean(),
  ID: () => z.string(),
};

/**
 * Builds the Zod schema for a field's return `type`, mirroring the selection set
 * `buildSelectionSet` generates for that same type and depth.
 *
 * @param type - The field's return type (wrappers are handled, not stripped).
 * @param maxDepth - How many object levels deep to describe. `1` = leaf fields of
 *   the return type only; `2` (default) also expands one level of nested objects.
 *   Pass the same value used for the selection set.
 * @param scalars - Optional scalar mapping, so custom scalars are typed on the
 *   output side the same way they are on the input side.
 * @returns A Zod schema for the return type; `z.string()`, `z.array(...)` etc.
 */
export function buildOutputSchema(
  type: GraphQLOutputType,
  maxDepth = 2,
  scalars?: ScalarMapping,
): ZodTypeAny {
  const scalar = toResolver(scalars);
  const inner = schemaFor(getNamedType(type), maxDepth, new Set(), scalar);
  return wrapField(type, inner ?? z.unknown());
}

/** Returns the schema for a composite/leaf named type, or `undefined` for a non-selectable one. */
function schemaFor(
  named: GraphQLNamedType,
  depth: number,
  path: ReadonlySet<string>,
  scalar: ScalarResolver,
): ZodTypeAny | undefined {
  if (isScalarType(named)) {
    // The user mapping wins over the built-ins, exactly as on the input side.
    const mapped = scalar(named);
    if (mapped) return mapped;
    const builder = SCALAR_BUILDERS[named.name];
    return builder ? builder() : z.any().describe(`Custom scalar ${named.name}`);
  }
  if (isEnumType(named)) {
    const names = named.getValues().map((value) => value.name);
    return names.length ? z.enum(names as [string, ...string[]]) : z.string();
  }
  if (isUnionType(named)) {
    // The selection set emits an inline fragment per member, so a result matches
    // exactly one member — told apart by the `__typename` literal each carries.
    const members = named
      .getTypes()
      .map((member) => z.object(compositeFields(member, depth, path, scalar)));
    const [first, second, ...rest] = members;
    if (!first) return undefined;
    if (!second) return first;
    return z.union([first, second, ...rest]);
  }
  if (isObjectType(named) || isInterfaceType(named)) {
    // An interface contributes its own fields only, matching `compositeFields`.
    return z.object(compositeFields(named, depth, path, scalar));
  }
  return undefined;
}

/** Builds the shape for an object/interface type, always ending with `__typename`. */
function compositeFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  path: ReadonlySet<string>,
  scalar: ScalarResolver,
): ZodRawShape {
  const shape: ZodRawShape = {};
  const nextPath = new Set(path).add(type.name);
  for (const [name, field] of Object.entries(type.getFields())) {
    // Can't auto-select a field that requires arguments we don't have.
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
      continue;
    }
    const named = getNamedType(field.type);
    if (isScalarType(named) || isEnumType(named)) {
      const leaf = schemaFor(named, depth, path, scalar);
      if (leaf) shape[name] = describe(wrapField(field.type, leaf), field.description);
      continue;
    }
    // A composite field: only descend if we have depth left and aren't cycling.
    // Otherwise it is left out entirely — the query won't select it either.
    if (depth <= 1 || path.has(named.name)) {
      continue;
    }
    const sub = schemaFor(named, depth - 1, nextPath, scalar);
    if (sub) {
      shape[name] = describe(wrapField(field.type, sub), field.description);
    }
  }
  shape.__typename = isObjectType(type) ? z.literal(type.name) : z.string();
  return shape;
}

/** Applies a field type's nullability around `inner`: required for `NonNull`, else `.nullable()`. */
function wrapField(type: GraphQLOutputType, inner: ZodTypeAny): ZodTypeAny {
  if (isNonNullType(type)) {
    return wrapBase(type.ofType, inner);
  }
  return wrapBase(type, inner).nullable();
}

/** Applies a (nullability-stripped) type's list wrappers around the named-type schema. */
function wrapBase(type: GraphQLOutputType, inner: ZodTypeAny): ZodTypeAny {
  if (isListType(type)) {
    return z.array(wrapField(type.ofType, inner));
  }
  return inner;
}

function describe(schema: ZodTypeAny, description?: string | null): ZodTypeAny {
  return description ? schema.describe(description) : schema;
}
