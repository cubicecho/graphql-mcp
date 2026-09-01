/**
 * graphql-mcp — turn a GraphQL schema into an MCP server.
 *
 * Point it at a `GraphQLSchema` and every `Query`/`Mutation` root field becomes
 * a Model Context Protocol tool, described from the SDL (field and argument
 * descriptions, types) so an AI can discover and call your API. It's a thin
 * wrapper meant to run *beside* your GraphQL server: mount the returned HTTP
 * handler on a route in the same app, or run it as its own process and forward
 * to a remote endpoint.
 *
 * Quick start:
 * ```ts
 * import express from 'express';
 * import { createHttpHandler } from '@cubicecho/graphql-mcp';
 * import { schema } from './schema.js';
 *
 * const app = express();
 * app.use(express.json());
 * app.post('/mcp', createHttpHandler({ schema })); // beside app.post('/graphql', …)
 * app.listen(4000);
 * ```
 *
 * Modules:
 * - `types` — `GraphqlExecutor`/`GraphqlRequest`/`GraphqlResult`, the execution seam
 * - `zodSchema` — GraphQL args → Zod input schema (`argsToZodShape`)
 * - `selection` — auto-built selection sets (`buildSelectionSet`)
 * - `outputSchema` — return type → Zod result schema (`buildOutputSchema`)
 * - `operation` — per-field operation documents (`buildOperation`)
 * - `rules` — include/exclude pattern matching (`compileRules`)
 * - `extend` — MCP-only schema additions (`extendSchemaForMcp`, `stripRootTypes`)
 * - `tools` — schema → `ToolDescriptor`s (`buildTools`)
 * - `meta` — opt-in schema-exploration tools (`buildMetaTools`)
 * - `result` — GraphQL result → MCP tool result (`toCallToolResult`, `runExecutor`);
 *   reuse these in a custom tool so it reports failure and size like the rest
 * - `executor` — `createLocalExecutor` (in-process) / `createHttpExecutor` (forwarding)
 * - `server` — `createMcpServer` / `createServerFactory` / `registerGraphqlTools` (+ custom tools)
 * - `http` — `createHttpHandler` for the Streamable HTTP transport (Node)
 * - `fetch` — `createFetchHandler` for `Request`/`Response` runtimes
 * - `sessions` — the session table behind stateful HTTP (`SessionStore`)
 * - `pagination` — paging-argument detection for truncation hints
 *
 * @packageDocumentation
 */

export type { HttpExecutorOptions, LocalExecutorOptions } from './executor.ts';
export { createHttpExecutor, createLocalExecutor } from './executor.ts';
export type { SchemaExtension } from './extend.ts';
export { extendSchemaForMcp, stripRootTypes } from './extend.ts';
export type { FetchHandlerOptions, McpFetchHandler } from './fetch.ts';
export { createFetchHandler } from './fetch.ts';
export type { HttpHandlerOptions, McpHttpHandler, McpHttpRequest } from './http.ts';
export { createHttpHandler } from './http.ts';
export type { MetaToolDeps, MetaToolName, MetaToolsOptions } from './meta.ts';
export { buildMetaTools } from './meta.ts';
export type { BuiltOperation } from './operation.ts';
export { buildOperation } from './operation.ts';
export { buildOutputSchema } from './outputSchema.ts';
export type { Pagination, PaginationStyle } from './pagination.ts';
export { detectPagination, paginationHint } from './pagination.ts';
export type { ExecutorRequest } from './result.ts';
export { clamp, DEFAULT_MAX_CHARS, runExecutor, text, toCallToolResult } from './result.ts';
export type { RuleMatcher } from './rules.ts';
export { compileRules } from './rules.ts';
export { buildSelectionSet } from './selection.ts';
export type {
  ContextFactory,
  CreateMcpServerOptions,
  CustomTool,
  ServerFactory,
  ToolHandler,
} from './server.ts';
export {
  createMcpServer,
  createServerFactory,
  registerGraphqlTools,
} from './server.ts';
export type { ClosableTransport, Session, SessionOptions } from './sessions.ts';
export {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSIONS,
  SessionStore,
} from './sessions.ts';
export type { BuildToolsOptions, McpFieldExtensions, NameCase, ToolDescriptor } from './tools.ts';
export { buildTools } from './tools.ts';
export type {
  GraphqlError,
  GraphqlExecutor,
  GraphqlRequest,
  GraphqlResult,
  OperationKind,
  ToolAnnotations,
} from './types.ts';
export { VERSION } from './version.ts';
export type { ScalarMap, ScalarMapping, ScalarResolver, ZodShapeOptions } from './zodSchema.ts';
export { argsToZodShape } from './zodSchema.ts';
