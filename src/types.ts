/**
 * Core shared types. Pure types — no runtime, no internal dependencies.
 *
 * The central abstraction is {@link GraphqlExecutor}: the single seam between a
 * generated MCP tool and "where GraphQL actually runs". The default executor
 * (`createLocalExecutor`) runs the operation against the in-process schema, but
 * a tool never knows the difference — swap in `createHttpExecutor` to forward to
 * a separate GraphQL server running side-by-side instead.
 */

/** Whether a root field originates from the schema's `Query` or `Mutation` type. */
export type OperationKind = 'query' | 'mutation';

/** A single GraphQL error, mirroring the spec's error shape. */
export interface GraphqlError {
  message: string;
  path?: ReadonlyArray<string | number>;
  // biome-ignore lint/suspicious/noExplicitAny: GraphQL errors carry arbitrary extensions
  [key: string]: any;
}

/** A GraphQL execution result, mirroring the spec's `{ data, errors }` envelope. */
export interface GraphqlResult {
  data?: Record<string, unknown> | null;
  errors?: ReadonlyArray<GraphqlError>;
}

/** A GraphQL request as produced from a tool call: a document plus its variables. */
export interface GraphqlRequest {
  /** The operation document — a `query`/`mutation` string. */
  query: string;
  /** Variables keyed by the root field's argument names. */
  variables: Record<string, unknown>;
  /** The operation name (equal to the tool / root-field name). */
  operationName: string;
  /**
   * Per-call context, opaque to the tool layer. Forwarded as the GraphQL
   * `contextValue` (local executor) or used to derive request headers (HTTP
   * executor). Typically derived from the MCP request via the `context` option.
   */
  context?: unknown;
}

/**
 * Runs a GraphQL operation and returns its `{ data, errors }` result.
 *
 * This is the one place the library is decoupled from execution: implement it
 * (or use {@link createLocalExecutor} / {@link createHttpExecutor}) to run tools
 * against an in-process schema, a remote endpoint, or anything else.
 */
export type GraphqlExecutor = (request: GraphqlRequest) => Promise<GraphqlResult>;

/**
 * MCP tool behaviour hints. Mirrors the SDK's `ToolAnnotations` (kept local so
 * the type helpers don't depend on SDK internals); all fields are optional.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
