/**
 * The two built-in {@link GraphqlExecutor}s — the seam that decides *where* a
 * tool's GraphQL operation runs.
 *
 * - {@link createLocalExecutor} runs it in-process against the schema you already
 *   have (the simplest "side-by-side" setup: mount the MCP handler on a route in
 *   the same app as your GraphQL endpoint).
 * - {@link createHttpExecutor} forwards it to a separate GraphQL HTTP endpoint —
 *   for when the MCP server runs as its own process next to the GraphQL server.
 */

import { execute, type GraphQLSchema, parse } from 'graphql';
import type { GraphqlExecutor, GraphqlResult } from './types.ts';

/** Options for {@link createLocalExecutor}. */
export interface LocalExecutorOptions {
  /** Default `rootValue` for execution (e.g. a resolver root for `buildSchema` schemas). */
  rootValue?: unknown;
  /** Fallback `contextValue` used when a call provides no per-request `context`. */
  contextValue?: unknown;
}

/**
 * An executor that runs operations in-process against `schema` via graphql-js's
 * `execute`. The per-call `context` (from the `context` server option) is passed
 * as the GraphQL `contextValue`, falling back to `options.contextValue`.
 *
 * @param schema - The executable schema to run against.
 * @param options - Default root/context values.
 */
export function createLocalExecutor(
  schema: GraphQLSchema,
  options: LocalExecutorOptions = {},
): GraphqlExecutor {
  return async ({ query, variables, operationName, context }) => {
    const result = await execute({
      schema,
      document: parse(query),
      variableValues: variables,
      operationName,
      rootValue: options.rootValue,
      contextValue: context ?? options.contextValue,
    });
    return result as GraphqlResult;
  };
}

/** Options for {@link createHttpExecutor}. */
export interface HttpExecutorOptions {
  /**
   * Extra request headers. Either a static record or a function of the per-call
   * `context` — use the function form to forward auth derived from the MCP
   * request (e.g. `(ctx) => ({ authorization: ctx.token })`).
   */
  headers?: Record<string, string> | ((context: unknown) => Record<string, string>);
  /** Override the `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

/**
 * An executor that POSTs operations to a GraphQL HTTP `endpoint` (the standard
 * `{ query, variables, operationName }` body) and returns the parsed JSON.
 *
 * @param endpoint - The GraphQL endpoint URL.
 * @param options - Header and `fetch` overrides.
 */
export function createHttpExecutor(
  endpoint: string,
  options: HttpExecutorOptions = {},
): GraphqlExecutor {
  const doFetch = options.fetch ?? globalThis.fetch;
  return async ({ query, variables, operationName, context }) => {
    const extra =
      typeof options.headers === 'function' ? options.headers(context) : options.headers;
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...extra },
      body: JSON.stringify({ query, variables, operationName }),
    });
    if (!response.ok) {
      return {
        errors: [
          { message: `GraphQL endpoint responded ${response.status} ${response.statusText}` },
        ],
      };
    }
    return (await response.json()) as GraphqlResult;
  };
}
