/**
 * Wires schema-derived {@link ToolDescriptor}s onto an `McpServer`, binding each to a {@link GraphqlExecutor}, and lets
 * callers register custom tools that add to the generated ones or override them by name.
 *
 * {@link createMcpServer} returns a ready server for stdio or a single long-lived connection. {@link
 * createServerFactory} builds the descriptors once and returns a function that mints a fresh server per call, which the
 * HTTP layer uses to give each stateless request its own server.
 *
 * A descriptor's {@link ToolDescriptor.outputSchema} is deliberately not registered with the SDK, because registering
 * it obliges the handler to return matching `structuredContent`, and a resolver error leaves `data` partially null, so
 * a conforming result cannot be promised.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphQLSchema } from 'graphql';
import { z } from 'zod';
import { extendSchemaForMcp, type SchemaExtension } from '../catalog/extend.ts';
import { buildOperationTools, type OperationsInput } from '../catalog/operations.ts';
import { type BuildToolsOptions, buildTools, type ToolDescriptor } from '../catalog/tools.ts';
import { DEFAULT_MAX_CHARS } from '../core/defaults.ts';
import { packageError } from '../core/errors.ts';
import type { GraphqlExecutor, ToolAnnotations } from '../core/types.ts';
import { VERSION } from '../core/version.ts';
import type { AnyZodType, ZodShape } from '../core/zod-compat.ts';
import { runExecutor, toCallToolResult } from '../output/result.ts';
import { createLocalExecutor } from './executor.ts';
import {
  BAD_INPUT,
  BAD_TOOL_CONFIG,
  guardToolArguments,
  shareToolListing,
  type ToolListingCache,
  type ToolValidators,
} from './handlers.ts';
import { buildMetaTools, type MetaToolsOptions } from './meta.ts';

/** The handler signature for a custom tool: validated args plus the MCP `extra`. */
export type ToolHandler = (args: Record<string, unknown>, extra: unknown) => CallToolResult | Promise<CallToolResult>;

/**
 * A user-supplied tool. If its `name` matches a generated tool, it replaces that
 * tool; otherwise it's added. Omit `inputSchema` for a no-argument tool.
 */
export interface CustomTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: ZodShape;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}

/** Derives the per-call GraphQL context from the MCP request's `extra`. */
export type ContextFactory = (extra: unknown) => unknown | Promise<unknown>;

/**
 * A hook run on each freshly minted server, after every generated, meta and
 * custom tool is registered and before the listing and argument wrappers are
 * installed — the one window in which `registerPrompt`/`registerResource` can
 * still declare their capabilities, since the SDK's `registerCapabilities`
 * throws once a transport is attached.
 *
 * Synchronous by design: see {@link CreateMcpServerOptions.decorateServer}.
 */
