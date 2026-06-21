/**
 * Wires schema-derived {@link ToolDescriptor}s onto an `McpServer`, binding each
 * to a {@link GraphqlExecutor}, and lets callers register custom tools that add
 * to — or override, by name — the generated ones.
 *
 * Two entry points:
 * - {@link createMcpServer} — a ready `McpServer` (use directly for stdio or a
 *   single long-lived connection).
 * - {@link createServerFactory} — builds the (pure) descriptors once and returns
 *   a `() => McpServer` that mints a fresh server per call. The HTTP layer uses
 *   this so each stateless request gets its own server+transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphQLSchema } from 'graphql';
import type { ZodRawShape } from 'zod';
import { createLocalExecutor } from './executor.ts';
import { type BuildToolsOptions, buildTools, type ToolDescriptor } from './tools.ts';
import type { GraphqlExecutor, GraphqlResult, ToolAnnotations } from './types.ts';

/** The handler signature for a custom tool: validated args plus the MCP `extra`. */
export type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

/**
 * A user-supplied tool. If its `name` matches a generated tool, it replaces that
 * tool; otherwise it's added. Omit `inputSchema` for a no-argument tool.
 */
export interface CustomTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}

/** Derives the per-call GraphQL context from the MCP request's `extra`. */
export type ContextFactory = (extra: unknown) => unknown | Promise<unknown>;

/** Options for {@link createMcpServer} / {@link createServerFactory}. */
export interface CreateMcpServerOptions extends BuildToolsOptions {
  /** The GraphQL schema to expose. */
  schema: GraphQLSchema;
  /** MCP server name advertised to clients. Default `'graphql-mcp-server'`. */
  name?: string;
  /** MCP server version. Default `'0.1.0'`. */
  version?: string;
  /**
   * Where tool operations run. Default: {@link createLocalExecutor} against
   * `schema`. Swap in {@link createHttpExecutor} to forward to a separate server.
   */
  executor?: GraphqlExecutor;
  /**
   * Per-call GraphQL context. A static value, or a factory of the MCP `extra`
   * (which carries request/auth info under HTTP transport) — use the factory to
   * derive auth context per request.
   */
  context?: unknown | ContextFactory;
  /** Custom tools to add or override generated ones by name. */
  tools?: CustomTool[];
}

/**
 * Builds a single `McpServer` with all generated and custom tools registered.
 *
 * For stateless HTTP, prefer {@link createHttpHandler} (which gives each request
 * its own server). Use this directly for stdio or a single persistent session.
 *
 * @param options - Schema, executor, context, and tool options.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  return createServerFactory(options)();
}

/** A factory minting fresh `McpServer`s; an optional arg overrides the call context. */
export type ServerFactory = (contextOverride?: unknown | ContextFactory) => McpServer;

/**
 * Builds the tool descriptors once and returns a factory that mints a fresh
 * `McpServer` (with those tools registered) on each call. The factory accepts an
 * optional context override so per-request callers (e.g. the HTTP handler) can
 * supply request-derived context without rebuilding the descriptors.
 *
 * @param options - Schema, executor, context, and tool options.
 * @returns A {@link ServerFactory}.
 */
export function createServerFactory(options: CreateMcpServerOptions): ServerFactory {
  const descriptors = buildTools(options.schema, options);
  const executor = options.executor ?? createLocalExecutor(options.schema);
  const customTools = options.tools ?? [];
  const overridden = new Set(customTools.map((tool) => tool.name));

  return (contextOverride) => {
    const context = contextOverride ?? options.context;
    const server = new McpServer({
      name: options.name ?? 'graphql-mcp-server',
      version: options.version ?? '0.1.0',
    });
    for (const descriptor of descriptors) {
      if (overridden.has(descriptor.name)) continue;
      registerGeneratedTool(server, descriptor, executor, context);
    }
    for (const tool of customTools) {
      registerCustomTool(server, tool);
    }
    return server;
  };
}

/**
 * Registers schema-derived `descriptors` onto an existing `server`, binding each
 * to `executor`. The lower-level building block behind {@link createMcpServer};
 * use it when you manage the `McpServer` lifecycle yourself.
 *
 * @param server - The MCP server to register tools on.
 * @param descriptors - Tool descriptors (from `buildTools`).
 * @param executor - Where the tools' operations run.
 * @param context - Per-call GraphQL context (value or factory of MCP `extra`).
 */
export function registerGraphqlTools(
  server: McpServer,
  descriptors: ToolDescriptor[],
  executor: GraphqlExecutor,
  context?: unknown | ContextFactory,
): void {
  for (const descriptor of descriptors) {
    registerGeneratedTool(server, descriptor, executor, context);
  }
}

function registerGeneratedTool(
  server: McpServer,
  descriptor: ToolDescriptor,
  executor: GraphqlExecutor,
  context: unknown | ContextFactory,
): void {
  server.registerTool(
    descriptor.name,
    {
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      annotations: descriptor.annotations,
    },
    async (args: Record<string, unknown>, extra: unknown) => {
      const variables: Record<string, unknown> = {};
      for (const argName of descriptor.argNames) {
        if (args[argName] !== undefined) variables[argName] = args[argName];
      }
      const resolvedContext = await resolveContext(context, extra);
      const result = await executor({
        query: descriptor.query,
        variables,
        operationName: descriptor.name,
        context: resolvedContext,
      });
      return toCallToolResult(result);
    },
  );
}

function registerCustomTool(server: McpServer, tool: CustomTool): void {
  // The SDK's overloads differ by whether `inputSchema` is present; cast the
  // config/handler at this boundary so callers get a single clean `CustomTool`.
  const config = {
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: bridging our uniform CustomTool to the SDK's split overloads
  server.registerTool(tool.name, config as any, tool.handler as any);
}

async function resolveContext(context: unknown | ContextFactory, extra: unknown): Promise<unknown> {
  return typeof context === 'function' ? await (context as ContextFactory)(extra) : context;
}

/** Wraps a GraphQL result as an MCP tool result; flags GraphQL errors as `isError`. */
function toCallToolResult(result: GraphqlResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: Boolean(result.errors?.length),
  };
}
