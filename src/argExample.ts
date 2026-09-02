/**
 * Renders a compact JSON literal showing the shape one argument expects.
 *
 * A generated tool already carries the answer in its `inputSchema` — and that is
 * precisely the problem. On a real surface the JSON Schema is hundreds of
 * kilobytes of which a couple of percent is prose, and a model reads the prose.
 * Measured against a hand-written arm on the same schema, every failed call was
 * the same mistake: an argument's shape guessed from its name
 * (`orderBy: { startedAt: "desc" }` for a type that is really
 * `{ <column>: { direction, priority } }`). The schema said so. Nothing read it.
 *
 * So the shape goes where the reading happens. This module walks
 * `GraphQLInputType` only — no zod, no SDK — so what it prints cannot vary
 * across the zod peer range.
 *
 * **A truncated example is worse than none.** An example missing a required
 * field is valid-looking JSON the server rejects, which is the failure this
 * exists to remove rather than relocate. So depth bounds *optional* expansion
 * only; every non-null field is expanded however deep it goes, and if one cannot
 * be expanded — the only case is a cycle — the whole example is abandoned.
 */

import type {
  GraphQLArgument,
  GraphQLInputField,
  GraphQLInputType,
  GraphQLNamedType,
} from 'graphql';
import { getNamedType, isEnumType, isInputObjectType, isListType, isNonNullType } from 'graphql';
import { defaultJsonOf } from './zodSchema.ts';

/**
 * How many levels of *optional* expansion an example may use. Three is enough
 * for the shape that motivated this (`orderBy: [{ column: { direction } }]`)
 * without inviting a walk of a filter type's whole neighbourhood.
 */
export const DEFAULT_EXAMPLE_DEPTH = 3;

/**
 * Longest example that still earns its place in a description. Past this an
 * example stops being a hint and becomes the schema again, in a second syntax.
 */
export const MAX_EXAMPLE_CHARS = 300;

/** Rendering could not produce something a caller could actually send. */
const ABANDON = Symbol('abandon');

/**
 * The example for an input type, as JSON, or `undefined` when there isn't a
 * useful one: the type isn't an input object, the budget is spent, the result
 * would be an empty object, or it grew past {@link MAX_EXAMPLE_CHARS}.
 */
export function exampleForType(
  type: GraphQLInputType,
  depth: number = DEFAULT_EXAMPLE_DEPTH,
): string | undefined {
  if (depth < 1) return undefined;
  if (!isInputObjectType(getNamedType(type))) return undefined;
  const value = renderType(type, depth, new Set());
  if (value === ABANDON) return undefined;
  const json = JSON.stringify(value);
  // `{}` and `[{}]` are the shapes that teach nothing — an all-optional object
  // whose budget ran out before its first field.
  if (json === undefined || json === '{}' || json === '[{}]') return undefined;
  return json.length > MAX_EXAMPLE_CHARS ? undefined : json;
}

/**
 * The example for one argument, or `undefined` when it would not help.
 *
 * An argument carrying its own object or list default is skipped: the
 * description already prints that default as the GraphQL literal a caller would
 * write, and two literals in two syntaxes on adjacent lines read as one.
 */
export function buildArgExample(
  arg: GraphQLArgument,
  depth: number = DEFAULT_EXAMPLE_DEPTH,
): string | undefined {
  const fallback = defaultJsonOf(arg);
  if (fallback !== null && typeof fallback === 'object') return undefined;
  return exampleForType(arg.type, depth);
}

/** One position's value: a list wraps a single element, everything else is itself. */
function renderType(
  type: GraphQLInputType,
  depth: number,
  path: ReadonlySet<string>,
): unknown | typeof ABANDON {
  if (isNonNullType(type)) return renderType(type.ofType, depth, path);
  // One element is the whole lesson: a second would only repeat it at double
  // the width, and the budget is spent on nesting instead.
  if (isListType(type)) {
    const element = renderType(type.ofType, depth, path);
    return element === ABANDON ? ABANDON : [element];
  }
  return renderNamed(type, depth, path);
}

function renderNamed(
  type: GraphQLNamedType,
  depth: number,
  path: ReadonlySet<string>,
): unknown | typeof ABANDON {
  if (!isInputObjectType(type)) return leafValue(type);
  // A type that contains itself has no finite literal. Reached through a
  // non-null field this abandons the example; through the optional fallback
  // below it merely drops that field.
  if (path.has(type.name)) return ABANDON;
  const nextPath = new Set(path).add(type.name);
  const fields = Object.values(type.getFields());
  const shape: Record<string, unknown> = {};
  let required = 0;

  for (const field of fields) {
    if (!isNonNullType(field.type)) continue;
    required += 1;
    const value = renderField(field, depth, nextPath);
    // A required field we cannot render means the example would be rejected on
    // arrival. Better to print nothing than to teach a call that fails.
    if (value === ABANDON) return ABANDON;
    shape[field.name] = value;
  }

  // An all-optional object renders `{}` under a required-only rule, which is
  // the whole failure again — `orderBy` is an optional outer object wrapping a
  // required inner one. Show its first field so the nesting is visible. This is
  // the only expansion `depth` bounds, because it is the only one that could
  // otherwise walk a filter type's entire neighbourhood.
  const [first] = fields;
  if (required === 0 && first && depth >= 1) {
    const value = renderField(first, depth - 1, nextPath);
    // A fallback rendering `{}` names the key and shows nothing inside it — the
    // budget ran out before the nesting the fallback exists to reveal. Dropping
    // it lets the emptiness propagate, so the example is suppressed outright
    // rather than shipped half-built.
    if (value !== ABANDON && !isEmptyShape(value)) shape[first.name] = value;
  }
  return shape;
}

/** `{}` or `[{}]` — structurally present, informationally absent. */
function isEmptyShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 1 && isEmptyShape(value[0]);
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(value).length === 0;
}

/** A field's own default wins: it is both accurate and what the server assumes. */
function renderField(
  field: GraphQLInputField,
  depth: number,
  path: ReadonlySet<string>,
): unknown | typeof ABANDON {
  const fallback = defaultJsonOf(field);
  if (fallback !== undefined) return fallback;
  return renderType(field.type, depth, path);
}

/**
 * A placeholder for a scalar or enum position.
 *
 * The enum case is the one that pays for itself: an agent shown `"desc"` where
 * the schema means `DESC` writes the string it saw. The first member is not
 * chosen for meaning — it is there so the *spelling* is unambiguous.
 */
function leafValue(type: GraphQLNamedType): unknown {
  if (isEnumType(type)) return type.getValues()[0]?.name ?? 'string';
  switch (type.name) {
    case 'Int':
    case 'Float':
      return 0;
    case 'Boolean':
      return true;
    case 'String':
    case 'ID':
      return 'string';
    // A custom scalar's wire format lives in its SDL description, which the
    // argument line already carries; naming the type points there.
    default:
      return `<${type.name}>`;
  }
}
