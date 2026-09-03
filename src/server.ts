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
 * introspection; issue #15 records what registering it would actually take.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GraphQLSchema } from 'graphql';
import { z } from 'zod';
import { createLocalExecutor } from './executor.ts';
import { extendSchemaForMcp, type SchemaExtension } from './extend.ts';
import {
  BAD_INPUT,
  BAD_TOOL_CONFIG,
  guardToolArguments,
  shareToolListing,
  type ToolListingCache,
  type ToolValidators,
} from './handlers.ts';
import { buildMetaTools, type MetaToolsOptions } from './meta.ts';
import { buildOperationTools, type OperationsInput } from './operations.ts';
import { DEFAULT_MAX_CHARS, runExecutor, toCallToolResult } from './result.ts';
import { type BuildToolsOptions, buildTools, type ToolDescriptor } from './tools.ts';
import type { GraphqlExecutor, ToolAnnotations } from './types.ts';
import { VERSION } from './version.ts';
import type { AnyZodType, ZodShape } from './zodCompat.ts';

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
   * Hand-written GraphQL documents to expose as tools, alongside — or instead
   * of — the generated ones ({@link buildOperationTools}).
   *
   * A generated surface is complete and impersonal; a curated one is a bet that
   * you know the questions. They compose, and that is the point: an operation
   * named `todos` *replaces* the generated `todos` tool, so you can keep the
   * whole generated surface and hand-write only the tool whose argument shape
   * an agent keeps getting wrong.
   *
   * Takes documents, never paths — a factory is synchronous, and a top-level
   * `node:fs` import would make this package unloadable on a fetch runtime. On
   * Node that is one line at the call site, and a `Source` is what puts the
   * file name into every boot-time error:
   *
   * ```ts
   * operations: globSync('mcp/*.graphql').map(
   *   (path) => new Source(readFileSync(path, 'utf8'), path),
   * ),
   * ```
   *
   * Documents validate against the *extended* schema, so an operation may
   * select an MCP-only field. `nameCase`, `scalars`, `mutationHints`,
   * `inputField`, `nullBranches` and `exampleDepth` carry over in their plain
   * forms — and `inputField`, plus a `nullBranches: { byType }`, carry over
   * whole, being type-keyed already; their *field* callback forms take a
   * `GraphQLField`, which an operation has no counterpart for, and are not
   * applied here. `include`/`exclude`/`filter`,
   * `selectionDepth`, `toolName` and `extensions.mcp` do not apply at all —
   * they project a schema, and you wrote this document yourself.
   */
  operations?: OperationsInput;
  /**
   * Runs against each server this factory mints, before it is connected — the
   * hook for everything the MCP SDK offers that this package does not generate:
   * `registerPrompt`, `registerResource`, completions.
   *
   * It has to run here rather than after `connect`, because the SDK's
   * `registerCapabilities` throws once a transport is attached: a prompt
   * registered later answers `prompts/list` while having told the client at
   * `initialize` that the server had none.
   *
   * **Synchronous.** `createMcpServer` and {@link ServerFactory} return a server,
   * not a promise, and both shipped handlers connect it the moment it comes
   * back — so an awaited registration would be racing `initialize`. A hook
   * returning a promise is refused rather than silently losing its
   * capabilities. Do async setup before building the handler and close over the
   * result.
   *
   * **Register the same tools every time.** The `tools/list` a factory renders
   * is shared across every server it mints, so a hook whose *tool* set varies
   * would serve one caller's listing to another. Prompts and resources may vary
   * freely — only the tool listing is cached. Prefer the {@link
   * CreateMcpServerOptions.tools} option for tools anyway: a tool registered
   * here is outside the argument guard, so a malformed call to it gets the
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
  const descriptors = withOperations(schema, buildTools(schema, options), options);
  const executor = options.executor ?? createLocalExecutor(schema);
  const customTools = options.tools ?? [];
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // Meta tools default to the same surface the generated tools expose, so the
  // raw-document `execute` path can't reach past it.
  // Shared by every server this factory mints; see `shareToolListing`.
  const listing: ToolListingCache = {};
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

    // The schema each tool's arguments are checked against, collected as they
    // are registered — the same objects the SDK will validate with.
    const validators = new Map<string, AnyZodType>();

    for (const descriptor of descriptors) {
      if (byName.has(descriptor.name)) continue;
      const input = strictInput(descriptor.inputSchema);
      validators.set(descriptor.name, input);
      registerGeneratedTool(server, descriptor, input, executor, context, maxChars);
    }
    for (const tool of byName.values()) {
      registerCustomTool(server, tool);
      // Non-strict, because that is how the SDK wraps a raw shape: the check
      // here must not reject what the SDK would have accepted.
      if (tool.inputSchema) validators.set(tool.name, z.object(tool.inputSchema));
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
 */
