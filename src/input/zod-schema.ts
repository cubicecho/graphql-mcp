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
  type GraphQLEnumType,
  type GraphQLInputField,
  type GraphQLInputObjectType,
  type GraphQLInputType,
  type GraphQLNamedInputType,
  type GraphQLScalarType,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  valueFromASTUntyped,
} from 'graphql';
import { z } from 'zod';
import { DEFAULT_NULL_BRANCHES } from '../core/defaults.ts';
import { packageError } from '../core/errors.ts';
import { NullBranches } from '../core/types.ts';
import { type AnyZodType, withDefault, withName, type ZodShape } from '../core/zod-compat.ts';

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
 * A null-branch mode for {@link ZodShapeOptions.nullBranches} chosen per named type, rather than one mode for a whole
 * field.
 *
 * The type handed to `byType` is the named type in the position, after stripping non-null and list wrappers, not the
 * input object that contains it. Keying by the container could not govern a top-level argument such as `where`, which
 * has no containing input type. Scalars and enums are passed too.
 */
export interface NullBranchesByType {
  byType: (type: GraphQLNamedInputType) => NullBranches;
}

/** Either spelling of the null-branch mode. See {@link NullBranchesByType}. */
export type NullBranchesSetting = NullBranches | NullBranchesByType;

/**
 * The mode governing one input position.
 *
 * Exported so the description renderer resolves it the same way the schema
 * builder does — prose that warns about sending an explicit `null` where the
 * schema now rejects one is a tool that lies about itself.
 *
 * @param setting - The configured mode, or `undefined` to use the default mode.
 * @param type - The type in the position. Its list and non-null wrappers are removed before `byType` is asked.
 * @returns `'always'` or `'never'` for that position.
 */
export function branchesAt(setting: NullBranchesSetting | undefined, type: GraphQLInputType): NullBranches {
  if (setting === undefined) {
    return DEFAULT_NULL_BRANCHES;
  }
  return typeof setting === 'string' ? setting : setting.byType(getNamedType(type));
}

/** Options shared by the arg→Zod conversion. */
export interface ZodShapeOptions {
  /**
   * Zod schemas for GraphQL scalars, consulted **before** the built-ins — so
   * this can retype `ID`/`String` as well as fill in custom scalars. Provide the
   * *base* (non-null) schema; list/nullability wrapping is applied around it.
   */
  scalars?: ScalarMapping;
  /**
   * Whether a nullable input position advertises an explicit `null` branch. The default is `'always'`.
   *
   * `'never'` exists because the branch roughly doubles the node count of a filter-heavy schema, and a nullable `$ref`
   * has no legal draft-07 rendering. It makes an explicit `null` a validation error, which breaks the mutation idiom
   * of passing `null` to clear a field (`updateUser(bio: null)`).
   */
  nullBranches?: NullBranchesSetting;
  /**
   * Whether a field of an input object is advertised at all. Return `false` to prune it.
   *
   * ```ts
   * // drop relation filters from the MCP projection; the API keeps them
   * inputField: (field) => !/ListRelationFilter/.test(String(field.type))
   * ```
   *
   * It must be a pure function of the type, because input objects are cached and named by GraphQL type name alone, so
   * a prune that varied by route would throw `Duplicate schema id` during JSON Schema conversion. Pruning a non-null
   * field throws, because the server still requires it and every call would be rejected.
   */
  inputField?: InputFieldFilter;
}

/**
 * Decides whether one field of an input object is advertised. See
 * {@link ZodShapeOptions.inputField}.
 */
export type InputFieldFilter = (field: GraphQLInputField, parent: GraphQLInputObjectType) => boolean;

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
 * a format the schema spells out. Shared with `output-schema.ts` so both sides
 * describe a scalar identically.
 *
 * @param type - The scalar type to map.
 * @returns The built-in schema, or `z.any()` described with the scalar name and its SDL description.
 */
export function builtinScalar(type: GraphQLScalarType): AnyZodType {
  const builder = SCALAR_BUILDERS[type.name];
  if (builder) {
    return builder();
  }
  const hint = type.description?.trim();
  return z.any().describe(hint ? `Custom scalar ${type.name} — ${hint}` : `Custom scalar ${type.name}`);
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
   * Input objects already built, keyed by type name, so the same Zod instance is returned every time a type is met
   * again.
   *
   * `toJSONSchema` deduplicates by instance, so sharing it renders a repeated type as one `$defs` entry instead of
   * expanding it at every site. Without it, one real `where` argument rendered at 2.8 MB and its tool listing at 18 MB.
   */
  done: Map<string, AnyZodType>;
  scalar: ScalarResolver;
  nullBranches: NullBranchesSetting;
  inputField: InputFieldFilter | undefined;
}

/**
 * Normalizes either mapping form into a single lookup function.
 *
 * @param mapping - A record keyed by scalar name, a resolver function, or `undefined` for no overrides.
 * @returns A resolver that gives `undefined` for a scalar the mapping does not cover.
 */
