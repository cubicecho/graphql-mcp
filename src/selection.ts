/**
 * Auto-generates a GraphQL selection set for a field's return type.
 *
 * A tool call has no way to ask the AI "which fields do you want back?", so we
 * select a sensible default: every scalar/enum leaf at each level, descending
 * into nested object/interface/union types up to `maxDepth`. `__typename` is
 * always included so the result is self-describing (and never an empty, invalid
 * selection set).
 *
 * Two things are deliberately skipped (see TODO.md): fields that require
 * arguments (we can't invent argument values) and types already on the current
 * path (cycle guard).
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
export function buildSelectionSet(type: GraphQLOutputType, maxDepth = 2): string {
  return selectionFor(getNamedType(type), maxDepth, new Set());
}

/** Returns a `{ ... }` block for a composite type, or `''` for a leaf. */
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

/** Joins the selectable fields of an object/interface type, always ending with `__typename`. */
function compositeFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  path: ReadonlySet<string>,
): string {
  const selected: string[] = [];
  const nextPath = new Set(path).add(type.name);
  for (const [name, field] of Object.entries(type.getFields())) {
    // Can't auto-select a field that requires arguments we don't have.
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
      continue;
    }
    const named = getNamedType(field.type);
    if (isScalarType(named) || isEnumType(named)) {
      selected.push(name);
      continue;
    }
    // A composite field: only descend if we have depth left and aren't cycling.
    if (depth <= 1 || path.has(named.name)) {
      continue;
    }
    const sub = selectionFor(named, depth - 1, nextPath);
    if (sub) {
      selected.push(`${name} ${sub}`);
    }
  }
  selected.push('__typename');
  return selected.join(' ');
}
