/**
 * Zod types spelled so they hold across both majors in the peer range.
 *
 * `zod` is a peer dependency accepting `^3.25 || ^4.0`, so the schemas this
 * package builds are whatever the *consumer* installed. The two majors do not
 * agree on the names we would otherwise import:
 *
 * - `ZodTypeAny` is `ZodType<any, any, any>` in v3, but resolves to the core
 *   `$ZodType` in v4 — which carries no `.parse`, `.describe`, or `.safeParse`,
 *   so every call site fails to type-check.
 * - `ZodRawShape` is a mutable `Record` in v3 and a `Readonly<Record>` in v4,
 *   so a shape built by assignment (which is how every shape here is built) is
 *   rejected under v4.
 *
 * Bare `ZodType` means the classic schema class in both, with `.parse` and
 * friends, and its generics default in both. {@link ZodShape} then matches the
 * SDK's own `ZodRawShapeCompat` (`Record<string, AnySchema>`) exactly, so
 * anything assignable to one is assignable to the other.
 *
 * Import from here rather than from `zod` directly for these two names; `z`
 * itself is fine to import anywhere, as the runtime API we use is common to
 * both majors.
 */

import type { ZodType } from 'zod';

/** Any Zod schema, under either major. Replaces `ZodTypeAny`. */
export type AnyZodType = ZodType;

/**
 * A Zod "raw shape" — field name → schema — mutable, so shapes can be built up
 * by assignment. Replaces `ZodRawShape`.
 */
export type ZodShape = Record<string, AnyZodType>;