export function toResolver(mapping: ScalarMapping | undefined): ScalarResolver {
  if (!mapping) {
    return () => undefined;
  }
  if (typeof mapping === 'function') {
    return mapping;
  }
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
 *
 * @param type - The input type, with its non-null wrapper still on.
 * @param ctx - The recursion state shared across one conversion.
 * @param position - `'property'` for an argument or input field, `'element'` for a member of a list.
 * @returns The schema for the type with its nullability applied.
 */
function fieldToZod(type: GraphQLInputType, ctx: Ctx, position: 'property' | 'element'): AnyZodType {
  if (isNonNullType(type)) {
    return baseToZod(type.ofType, ctx);
  }
  const base = baseToZod(type, ctx);
  if (position === 'element') {
    return base.nullable();
  }
  return branchesAt(ctx.nullBranches, type) === NullBranches.never ? base.optional() : base.nullish();
}

/**
 * Builds the Zod type for a (already nullability-stripped) list/named GraphQL type.
 *
 * @param type - A list or named input type, with no non-null wrapper on the outside.
 * @param ctx - The recursion state shared across one conversion.
 * @returns An array, scalar, enum or strict object schema, or `z.any()` for a type that is none of these.
 */
function baseToZod(type: GraphQLInputType, ctx: Ctx): AnyZodType {
  if (isListType(type)) {
    return z.array(fieldToZod(type.ofType, ctx, 'element'));
  }
  if (isScalarType(type)) {
    return scalarSchema(type, ctx.scalar);
  }
  if (isEnumType(type)) {
    return enumSchema(type);
  }
  if (isInputObjectType(type)) {
    // A finished type is reused outright. One still being built resolves to its `z.lazy` placeholder, which is what
    // makes a cycle terminate.
    const built = ctx.done.get(type.name);
    if (built) {
      return built;
    }
    const pending = ctx.pending.get(type.name);
    if (pending) {
      return pending;
    }
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
        // A pruned non-null field would advertise a tool the server rejects on every call, so refuse at build time.
        if (isNonNullType(field.type)) {
          throw packageError(
            `\`inputField\` pruned \`${type.name}.${name}\`, which is non-null. ` +
              'The GraphQL server still requires it, so every call to a tool using this type ' +
              'would fail. Keep the field, or make it nullable in the schema.',
          );
        }
        // Never walked, so nothing it referenced is reachable either — a type
        // reached only through a pruned field never enters `definitions`.
        continue;
      }
      shape[name] = withArgDefault(describe(fieldToZod(field.type, ctx, 'property'), field.description), field);
    }
    ctx.pending.delete(type.name);
    // `.strict()` makes an unknown key an error that names the field, where the default `strip` would silently drop it.
    // The name keys the hoisted `definitions` entry by GraphQL type instead of by position (`__schema0`).
    holder.schema = withName(z.object(shape).strict(), type.name);
    ctx.done.set(type.name, holder.schema);
    return holder.schema;
  }
  // Unreachable for valid input types; keep type-checking happy and fail soft.
  return z.any();
}

/**
 * Attaches a schema description when there is one. Exported for `output-schema.ts`.
 *
 * @param schema - The schema to describe.
 * @param [description] - The GraphQL description, if the schema declares one.
 * @returns The described schema, or `schema` unchanged.
 */
export function describe(schema: AnyZodType, description?: string | null): AnyZodType {
  return description ? schema.describe(description) : schema;
}

/**
 * The Zod schema for a scalar. The user mapping wins over the built-ins, so
 * `ID`/`String` can be retyped, identically on the input and output side.
 *
 * @param type - The scalar type.
 * @param resolve - The user's scalar mapping, as a resolver.
 * @returns The mapped schema, or the built-in one.
 */
export function scalarSchema(type: GraphQLScalarType, resolve: ScalarResolver): AnyZodType {
  return resolve(type) ?? builtinScalar(type);
}

/**
 * The Zod schema for an enum: one of its value names.
 *
 * @param type - The enum type.
 * @returns A `z.enum` of the names.
 */
export function enumSchema(type: GraphQLEnumType): AnyZodType {
  const names = type.getValues().map((value) => value.name);
  // An enum with no values can't happen in a valid schema, but guard the cast.
  return names.length ? z.enum(names as [string, ...string[]]) : z.string();
}

/**
 * An argument or input field's default as the JSON a caller would actually send, or `undefined` when it has none.
 *
 * The AST literal is preferred over the coerced `defaultValue` because an enum's internal value need not be its SDL
 * name, and the name is what crosses the wire as a GraphQL variable. A programmatically built schema carries no AST,
 * so the coerced value is the fallback. Exported for `arg-example.ts` and not re-exported from `index.ts`.
 *
 * @param source - The argument or input field whose default is read.
 * @returns The default as JSON, or `undefined` when none is declared.
 */
export function defaultJsonOf(source: GraphQLArgument | GraphQLInputField): unknown {
  const node = source.astNode?.defaultValue;
  if (node) {
    return valueFromASTUntyped(node);
  }
  return source.defaultValue;
}

/**
 * Attaches the JSON Schema `default` keyword when there is one to attach.
 * Advisory only — see {@link withDefault} for why this is metadata rather than
 * a Zod `.default()`.
 *
 * @param schema - The schema to annotate, after its nullability wrapping.
 * @param source - The argument or input field that may declare a default.
 * @returns A schema carrying the default, or `schema` unchanged when there is none.
 */
function withArgDefault(schema: AnyZodType, source: GraphQLArgument | GraphQLInputField): AnyZodType {
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
export function argsToZodShape(args: ReadonlyArray<GraphQLArgument>, options: ZodShapeOptions = {}): ZodShape {
  // Both maps live for this call only, because the memo is keyed by type name alone and different options would give
  // the same name a different schema.
  const ctx: Ctx = {
    pending: new Map(),
    done: new Map(),
    scalar: toResolver(options.scalars),
    nullBranches: options.nullBranches ?? DEFAULT_NULL_BRANCHES,
    inputField: options.inputField,
  };
  const shape: ZodShape = {};
  for (const arg of args) {
    shape[arg.name] = withArgDefault(describe(fieldToZod(arg.type, ctx, 'property'), arg.description), arg);
  }
  return shape;
}
