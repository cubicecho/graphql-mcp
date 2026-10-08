/**
 * Renders a compact JSON literal showing the shape one argument expects.
 *
 * This module walks `GraphQLInputType` only, with no zod and no SDK, so what it prints cannot vary across the zod peer
 * range. Depth bounds optional expansion only, because an example missing a required field is one the server rejects.
 * A non-null field that cannot be expanded, which only a cycle causes, abandons the whole example.
 */

import type { GraphQLArgument, GraphQLInputField, GraphQLInputType, GraphQLNamedType } from 'graphql';
import { getNamedType, isEnumType, isInputObjectType, isListType, isNonNullType } from 'graphql';
import { TOOL_DEFAULTS } from '../core/defaults.ts';
import { defaultJsonOf } from './zod-schema.ts';

/**
 * Longest example that still earns its place in a description. Past this an
 * example stops being a hint and becomes the schema again, in a second syntax.
 */
export const MAX_EXAMPLE_CHARS = 300;

/** What stands in for each built-in scalar in an example. */
const SCALAR_PLACEHOLDERS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Int', 0],
  ['Float', 0],
  ['Boolean', true],
  ['String', 'string'],
  ['ID', 'string'],
]);

/** Rendering could not produce something a caller could actually send. */
const ABANDON = Symbol('abandon');

/**
 * The example for an input type, as JSON, or `undefined` when there isn't a
 * useful one: the type isn't an input object, the budget is spent, the result
 * would be an empty object, or it grew past {@link MAX_EXAMPLE_CHARS}.
 *
 * @param type - The input type to show, wrappers included.
 * @param [depth] - How many levels of optional fields to expand. Below 1 there is no example.
 * @returns The example as JSON text of at most `MAX_EXAMPLE_CHARS` characters, or `undefined`.
 */
export function exampleForType(type: GraphQLInputType, depth: number = TOOL_DEFAULTS.exampleDepth): string | undefined {
  if (depth < 1) {
    return undefined;
  }
  if (isInputObjectType(getNamedType(type)) === false) {
    return undefined;
  }
  const value = renderType(type, depth, new Set(), true);
  if (value === ABANDON) {
    return undefined;
  }
  const json = JSON.stringify(value);
  // `{}` and `[{}]` are the shapes that teach nothing — an all-optional object
  // whose budget ran out before its first field.
  if (json === undefined || json === '{}' || json === '[{}]') {
    return undefined;
  }
  return json.length > MAX_EXAMPLE_CHARS ? undefined : json;
}

/**
 * The example for one argument, or `undefined` when it would not help.
 *
 * An argument carrying its own object or list default is skipped: the
 * description already prints that default as the GraphQL literal a caller would
 * write, and two literals in two syntaxes on adjacent lines read as one.
 *
 * @param arg - The argument to show an example for.
 * @param [depth] - How many levels of optional fields to expand. Below 1 there is no example.
 * @returns The example as JSON text, or `undefined` when there is no useful one.
 */
export function buildArgExample(arg: GraphQLArgument, depth: number = TOOL_DEFAULTS.exampleDepth): string | undefined {
  const fallback = defaultJsonOf(arg);
  if (fallback !== null && typeof fallback === 'object') {
    return undefined;
  }
  return exampleForType(arg.type, depth);
}

/**
 * One position's value: a list wraps a single element, everything else is
 * itself. `top` marks the argument's own type — list wrappers included, since
 * `[UpdateTaskInput]` is the same argument in a list — and only reaches the
 * all-optional fallback in {@link renderNamed}, which is stricter there.
 *
 * @param type - The input type in this position, wrappers included.
 * @param depth - Levels of optional expansion left.
 * @param path - Names of the input objects being rendered above this position, used to detect a cycle.
 * @param [top] - Whether this is the argument's own type and not a nested field's.
 * @returns The value to serialize, or `ABANDON` when no sendable value exists.
 */
function renderType(
  type: GraphQLInputType,
  depth: number,
  path: ReadonlySet<string>,
  top = false,
): unknown | typeof ABANDON {
  if (isNonNullType(type)) {
    return renderType(type.ofType, depth, path, top);
  }
  // One element is the whole lesson: a second would only repeat it at double
  // the width, and the budget is spent on nesting instead.
  if (isListType(type)) {
    const element = renderType(type.ofType, depth, path, top);
    return element === ABANDON ? ABANDON : [element];
  }
  return renderNamed(type, depth, path, top);
}

