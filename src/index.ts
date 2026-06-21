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
 * - `operation` — per-field operation documents (`buildOperation`)
 * - `tools` — schema → `ToolDescriptor`s (`buildTools`)
 * - `executor` — `createLocalExecutor` (in-process) / `createHttpExecutor` (forwarding)
 * - `server` — `createMcpServer` / `createServerFactory` / `registerGraphqlTools` (+ custom tools)
 * - `http` — `createHttpHandler` for the Streamable HTTP transport
 *
 * @packageDocumentation
 */

export type { HttpExecutorOptions, LocalExecutorOptions } from './executor.ts';
export { createHttpExecutor, createLocalExecutor } from './executor.ts';
export type { HttpHandlerOptions, McpHttpHandler, McpHttpRequest } from './http.ts';
export { createHttpHandler } from './http.ts';
export type { BuiltOperation } from './operation.ts';
export { buildOperation } from './operation.ts';
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
export type { BuildToolsOptions, ToolDescriptor } from './tools.ts';
export { buildTools } from './tools.ts';
export type {
  GraphqlError,
  GraphqlExecutor,
  GraphqlRequest,
  GraphqlResult,
  OperationKind,
  ToolAnnotations,
} from './types.ts';
export { argsToZodShape } from './zodSchema.ts';