export type ServerDecorator = (server: McpServer) => void;

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
   * Hand-written GraphQL documents to expose as tools ({@link buildOperationTools}), each replacing any generated tool
   * of the same name.
   *
   * Takes documents, never paths, because a top-level `node:fs` import would make this package unloadable on a fetch
   * runtime, so on Node read each file into a `Source`, which puts the file name into every boot-time error:
   *
   * ```ts
   * operations: globSync('mcp/*.graphql').map(
   *   (path) => new Source(readFileSync(path, 'utf8'), path),
   * ),
   * ```
   *
   * Documents validate against the extended schema, so an operation may select an MCP-only field. `nameCase`,
   * `scalars`, `mutationHints` and `inputField` carry over, as do `nullBranches` and `exampleDepth` unless given as a
   * callback that takes a `GraphQLField`, and the options that project a schema (`include`, `exclude`, `filter`,
   * `selectionDepth`, `toolName`, `extensions.mcp`) do not apply.
   */
  operations?: OperationsInput;
  /**
   * Runs against each server this factory mints, before it is connected, so you can call what this package does not
   * generate, such as `registerPrompt` and `registerResource`.
   *
   * It must be synchronous, and a hook that returns a promise is refused, because the server is connected as soon as it
   * is returned and the SDK cannot register capabilities after that. Register the same tools every time, because the
   * `tools/list` rendering is shared by every server the factory mints. Prefer the {@link CreateMcpServerOptions.tools}
   * option for tools, since a tool registered here is outside the argument guard and a malformed call to it gets the
   * SDK's `-32602` text instead of this package's JSON error envelope.
   */
  decorateServer?: ServerDecorator;
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
 * @returns The server, with its tools registered and not yet connected to a transport.
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
  const schema = options.extend ? extendSchemaForMcp(options.schema, options.extend) : options.schema;
  const descriptors = withOperations(schema, buildTools(schema, options), options);
  const executor = options.executor ?? createLocalExecutor(schema);
  const customTools = options.tools ?? [];
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // Shared by every server this factory mints; see `shareToolListing`.
  const listing: ToolListingCache = {};
  // Meta tools default to the surface the generated tools expose, so `execute` cannot reach past it.
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
      name: options.name ?? DEFAULT_SERVER_NAME,
      version: options.version ?? VERSION,
    });
    // Built per call: `execute` closes over this call's GraphQL context.
    const metaTools = metaOptions
      ? buildMetaTools({ schema, executor, resolveContext: (extra) => resolveContext(context, extra) }, metaOptions)
      : [];
    // Later wins by name: user `tools` override meta tools, both override generated ones.
    const byName = new Map<string, CustomTool>();
    for (const tool of [...metaTools, ...customTools]) {
      byName.set(tool.name, tool);
    }

    // The schema each tool's arguments are checked against, collected as they
    // are registered — the same objects the SDK will validate with.
    const validators = new Map<string, AnyZodType>();

    for (const descriptor of descriptors) {
      if (byName.has(descriptor.name)) {
        continue;
      }
      const input = strictInput(descriptor.inputSchema);
      validators.set(descriptor.name, input);
      registerGeneratedTool(server, { descriptor, input, executor, context, maxChars });
    }
    for (const tool of byName.values()) {
      registerCustomTool(server, tool);
      // Non-strict, because that is how the SDK wraps a raw shape: the check
      // here must not reject what the SDK would have accepted.
      if (tool.inputSchema) {
        validators.set(tool.name, z.object(tool.inputSchema));
      }
    }
    // Before the wrappers, and before `connect`: prompts and resources can only
    // declare their capabilities while no transport is attached.
    runServerDecorator(server, options.decorateServer);
    shareToolListing(server, listing);
    guardToolArguments(server, validators satisfies ToolValidators, maxChars);
    return server;
  };
}

/**
 * Folds any hand-written `operations` in over the generated descriptors.
 *
 * An operation replaces a generated tool of the same name and **keeps its
 * slot**, because `Map.set` on an existing key does not reorder: swapping one
 * tool's implementation should not shuffle the listing an agent may already
 * have read. Meta and custom tools still win over both, which is handled where
 * they are registered — final precedence is
 * `generated < operations < meta < tools`.
 *
 * Only the plain forms of the shared options carry over: a `selectionDepth`- or
 * `nullBranches`-style callback is handed a `GraphQLField`, and an operation
 * has none to hand it.
 *
 * @param schema - The extended schema the operations are validated against.
 * @param generated - The descriptors built from the schema, in listing order.
 * @param options - The server options, read for `operations` and the settings that carry over.
 * @returns The descriptors with each operation added or swapped in, or `generated` itself when there are none.
 */
function withOperations(
  schema: GraphQLSchema,
  generated: ToolDescriptor[],
  options: CreateMcpServerOptions,
): ToolDescriptor[] {
  if (!options.operations) {
    return generated;
  }
  const curated = buildOperationTools(schema, options.operations, {
    nameCase: options.nameCase,
    scalars: options.scalars,
    // A `{ byType }` object is keyed on the input type, so it carries over on purpose.
    // Only the per-field callback is dropped, because an operation has no root field to hand it.
    nullBranches: typeof options.nullBranches === 'function' ? undefined : options.nullBranches,
    // Carries over whole: it is already a pure function of the input type, so
    // it has nothing to say about the root field an operation lacks.
    inputField: options.inputField,
    mutationHints: options.mutationHints,
    exampleDepth: typeof options.exampleDepth === 'function' ? undefined : options.exampleDepth,
  });
  const byName = new Map(generated.map((descriptor) => [descriptor.name, descriptor]));
  for (const descriptor of curated) {
    byName.set(descriptor.name, descriptor);
  }
  return [...byName.values()];
}

/**
 * Reads a key off the `metaTools` object form (absent for the `true` form).
 *
 * @typeParam K - The meta tool option being read.
 * @param options - The server options that hold `metaTools`.
 * @param key - The meta tool option to read.
 * @returns The value, or `undefined` when `metaTools` is not an object or does not set the key.
 */
function pickMeta<K extends keyof MetaToolsOptions>(
  options: CreateMcpServerOptions,
  key: K,
): MetaToolsOptions[K] | undefined {
  return typeof options.metaTools === 'object' ? options.metaTools[key] : undefined;
}

