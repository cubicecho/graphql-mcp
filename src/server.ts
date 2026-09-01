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
 *
 * ## Structured output
 *
 * Descriptors carry an {@link ToolDescriptor.outputSchema} describing the
 * field's return type, but it is deliberately *not* registered with the SDK.
 * Registering it obliges the handler to return `structuredContent` matching the
 * schema, whereas these tools return the whole GraphQL `{ data, errors }`
 * envelope as JSON text — and on a resolver error `data` is partially null, so
 * a conforming result can't be promised. It stays on the descriptor for
 * introspection; TODO.md records what registering it would actually take.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphQLSchema } from 'graphql';
import type { ZodRawShape } from 'zod';
import { createLocalExecutor } from './executor.ts';
import { extendSchemaForMcp, type SchemaExtension } from './extend.ts';
import { buildMetaTools, type MetaToolsOptions } from './meta.ts';
import { DEFAULT_MAX_CHARS, runExecutor, toCallToolResult } from './result.ts';
import { type BuildToolsOptions, buildTools, type ToolDescriptor } from './tools.ts';
import type { GraphqlExecutor, ToolAnnotations } from './types.ts';
import { VERSION } from './version.ts';

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
  /** MCP server version advertised to clients. Default: this package's version. */
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
  /** Custom tools to add or override generated (and meta) ones by name. */
  tools?: CustomTool[];
  /**
   * Character budget for a tool result before it is truncated (with a note
   * saying how much was cut). Guards an agent's context against a field that
   * returns a large collection. Default `50_000`; also the default for
   * {@link MetaToolsOptions.maxChars}.
   */
  maxChars?: number;
  /**
   * Expose the schema-exploration tools ({@link buildMetaTools}) — `introspect`,
   * `search`, `validate`, `execute` — for schemas too large to project one tool
   * per field. `true` enables all four with defaults; pass an object to choose
   * which, rename them, or restrict what `execute` may call.
   *
   * `execute` inherits this server's `include`/`exclude`/`includeMutations` by
   * default, so a hand-written document can't reach past the generated tool
   * surface. Combine with `includeQueries: false, includeMutations: false` to
   * expose *only* the meta tools.
   */
  metaTools?: boolean | MetaToolsOptions;
  /**
   * MCP-only schema additions ({@link extendSchemaForMcp}) merged before tool
   * generation. The extended schema is used both for building tools and for the
   * default local executor. If you supply a custom `executor` (e.g.
   * `createHttpExecutor`), it must be able to resolve the extended fields — a
   * remote GraphQL endpoint will not know them.
   */
  extend?: SchemaExtension;
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
  const schema = options.extend
    ? extendSchemaForMcp(options.schema, options.extend)
    : options.schema;
  const descriptors = buildTools(schema, options);
  const executor = options.executor ?? createLocalExecutor(schema);
  const customTools = options.tools ?? [];
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // Meta tools default to the same surface the generated tools expose, so the
  // raw-document `execute` path can't reach past it.
  const metaOptions: MetaToolsOptions | null = options.metaTools
    ? {
        ...(typeof options.metaTools === 'object' ? options.metaTools : {}),
        include: pickMeta(options, 'include') ?? options.include,
        exclude: pickMeta(options, 'exclude') ?? options.exclude,
        allowMutations: pickMeta(options, 'allowMutations') ?? options.includeMutations ?? true,
        maxChars: pickMeta(options, 'maxChars') ?? options.maxChars,
      }
    : null;

  return (contextOverride) => {
    const context = contextOverride ?? options.context;
    const server = new McpServer({
      name: options.name ?? 'graphql-mcp-server',
      version: options.version ?? VERSION,
    });
    // Built per call: `execute` closes over this call's GraphQL context.
    const metaTools = metaOptions
      ? buildMetaTools(
          { schema, executor, resolveContext: (extra) => resolveContext(context, extra) },
          metaOptions,
        )
      : [];
    // Later wins by name: user `tools` override meta tools, both override generated ones.
    const byName = new Map<string, CustomTool>();
    for (const tool of [...metaTools, ...customTools]) byName.set(tool.name, tool);

    for (const descriptor of descriptors) {
      if (byName.has(descriptor.name)) continue;
      registerGeneratedTool(server, descriptor, executor, context, maxChars);
    }
    for (const tool of byName.values()) {
      registerCustomTool(server, tool);
    }
    return server;
  };
}

/** Reads a key off the `metaTools` object form (absent for the `true` form). */
function pickMeta<K extends keyof MetaToolsOptions>(
  options: CreateMcpServerOptions,
  key: K,
): MetaToolsOptions[K] | undefined {
  return typeof options.metaTools === 'object' ? options.metaTools[key] : undefined;
}

/**
 * Connects `server` to `transport`, treating a `tools/call` that omits
 * `arguments` as one that sent `{}`.
 *
 * The MCP schema makes `params.arguments` optional, and a tool taking no
 * arguments at all — every generated tool for a field with no args — gives a
 * client nothing to put there. The SDK passes `params.arguments` to the tool's
 * input schema untouched, so an omitted one arrives as `undefined` and fails
 * validation before the handler is reached: `Invalid arguments for tool
 * schedule: expected object, received undefined`. A model that reasonably sent
 * no arguments then has no way to call the tool at all, and retrying produces
 * the identical error.
 *
 * It has to be fixed on the way in. The schema cannot be made tolerant: the SDK
 * renders `tools/list` from the same value it validates against, and anything
 * that parses `undefined` — an optional or a default wrapping the object — stops
 * being recognised as an object schema, at which point the tool is advertised
 * with an empty one. So the message is corrected instead, after `connect` has
 * installed the SDK's own handler and before that handler sees it.
 *
 * Use this instead of `server.connect` on a server built here. Both shipped HTTP
 * handlers do.
 *
 * @param server - The MCP server to connect.
 * @param transport - The transport to connect it to.
 */
export async function connectServer(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
  const handler = transport.onmessage;
  if (!handler) return;
  transport.onmessage = (message, extra) => handler(withArguments(message), extra);
}

/**
 * A `tools/call` with no `arguments`, rewritten to carry an empty object.
 *
 * Copied rather than mutated: the caller's message may be shared (a transport is
 * free to hand the same parsed body to more than one listener), and a request
 * this rewrites in place would be seen changed by anything reading it after.
 */
function withArguments<T>(message: T): T {
  if (!message || typeof message !== 'object') return message;
  const request = message as { method?: unknown; params?: Record<string, unknown> };
  if (request.method !== 'tools/call') return message;
  if (!request.params || typeof request.params !== 'object') return message;
  if (request.params.arguments !== undefined) return message;
  return { ...request, params: { ...request.params, arguments: {} } } as T;
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
 * @param maxChars - Character budget for a result before truncation.
 */
export function registerGraphqlTools(
  server: McpServer,
  descriptors: ToolDescriptor[],
  executor: GraphqlExecutor,
  context?: unknown | ContextFactory,
  maxChars = DEFAULT_MAX_CHARS,
): void {
  for (const descriptor of descriptors) {
    registerGeneratedTool(server, descriptor, executor, context, maxChars);
  }
}

function registerGeneratedTool(
  server: McpServer,
  descriptor: ToolDescriptor,
  executor: GraphqlExecutor,
  context: unknown | ContextFactory,
  maxChars: number,
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
      const result = await runExecutor(executor, {
        query: descriptor.query,
        variables,
        operationName: descriptor.operationName,
        context: resolvedContext,
      });
      return toCallToolResult(result, maxChars, descriptor.pageHint);
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
