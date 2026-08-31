/**
 * Recognises a field's pagination arguments so a truncated result can name the
 * argument to page with.
 *
 * A clamped result tells an agent that output was cut, which leaves it stuck:
 * re-running the same call returns the same oversized page. The fix is to say
 * *which* argument narrows it — and the schema already knows, because a field
 * that paginates advertises it in its arguments.
 *
 * Detection is by argument name, matched case-insensitively against the
 * conventions in wide use (Relay `first`/`after`, offset `limit`/`offset`, Prisma
 * `take`/`skip`, page-number `page`/`pageSize`). There is deliberately no check
 * that the field returns a list: the hint is only ever emitted alongside a
 * truncation note, and a call that produced more than the character budget is a
 * collection whatever its return type says. That also keeps Relay connections —
 * objects, not lists — from being missed.
 */

import type { GraphQLArgument } from 'graphql';

/** How a field's "next page" argument advances: by cursor, offset, or page number. */
export type PaginationStyle = 'cursor' | 'offset' | 'page';

/** The pagination arguments found on a field. */
export interface Pagination {
  /** The argument that caps how much comes back (`first`, `limit`, `take`, …). */
  limit?: string;
  /** The argument that advances past this page (`after`, `offset`, `page`, …). */
  next?: string;
  /** What `next` means, which decides how the hint phrases it. */
  style: PaginationStyle;
}

/**
 * Each recognised pairing, in priority order. A convention with *both* halves
 * present always beats one with only a half, so a schema mixing conventions
 * (`first`/`after` alongside a stray `limit`) resolves to one coherent pair
 * rather than to whichever single argument happened to be listed first.
 */
const CONVENTIONS: ReadonlyArray<{ limit?: string; next?: string; style: PaginationStyle }> = [
  { limit: 'first', next: 'after', style: 'cursor' },
  { limit: 'last', next: 'before', style: 'cursor' },
  { limit: 'limit', next: 'offset', style: 'offset' },
  { limit: 'limit', next: 'cursor', style: 'cursor' },
  { limit: 'limit', next: 'skip', style: 'offset' },
  { limit: 'take', next: 'skip', style: 'offset' },
  { limit: 'pagesize', next: 'page', style: 'page' },
  { limit: 'perpage', next: 'page', style: 'page' },
  { limit: 'count', next: 'offset', style: 'offset' },
  { next: 'page', style: 'page' },
  { next: 'cursor', style: 'cursor' },
  { next: 'after', style: 'cursor' },
];

/**
 * Finds the pagination arguments on a field, or `undefined` if it has none.
 *
 * @param args - The field's arguments.
 * @returns The matched convention, holding only the arguments actually present.
 */
export function detectPagination(args: readonly GraphQLArgument[]): Pagination | undefined {
  if (!args.length) return undefined;
  // Lower-cased lookup so `pageSize`, `pagesize`, and `PageSize` all match, with
  // the original spelling kept — the hint has to name the argument as written.
  const byLower = new Map(args.map((arg) => [arg.name.toLowerCase(), arg.name]));
  const has = (name?: string) => Boolean(name && byLower.has(name));

  const matched =
    CONVENTIONS.find((c) => has(c.limit) && has(c.next)) ??
    CONVENTIONS.find((c) => has(c.limit) || has(c.next));
  if (!matched) return undefined;

  const limit = matched.limit ? byLower.get(matched.limit) : undefined;
  const next = matched.next ? byLower.get(matched.next) : undefined;
  return { ...(limit ? { limit } : {}), ...(next ? { next } : {}), style: matched.style };
}

/** What advancing means, phrased for the agent rather than for the schema author. */
const ADVANCE: Record<PaginationStyle, string> = {
  cursor: 'to continue from where this page ended',
  offset: 'to skip past the items you already have',
  page: 'to step to the next page',
};

/**
 * Renders a one-sentence instruction for paging, or `undefined` when the field
 * has no pagination arguments.
 *
 * @param args - The field's arguments.
 */
export function paginationHint(args: readonly GraphQLArgument[]): string | undefined {
  const pagination = detectPagination(args);
  if (!pagination) return undefined;
  const { limit, next, style } = pagination;
  const clauses: string[] = [];
  if (limit) clauses.push(`\`${limit}\` to cap the page size`);
  if (next) clauses.push(`\`${next}\` ${ADVANCE[style]}`);
  return `This field paginates: pass ${clauses.join(', then ')}.`;
}