/**
 * Renders the value for a named type: a placeholder for a scalar or enum, or an object holding every required field.
 * An object with no required fields shows its first field instead, when that field is worth showing.
 *
 * @param type - The type in this position, with list and non-null wrappers removed.
 * @param depth - Levels of optional expansion left.
 * @param path - Names of the input objects being rendered above this position, used to detect a cycle.
 * @param [top] - Whether this is the argument's own type and not a nested field's.
 * @returns The value to serialize, or `ABANDON` when the type contains itself or a required field cannot be rendered.
 */
function renderNamed(
  type: GraphQLNamedType,
  depth: number,
  path: ReadonlySet<string>,
  top = false,
): unknown | typeof ABANDON {
  if (isInputObjectType(type) === false) {
    return leafValue(type);
  }
  // A type that contains itself has no finite literal. A non-null field abandons the example on this, and the
  // optional fallback below drops only that field.
  if (path.has(type.name)) {
    return ABANDON;
  }
  const nextPath = new Set(path).add(type.name);
  const fields = Object.values(type.getFields());
  const shape: Record<string, unknown> = {};
  let required = 0;

  for (const field of fields) {
    if (isNonNullType(field.type) === false) {
      continue;
    }
    required += 1;
    const value = renderField(field, depth, nextPath);
    // A required field we cannot render means the example would be rejected on
    // arrival. Better to print nothing than to teach a call that fails.
    if (value === ABANDON) {
      return ABANDON;
    }
    shape[field.name] = value;
  }

  // An all-optional object would render `{}`, so show its first field to make the nesting visible. This is the only
  // expansion `depth` bounds.
  const [first] = fields;
  if (required === 0 && first && depth >= 1) {
    const value = renderField(first, depth - 1, nextPath);
    // Drop a fallback that rendered empty, so the example is suppressed instead of shipped half-built. A scalar is
    // dropped only at the top level, where it names one arbitrary key, and deeper down it is the nesting being shown.
    const worthShowing = !top || isStructural(value);
    if (value !== ABANDON && worthShowing && isEmptyShape(value) === false) {
      shape[first.name] = value;
    }
  }
  return shape;
}

/**
 * An object or a list — a value with an inside worth showing.
 *
 * @param value - A rendered example value.
 * @returns `true` for an object or an array, `false` for a scalar or `null`.
 */
function isStructural(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * `{}` or `[{}]` — structurally present, informationally absent.
 *
 * @param value - A rendered example value.
 * @returns `true` for an object with no keys, or a one-element array holding an empty shape.
 */
function isEmptyShape(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 1 && isEmptyShape(value[0]);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.keys(value).length === 0;
}

/**
 * A field's own default wins: it is both accurate and what the server assumes.
 *
 * @param field - The input field to render.
 * @param depth - Levels of optional expansion left.
 * @param path - Names of the input objects being rendered above this field, used to detect a cycle.
 * @returns The field's default when it has one, otherwise the rendered value or `ABANDON`.
 */
function renderField(field: GraphQLInputField, depth: number, path: ReadonlySet<string>): unknown | typeof ABANDON {
  const fallback = defaultJsonOf(field);
  if (fallback !== undefined) {
    return fallback;
  }
  return renderType(field.type, depth, path);
}

/**
 * A placeholder for a scalar or enum position.
 *
 * The enum case is the one that pays for itself: an agent shown `"desc"` where
 * the schema means `DESC` writes the string it saw. The first member is not
 * chosen for meaning — it is there so the *spelling* is unambiguous.
 *
 * @param type - A scalar or enum type.
 * @returns The first enum value's name, the built-in scalar's placeholder, or `<TypeName>` for a custom scalar.
 */
function leafValue(type: GraphQLNamedType): unknown {
  if (isEnumType(type)) {
    return type.getValues()[0]?.name ?? 'string';
  }
  // A custom scalar's wire format lives in its SDL description, which the
  // argument line already carries; naming the type points there.
  return SCALAR_PLACEHOLDERS.has(type.name) ? SCALAR_PLACEHOLDERS.get(type.name) : `<${type.name}>`;
}