/**
 * Runs the `decorateServer` hook, reporting the two ways it can be wrong.
 *
 * A hook is run once per minted server, so under a stateless HTTP handler a
 * throwing one fails every request, not one — the wrapped message says so,
 * because the stack alone reads like a transient fault.
 *
 * The thenable check is not paranoia: `(server) => void` structurally accepts an
 * `async` function, and the SDK throws on `registerCapabilities` after a
 * transport is attached — so an awaited registration would fail intermittently,
 * under load, far from its cause.
 *
 * @param server - The freshly minted server, not yet connected.
 * @param hook - The `decorateServer` option, or `undefined` when the caller gave none.
 */
function runServerDecorator(server: McpServer, hook: ServerDecorator | undefined): void {
  if (!hook) {
    return;
  }
  let result: unknown;
  try {
    result = hook(server);
  } catch (cause) {
    throw packageError(
      'the decorateServer hook threw while preparing a server. It runs on every ' +
        'server this factory mints, so a stateless handler will fail every request until it ' +
        'is fixed.',
      { cause },
    );
  }
  // Cast: the hook is typed `void`; this reads what an async one actually returned.
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw packageError(
      'decorateServer must be synchronous. The server is connected the moment it ' +
        'is returned, and the SDK refuses to register capabilities once a transport is ' +
        'attached — so anything registered after an await would answer prompts/list having ' +
        'told the client at initialize that there were none. Do the async work before creating ' +
        'the handler and close over the result.',
    );
  }
}

/**
 * Connects `server` to `transport`, treating a request that omits `arguments` as one that sent `{}`.
 *
 * The MCP schema makes `arguments` optional, but the SDK validates an omitted one as `undefined` and rejects the
 * request before the handler runs, so a tool or prompt that takes no arguments could not be called without them. The
 * message is corrected instead of the schema, because a schema that accepts `undefined` is no longer recognised as an
 * object schema and the tool is then listed with an empty one. Use this instead of `server.connect` on a server built
 * here.
 *
 * @param server - The MCP server to connect.
 * @param transport - The transport to connect it to.
 */
export async function connectServer(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
  const handler = transport.onmessage;
  if (!handler) {
    return;
  }
  transport.onmessage = (message, extra) => handler(withArguments(message), extra);
}

/** The name a server advertises when the caller gives none. */
const DEFAULT_SERVER_NAME = 'graphql-mcp-server';

/**
 * Requests whose `params.arguments` the MCP schema makes optional and whose SDK
 * handler parses it anyway: `tools/call` for a tool that takes no arguments, and
 * `prompts/get` for a prompt registered with an empty argument schema. Both are
 * the natural call for a client with nothing to send, and both are rejected
 * before the handler runs.
 */
const OPTIONAL_ARGUMENTS = new Set(['tools/call', 'prompts/get']);

/**
 * A request with no `arguments`, rewritten to carry an empty object.
 *
 * Copied rather than mutated: the caller's message may be shared (a transport is
 * free to hand the same parsed body to more than one listener), and a request
 * this rewrites in place would be seen changed by anything reading it after.
 *
 * @typeParam T - The type of the incoming message.
 * @param message - A raw JSON-RPC message from the transport.
 * @returns A copy with `params.arguments` set to `{}`, or the same message when it needs no change.
 */
function withArguments<T>(message: T): T {
  if (!message || typeof message !== 'object') {
    return message;
  }
  // Cast: a raw JSON-RPC message; each property is checked below before use.
  const request = message as { method?: unknown; params?: Record<string, unknown> };
  if (typeof request.method !== 'string' || OPTIONAL_ARGUMENTS.has(request.method) === false) {
    return message;
  }
  if (!request.params || typeof request.params !== 'object') {
    return message;
  }
  if (request.params.arguments !== undefined) {
    return message;
  }
  // Cast: the same message with one field filled in, so still a `T`.
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
    const input = strictInput(descriptor.inputSchema);
    registerGeneratedTool(server, { descriptor, input, executor, context, maxChars });
  }
}

/** One generated tool and what its handler runs against. */
interface GeneratedTool {
  descriptor: ToolDescriptor;
  /** The descriptor's input shape, made strict. */
  input: ReturnType<typeof buildStrictInput>;
  executor: GraphqlExecutor;
  context: unknown | ContextFactory;
  maxChars: number;
}

/**
 * Registers one generated tool on a server, with a handler that runs its operation through the executor.
 *
 * @param server - The MCP server to register the tool on.
 * @param tool - The descriptor with its strict input schema, executor, context and result budget.
 */
