/**
 * Compiles graphql-shield-style allow/deny patterns into a matcher over root
 * fields. A pattern is a field name with optional `*` wildcards and an optional
 * `Query.`/`Mutation.` prefix constraining which root it applies to:
 *
 * - `todos` — the `todos` field on either root
 * - `Query.todo` — only the query
 * - `Mutation.*` — every mutation
 * - `delete*` / `Query.user*` — wildcard prefixes
 *
 * Patterns match **GraphQL field names**, not remapped tool names — rule
 * filtering runs before any renaming (`toolName`, `extensions.mcp.name`,
 * `decorate`).
 */

import type { OperationKind } from './types.ts';

/** A compiled matcher: does (fieldName, kind) match any of the source patterns? */
export type RuleMatcher = (fieldName: string, kind: OperationKind) => boolean;

const PREFIX_KINDS: Record<string, OperationKind> = {
  Query: 'query',
  Mutation: 'mutation',
};

/**
 * Compiles `patterns` into a single {@link RuleMatcher} (ORed over patterns).
 * An empty list yields a matcher that never matches.
 *
 * @param patterns - Field-name patterns, optionally `Query.`/`Mutation.`-prefixed.
 * @throws If a dotted pattern's prefix is neither `Query` nor `Mutation`.
 */
export function compileRules(patterns: readonly string[]): RuleMatcher {
  const compiled = patterns.map((pattern) => {
    const dot = pattern.indexOf('.');
    if (dot === -1) return { kind: undefined, regex: globToRegex(pattern) };
    const prefix = pattern.slice(0, dot);
    const kind = PREFIX_KINDS[prefix];
    if (!kind) {
      throw new Error(
        `graphql-mcp: invalid rule pattern '${pattern}' — prefix must be 'Query' or 'Mutation'.`,
      );
    }
    return { kind, regex: globToRegex(pattern.slice(dot + 1)) };
  });

  return (fieldName, kind) =>
    compiled.some((rule) => (!rule.kind || rule.kind === kind) && rule.regex.test(fieldName));
}

/** `delete*` → `/^delete.*$/` — escape everything, then let `*` match any run. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
}
