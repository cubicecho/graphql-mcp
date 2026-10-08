/**
 * graphql-mcp — turn a GraphQL schema into an MCP server.
 *
 * Every `Query` and `Mutation` root field of a `GraphQLSchema` becomes a Model Context Protocol tool, described from
 * the SDL. Mount the returned HTTP handler beside your GraphQL server, or run it as its own process and forward to a
 * remote endpoint.
 *
 * The source is grouped into `core` (shared types, defaults, errors), `input` (the arguments a tool takes), `output` (what a tool
 * returns), `catalog` (which tools exist and what each says), `runtime` (registering tools and running calls) and
 * `transport` (serving over HTTP).
 *
 * @example
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
 * @packageDocumentation
 */

export type { SchemaExtension } from './catalog/extend.ts';
export { extendSchemaForMcp, stripRootTypes } from './catalog/extend.ts';
export type { BuiltOperation } from './catalog/operation.ts';
export { buildOperation } from './catalog/operation.ts';
export type {
  BuildOperationToolsOptions,
  OperationSource,
  OperationsInput,
} from './catalog/operations.ts';
export { buildOperationTools } from './catalog/operations.ts';
export type { RuleMatcher } from './catalog/rules.ts';
export { compileRules } from './catalog/rules.ts';
export type {
  ArgMapper,
  BuildToolsOptions,
  ExampleDepth,
  McpFieldExtensions,
  NullBranchesOption,
  SelectionDepth,
  ToolDescriptor,
} from './catalog/tools.ts';
export { applyNameCase, buildTools, MutationHints, NameCase } from './catalog/tools.ts';
export {
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_EVENTS_PER_STREAM,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_STREAMS,
} from './core/defaults.ts';
export type {
  GraphqlError,
  GraphqlExecutor,
  GraphqlRequest,
  GraphqlResult,
  ToolAnnotations,
} from './core/types.ts';
export { NullBranches, OperationKind } from './core/types.ts';
export { VERSION } from './core/version.ts';
export type { AnyZodType, ZodShape } from './core/zod-compat.ts';
export type {
  InputFieldFilter,
  NullBranchesByType,
  NullBranchesSetting,
  ScalarMap,
  ScalarMapping,
  ScalarResolver,
  ZodShapeOptions,
} from './input/zod-schema.ts';
export { argsToZodShape } from './input/zod-schema.ts';
export { buildOutputSchema } from './output/output-schema.ts';
export type { Pagination, PaginationStyle } from './output/pagination.ts';
export { detectPagination, paginationHint } from './output/pagination.ts';
export type { ExecutorRequest } from './output/result.ts';
export { clamp, runExecutor, text, toCallToolResult } from './output/result.ts';
export { buildSelectionSet } from './output/selection.ts';
export type { HttpExecutorOptions, LocalExecutorOptions } from './runtime/executor.ts';
export { createHttpExecutor, createLocalExecutor } from './runtime/executor.ts';
export {
  /**
   * `extensions.code` on an argument-validation error. Exported so a custom tool
   * can answer a bad call with the same code the generated ones do — a client
   * that branches on it should not have to know which kind of tool it called.
   */
  BAD_INPUT,
  /** `extensions.code` on a failure caused by the server's own configuration. */
  BAD_TOOL_CONFIG,
} from './runtime/handlers.ts';
export type { MetaToolDeps, MetaToolName, MetaToolsOptions } from './runtime/meta.ts';
export { buildMetaTools } from './runtime/meta.ts';
export type {
  ContextFactory,
  CreateMcpServerOptions,
  CustomTool,
  ServerDecorator,
  ServerFactory,
  ToolHandler,
} from './runtime/server.ts';
export {
  connectServer,
  createMcpServer,
  createServerFactory,
  registerGraphqlTools,
} from './runtime/server.ts';
export type {
  EventId,
  EventStore,
  ReplayOption,
  ReplayOptions,
  StreamId,
} from './transport/event-store.ts';
export { eventStoreFactory, MemoryEventStore } from './transport/event-store.ts';
export type { FetchHandlerOptions, McpFetchHandler } from './transport/fetch.ts';
export { createFetchHandler } from './transport/fetch.ts';
export type { HttpHandlerOptions, McpHttpHandler, McpHttpRequest } from './transport/http.ts';
export { createHttpHandler } from './transport/http.ts';
export type {
  ClosableTransport,
  Session,
  SessionDirectory,
  SessionOptions,
} from './transport/sessions.ts';
export { MemorySessionDirectory, SESSION_OWNER_HEADER, SessionStore } from './transport/sessions.ts';
