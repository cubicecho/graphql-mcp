/**
 * Zod types spelled so they hold across both majors in the peer range, `^3.25 || ^4.0`.
 *
 * In v4 `ZodTypeAny` resolves to the core `$ZodType`, which has no `.parse` or `.describe`, and `ZodRawShape` is
 * read-only, which rejects a shape built by assignment. Bare `ZodType` is the classic schema class in both majors, and
 * {@link ZodShape} matches the SDK's own `ZodRawShapeCompat`. Import these two names from here instead of from `zod`,
 * while `z` itself is fine to import anywhere.
 */

import type { ZodType } from 'zod';

/** Any Zod schema, under either major. Replaces `ZodTypeAny`. */
export type AnyZodType = ZodType;

/**
 * A Zod "raw shape" — field name → schema — mutable, so shapes can be built up
 * by assignment. Replaces `ZodRawShape`.
 */
export type ZodShape = Record<string, AnyZodType>;

/**
 * Names a schema, so a JSON Schema render that hoists it into `definitions` keys it by that name instead of by
 * position (`__schema0`).
 *
 * Only v4 hoists and only v4 has `.meta()`, so this is a no-op under v3. The name is carried by a clone that `.meta()`
 * returns, so use the return value.
 */
export function withName<T extends AnyZodType>(schema: T, name: string): T {
  const meta = (schema as { meta?: (metadata: { id: string }) => T }).meta;
  return typeof meta === 'function' ? meta.call(schema, { id: name }) : schema;
}

/**
 * Advertises a value as the schema's JSON Schema `default`, without making Zod apply it.
 *
 * Zod's `.default(v)` would substitute the value at parse time and put it into the GraphQL `variables`, making this
 * package decide the default instead of the server. Apply it after any nullability wrapping, so the keyword lands on
 * the property rather than inside one branch of an `anyOf`. Like {@link withName} this is a no-op under v3 and returns
 * a clone, so store the return value.
 */
export function withDefault<T extends AnyZodType>(schema: T, value: unknown): T {
  const meta = (schema as { meta?: (metadata: { default: unknown }) => T }).meta;
  return typeof meta === 'function' ? meta.call(schema, { default: value }) : schema;
}