function registerGeneratedTool(
  server: McpServer,
  { descriptor, input, executor, context, maxChars }: GeneratedTool,
): void {
  server.registerTool(
    descriptor.name,
    {
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: input,
      annotations: descriptor.annotations,
    },
    async (args: Record<string, unknown>, extra: unknown) => {
      const mapped = await toVariables(descriptor, args, extra, maxChars);
      if ('failure' in mapped) {
        return mapped.failure;
      }
      const { variables } = mapped;
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

/**
 * The variables one call sends, or a finished failure result.
 *
 * Both failures are *reported*, never thrown: `result.ts` promises a parseable
 * JSON body on every outcome, and a caller that is a model needs the reason in
 * the body it already knows how to read.
 *
 * @param descriptor - The tool being called, read for its argument names and optional mapper.
 * @param args - The validated arguments of the call.
 * @param extra - The MCP `extra` of the call, passed to the mapper.
 * @param maxChars - Character budget for a failure result.
 * @returns The declared variables that have a value, or a `failure` when the mapper throws or returns an
 * undeclared name.
 */
async function toVariables(
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
  extra: unknown,
  maxChars: number,
): Promise<{ variables: Record<string, unknown> } | { failure: CallToolResult }> {
  let source = args;
  if (descriptor.mapArgs) {
    try {
      source = await descriptor.mapArgs(args, extra);
    } catch (error) {
      // A mapper holds the server's own argument rules, so what it throws is usually something the caller can fix.
      const message = error instanceof Error ? error.message : String(error);
      return { failure: failureOf(message, BAD_INPUT, maxChars) };
    }
    const declared = new Set(descriptor.argNames);
    const undeclared = Object.keys(source).filter((key) => declared.has(key) === false);
    if (undeclared.length) {
      // graphql-js silently drops an undeclared variable, so the call would succeed with the mapped intent discarded.
      // The message blames the server so that an agent stops instead of retrying its own input.
      const message =
        `Tool '${descriptor.name}' is misconfigured: its argument mapper returned ` +
        `${undeclared.map((key) => `'${key}'`).join(', ')}, which the operation does ` +
        'not declare. Retrying with different arguments will not help.';
      return { failure: failureOf(message, BAD_TOOL_CONFIG, maxChars) };
    }
  }
  const variables: Record<string, unknown> = {};
  for (const argName of descriptor.argNames) {
    if (source[argName] !== undefined) {
      variables[argName] = source[argName];
    }
  }
  return { variables };
}

/**
 * A failed call reported as a result: one error carrying a machine-readable code.
 *
 * @param message - What went wrong, written for the caller.
 * @param code - `BAD_INPUT` or `BAD_TOOL_CONFIG`.
 * @param maxChars - Character budget for the result body.
 * @returns The error result.
 */
function failureOf(message: string, code: string, maxChars: number): CallToolResult {
  return toCallToolResult({ errors: [{ message, extensions: { code } }] }, maxChars);
}

/**
 * The strict object schema for each descriptor shape, which a generated tool's arguments are registered and checked
 * against. It is strict because the SDK wraps a raw shape in a plain `z.object` that strips unknown keys, so a
 * misspelled argument would be discarded and the call would still succeed. Each schema is built once per shape, because
 * stateless HTTP registers every tool again on every request.
 */
const strictInputs = new WeakMap<ZodShape, ReturnType<typeof buildStrictInput>>();

/**
 * Builds the object schema that rejects any key the shape does not declare.
 *
 * @param shape - The input shape of a generated tool.
 * @returns The strict Zod object schema.
 */
function buildStrictInput(shape: ZodShape) {
  return z.object(shape).strict();
}

/**
 * Gives the strict schema for a shape, building it on first use and reusing it afterwards.
 *
 * @param shape - The input shape of a generated tool.
 * @returns The cached strict Zod object schema.
 */
function strictInput(shape: ZodShape): ReturnType<typeof buildStrictInput> {
  const cached = strictInputs.get(shape);
  if (cached) {
    return cached;
  }
  const schema = buildStrictInput(shape);
  strictInputs.set(shape, schema);
  return schema;
}

/**
 * Registers a user-supplied tool on a server, with or without an input schema.
 *
 * @param server - The MCP server to register the tool on.
 * @param tool - The tool to register.
 */
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

/**
 * Resolves the GraphQL context for one call.
 *
 * @param context - A static context value, or a factory that derives one.
 * @param extra - The MCP `extra` of the call, passed to the factory.
 * @returns What the factory returns, or the static value as given.
 */
async function resolveContext(context: unknown | ContextFactory, extra: unknown): Promise<unknown> {
  // Cast: `typeof` narrows `unknown` to `Function`, not to the factory's signature.
  return typeof context === 'function' ? await (context as ContextFactory)(extra) : context;
}
