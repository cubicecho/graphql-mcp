/**
 * Auto-generates a GraphQL selection set for a field's return type, because a tool call cannot ask which fields the
 * caller wants. It selects every scalar and enum leaf at each level and descends into object, interface and union types
 * up to `maxDepth`, always adding `__typename` so the selection is never empty.
 *
 * It skips fields that require arguments and types already on the current path (issue #12), and an interface
 * contributes only its own fields (issue #11). `returnedFields` holds these rules once, for this module and for
 * `output-schema.ts`.
 */

import {
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  getNamedType,
  isEnumType,
  isInterfaceType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import { TOOL_DEFAULTS } from '../core/defaults.ts';

/**
 * Builds a selection set string (e.g. `{ id name author { id __typename } }`)
 * for a field's return `type`. Returns `''` when the type is a scalar/enum leaf
 * (such a field takes no selection set).
 *
 * @param type - The field's return type (wrappers are unwrapped automatically).
 * @param maxDepth - How many object levels deep to select. `1` = leaf fields of
 *   the return type only; `2` (default) also expands one level of nested objects.
 * @returns The selection set string, or `''` for a leaf return type.
 */
export function buildSelectionSet(type: GraphQLOutputType, maxDepth = TOOL_DEFAULTS.selectionDepth): string {
  return selectionFor(getNamedType(type), maxDepth, new Set());
}

/**
 * Returns a `{ ... }` block for a composite type, or `''` for a leaf.
 *
 * @param named - The type to select from, with list and non-null wrappers removed.
 * @param depth - Object levels left to select.
 * @param path - Type names already on the way down to `named`.
 * @returns The braced selection, or `''` for a scalar or enum.
 */
function selectionFor(named: GraphQLNamedType, depth: number, path: ReadonlySet<string>): string {
  if (isScalarType(named) || isEnumType(named)) {
    return '';
  }
  if (isUnionType(named)) {
    const parts = ['__typename'];
    for (const member of named.getTypes()) {
      parts.push(`... on ${member.name} { ${compositeFields(member, depth, path)} }`);
    }
    return `{ ${parts.join(' ')} }`;
  }
  if (isObjectType(named) || isInterfaceType(named)) {
    return `{ ${compositeFields(named, depth, path)} }`;
  }
  return '';
}

/** One field the returnable-field walk kept, with what a renderer needs to descend into it. */
export interface ReturnedField {
  /** The field's name on its parent type. */
  name: string;
  /** The field's declared return type, wrappers included. */
  type: GraphQLOutputType;
  /** Its description from the schema, if any. */
  description: string | null | undefined;
  /** The return type with list and non-null wrappers removed. */
  named: GraphQLNamedType;
  /** `true` for a scalar or enum, which takes no selection of its own. */
  isLeaf: boolean;
  /** Object levels left for rendering `named`. */
  depth: number;
  /** Type names already on the way down to `named`. */
  path: ReadonlySet<string>;
}

/**
 * Decides which fields of a composite type come back. This is the single rule
 * set behind both the selection set and the output schema describing it.
 *
 * @param type - The object or interface type whose fields are walked.
 * @param depth - Object levels left, counting `type` itself.
 * @param path - Type names already on the way down to `type`.
 * @returns The kept fields in schema order; `__typename` is the renderer's to add.
 */
export function returnedFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  path: ReadonlySet<string>,
): ReturnedField[] {
  const returned: ReturnedField[] = [];
  const nextPath = new Set(path).add(type.name);
  for (const [name, field] of Object.entries(type.getFields())) {
    // Can't auto-select a field that requires arguments we don't have.
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
      continue;
    }
    const named = getNamedType(field.type);
    const shared = { name, type: field.type, description: field.description, named };
    if (isScalarType(named) || isEnumType(named)) {
      returned.push({ ...shared, isLeaf: true, depth, path });
      continue;
    }
    // A composite field: only descend if we have depth left and aren't cycling.
    if (depth <= 1 || path.has(named.name)) {
      continue;
    }
    returned.push({ ...shared, isLeaf: false, depth: depth - 1, path: nextPath });
  }
  return returned;
}

/**
 * Joins the selectable fields of an object/interface type, always ending with `__typename`.
 *
 * @param type - The object or interface type whose fields are selected.
 * @param depth - Object levels left, counting `type` itself.
 * @param path - Type names already on the way down to `type`.
 * @returns The field selections separated by spaces, without the surrounding braces.
 */
function compositeFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  path: ReadonlySet<string>,
): string {
  const selected: string[] = [];
  for (const field of returnedFields(type, depth, path)) {
    const sub = selectionFor(field.named, field.depth, field.path);
    if (field.isLeaf) {
      selected.push(field.name);
    } else if (sub) {
      selected.push(`${field.name} ${sub}`);
    }
  }
  selected.push('__typename');
  return selected.join(' ');
}
