/**
 * Derives a Zod schema for a field's GraphQL return type, a machine-readable companion to {@link buildSelectionSet}. It
 * walks the same `returnedFields` as `selection.ts` and always adds `__typename`, so the schema never describes a field
 * the query does not fetch.
 *
 * A list becomes `z.array(...)`, and a nullable field becomes `.nullable()` because GraphQL returns a selected nullable
 * field as `null` instead of leaving it out. The schema is a structural hint for descriptor introspection, not a
 * validator the server runs (see issue #15).
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
import { z } from 'zod';
import { TOOL_DEFAULTS } from '../core/defaults.ts';
import type { AnyZodType, ZodShape } from '../core/zod-compat.ts';
import {
  describe,
  enumSchema,
  type ScalarMapping,
  type ScalarResolver,
  scalarSchema,
  toResolver,
} from '../input/zod-schema.ts';
import { returnedFields } from './selection.ts';

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
  maxDepth = TOOL_DEFAULTS.selectionDepth,
  scalars?: ScalarMapping,
): AnyZodType {
  const scalar = toResolver(scalars);
  const inner = schemaFor(getNamedType(type), maxDepth, new Set(), scalar);
  return wrapField(type, inner ?? z.unknown());
}

/**
 * Returns the schema for a composite/leaf named type, or `undefined` for a non-selectable one.
 *
 * @param named - The type to describe, with list and non-null wrappers removed.
 * @param depth - Object levels left to describe.
 * @param path - Type names already on the way down to `named`.
 * @param scalar - The user's scalar mapping, as a resolver.
 * @returns The schema, or `undefined` for a union with no members or a type that is not an output type.
 */
function schemaFor(
  named: GraphQLNamedType,
  depth: number,
  path: ReadonlySet<string>,
  scalar: ScalarResolver,
): AnyZodType | undefined {
  if (isScalarType(named)) {
    return scalarSchema(named, scalar);
  }
  if (isEnumType(named)) {
    return enumSchema(named);
  }
  if (isUnionType(named)) {
    // The selection set emits an inline fragment per member, so a result matches
    // exactly one member — told apart by the `__typename` literal each carries.
    const members = named.getTypes().map((member) => z.object(compositeFields(member, depth, path, scalar)));
    const [first, second, ...rest] = members;
    if (!first) {
      return undefined;
    }
    if (!second) {
      return first;
    }
    return z.union([first, second, ...rest]);
  }
  if (isObjectType(named) || isInterfaceType(named)) {
    // An interface contributes its own fields only, matching `compositeFields`.
    return z.object(compositeFields(named, depth, path, scalar));
  }
  return undefined;
}

/**
 * Builds the shape for an object/interface type, always ending with `__typename`.
 *
 * @param type - The object or interface type whose fields are described.
 * @param depth - Object levels left, counting `type` itself.
 * @param path - Type names already on the way down to `type`.
 * @param scalar - The user's scalar mapping, as a resolver.
 * @returns A shape of the returned fields plus `__typename`, a literal for an object type and a string otherwise.
 */
function compositeFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  path: ReadonlySet<string>,
  scalar: ScalarResolver,
): ZodShape {
  const shape: ZodShape = {};
  for (const field of returnedFields(type, depth, path)) {
    const inner = schemaFor(field.named, field.depth, field.path, scalar);
    if (inner) {
      shape[field.name] = describe(wrapField(field.type, inner), field.description);
    }
  }
  shape.__typename = isObjectType(type) ? z.literal(type.name) : z.string();
  return shape;
}

/**
 * Applies a field type's nullability around `inner`: required for `NonNull`, else `.nullable()`.
 *
 * @param type - The field's type, wrappers included.
 * @param inner - The schema for the named type at the centre of `type`.
 * @returns `inner` with the list and nullability wrappers of `type` applied.
 */
function wrapField(type: GraphQLOutputType, inner: AnyZodType): AnyZodType {
  if (isNonNullType(type)) {
    return wrapBase(type.ofType, inner);
  }
  return wrapBase(type, inner).nullable();
}

/**
 * Applies a (nullability-stripped) type's list wrappers around the named-type schema.
 *
 * @param type - A list or named type, with no non-null wrapper on the outside.
 * @param inner - The schema for the named type at the centre of `type`.
 * @returns An array schema for a list type, otherwise `inner` unchanged.
 */
function wrapBase(type: GraphQLOutputType, inner: AnyZodType): AnyZodType {
  if (isListType(type)) {
    return z.array(wrapField(type.ofType, inner));
  }
  return inner;
}