function withOperations(
  schema: GraphQLSchema,
  generated: ToolDescriptor[],
  options: CreateMcpServerOptions,
): ToolDescriptor[] {
  if (!options.operations) return generated;
  const curated = buildOperationTools(schema, options.operations, {
    nameCase: options.nameCase,
    scalars: options.scalars,
    // A `{ byType }` object is not a function, so it survives this test and
    // carries over on purpose: like `inputField`, it is keyed on the input type
    // and has nothing to say about the root field an operation lacks. Only the
    // per-*field* callback is dropped.
    nullBranches: typeof options.nullBranches === 'function' ? undefined : options.nullBranches,
    // Carries over whole: it is already a pure function of the input type, so
    // it has nothing to say about the root field an operation lacks.
    inputField: options.inputField,
    mutationHints: options.mutationHints,
    exampleDepth: typeof options.exampleDepth === 'function' ? undefined : options.exampleDepth,
  });
  const byName = new Map(generated.map((descriptor) => [descriptor.name, descriptor]));
  for (const descriptor of curated) byName.set(descriptor.name, descriptor);
  return [...byName.values()];
}

/** Reads a key off the `metaTools` object form (absent for the `true` form). */
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
 */
function runServerDecorator(server: McpServer, hook: ServerDecorator | undefined): void {
  if (!hook) return;
  let result: unknown;
  try {
    result = hook(server);
  } catch (cause) {
    throw new Error(
      'graphql-mcp: the decorateServer hook threw while preparing a server. It runs on every ' +
        'server this factory mints, so a stateless handler will fail every request until it ' +
        'is fixed.',
      { cause },
    );
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error(
      'graphql-mcp: decorateServer must be synchronous. The server is connected the moment it ' +
        'is returned, and the SDK refuses to register capabilities once a transport is ' +
        'attached — so anything registered after an await would answer prompts/list having ' +
        'told the client at initialize that there were none. Do the async work before creating ' +
        'the handler and close over the result.',
    );
  }
}

/**
 * Connects `server` to `transport`, treating a request that omits `arguments`
 * as one that sent `{}`.
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
 * `prompts/get` has the same shape of bug for a prompt registered with an empty
 * argument schema, so both methods are corrected.
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
 */
function withArguments<T>(message: T): T {
  if (!message || typeof message !== 'object') return message;
  const request = message as { method?: unknown; params?: Record<string, unknown> };
  if (typeof request.method !== 'string' || !OPTIONAL_ARGUMENTS.has(request.method)) return message;
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
    registerGeneratedTool(
      server,
      descriptor,
      strictInput(descriptor.inputSchema),
      executor,
      context,
      maxChars,
    );
  }
}

function registerGeneratedTool(
  server: McpServer,
  descriptor: ToolDescriptor,
  input: ReturnType<typeof buildStrictInput>,
  executor: GraphqlExecutor,
  context: unknown | ContextFactory,
  maxChars: number,
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
      if ('failure' in mapped) return mapped.failure;
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
      // The mapper is where a server puts its own argument rules, so what it
      // throws is usually something the caller can act on — `BAD_INPUT` is the
      // code an agent already knows to read as "fix your arguments".
      const message = error instanceof Error ? error.message : String(error);
      return {
        failure: toCallToolResult(
          { errors: [{ message, extensions: { code: BAD_INPUT } }] },
          maxChars,
        ),
      };
    }
    const declared = new Set(descriptor.argNames);
    const undeclared = Object.keys(source).filter((key) => !declared.has(key));
    if (undeclared.length) {
      // graphql-js drops an undeclared variable without a word, so left alone
      // this is a call that succeeds with the mapped intent discarded. Say it is
      // the server's fault, so an agent stops rather than retrying its own input.
      return {
        failure: toCallToolResult(
          {
            errors: [
              {
                message:
                  `Tool '${descriptor.name}' is misconfigured: its argument mapper returned ` +
                  `${undeclared.map((key) => `'${key}'`).join(', ')}, which the operation does ` +
                  'not declare. Retrying with different arguments will not help.',
                extensions: { code: BAD_TOOL_CONFIG },
              },
            ],
          },
          maxChars,
        ),
      };
    }
  }
  const variables: Record<string, unknown> = {};
  for (const argName of descriptor.argNames) {
    if (source[argName] !== undefined) variables[argName] = source[argName];
  }
  return { variables };
}

/**
 * The schema a generated tool's arguments are registered and checked against:
 * a *strict* object over the descriptor's shape, built once.
 *
 * Strict rather than the raw shape, because handed a shape the SDK wraps it in a
 * plain `z.object`, which strips unknown keys — while the listing it renders
 * from that same schema says `additionalProperties: false`. An agent that
 * misspells an argument would otherwise get a success result with its typo
 * quietly discarded. The descriptor keeps exposing the raw shape, so `decorate`
 * and custom tools are unaffected.
 *
 * Built once because a descriptor's shape is fixed and a Zod schema is
 * stateless, so one object can back every server built from it — worth hoisting
 * because stateless HTTP re-registers every tool on every request. Keyed on the
 * shape rather than the descriptor, so `decorate`d copies sharing a shape share
 * the schema too.
 */
const strictInputs = new WeakMap<ZodShape, ReturnType<typeof buildStrictInput>>();

function buildStrictInput(shape: ZodShape) {
  return z.object(shape).strict();
}

function strictInput(shape: ZodShape): ReturnType<typeof buildStrictInput> {
  const cached = strictInputs.get(shape);
  if (cached) return cached;
  const schema = buildStrictInput(shape);
  strictInputs.set(shape, schema);
  return schema;
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
