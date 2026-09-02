/**
 * The two SDK request handlers this package wraps, and the one internal it
 * reaches through to find them.
 *
 * Both wrappers delegate to the SDK's own handler for everything they are not
 * changing, and both no-op if that handler can't be found — so an SDK that moves
 * its internals costs a slower listing and a worse error message, never a wrong
 * answer. Keeping the reach-through in one place is the point of the module.
 *
 * ## `tools/list` — rendered once per factory
 *
 * The MCP SDK converts every tool's Zod input schema to JSON Schema *inside* its
 * `tools/list` handler — on each request, not once at registration. For a schema
 * with fat input objects (a generated CRUD API, say, where each field takes a
 * filter with an operator object per column) that conversion is the bulk of the
 * request: pure CPU, on the event loop, so concurrent listings serialize behind
 * each other. Stateless HTTP mints a fresh server per request, so it is paid
 * again on every single one.
 *
 * The SDK's handler reads neither the request nor the `extra` — its output is a
 * function of the registered tools alone, and every server a factory mints
 * registers the same ones. So the first rendering is kept and handed to all the
 * rest.
 *
 * The rendering itself is still the SDK's: this wraps its handler rather than
 * reimplementing it, so the listing stays byte-for-byte what the SDK would have
 * produced, including whatever it grows next. If its internals move and the
 * handler can't be found, nothing is cached and every listing is rendered as it
 * was before — slower, never wrong.
 *
 * ## `tools/call` — arguments checked before the SDK rejects them
 *
 * The SDK validates a call's `arguments` against the registered Zod schema
 * before the tool's handler runs, and reports a failure by putting the bare
 * message in the result's text: `MCP error -32602: Input validation error:
 * Invalid arguments for tool tasks: …`. Every other outcome of a generated tool
 * — success, a GraphQL error, a partial result, an executor that threw — comes
 * back as the JSON envelope `result.ts` documents, so a malformed call was the
 * one failure whose body did not parse. That is the failure an agent hits most
 * (a wrong scalar, a misspelled key, a bad enum member), and the correction it
 * most needs to read.
 *
 * So the arguments are checked *first*, with the same schema the SDK is about to
 * use, and a rejection is returned through {@link toCallToolResult} like
 * anything else — one Zod issue per `errors` entry, each pointing at the
 * argument it is about. A call that passes is handed to the SDK untouched, which
 * validates it again; that second parse is what keeps this a pure addition
 * rather than a reimplementation of the call path.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toCallToolResult } from './result.ts';
import type { GraphqlError } from './types.ts';
import type { AnyZodType } from './zodCompat.ts';

const TOOLS_LIST = 'tools/list';
const TOOLS_CALL = 'tools/call';

/** The SDK's stored form of a handler: the request is parsed inside it. */
type RawRequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * One factory's shared listing. `off` latches: once any server's tool set has
 * changed, servers can disagree about what they expose and no single listing is
 * right for all of them.
 */
export interface ToolListingCache {
  rendering?: Promise<unknown>;
  off?: true;
}

/**
 * Points `server`'s `tools/list` at `cache`, rendering it (via the SDK) on the
 * first request that needs it and reusing that answer everywhere after.
 *
 * Call it once, after every tool is registered. Any later change to the tool set
 * — a `registerTool` on the live server, or `enable`/`disable`/`update`/`remove`
 * on a registered one — retires the cache for good: each of those paths calls
 * `sendToolListChanged`, which is what this hooks.
 *
 * @param server - A freshly built server, all tools already registered.
 * @param cache - The cache shared by every server from the same factory.
 */
export function shareToolListing(server: McpServer, cache: ToolListingCache): void {
  const handlers = (
    server.server as unknown as { _requestHandlers?: Map<string, RawRequestHandler> }
  )._requestHandlers;
  const render = handlers?.get(TOOLS_LIST);
  if (!handlers || !render) return;

  handlers.set(TOOLS_LIST, (request, extra) => {
    if (cache.off) return render(request, extra);
    // Stored as the promise, not the value: two listings arriving together on a
    // cold cache should share one rendering rather than both paying for it.
    cache.rendering ??= render(request, extra).catch((error: unknown) => {
      cache.rendering = undefined;
      throw error;
    });
    return cache.rendering;
  });

  const notify = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {
    cache.off = true;
    cache.rendering = undefined;
    notify();
  };
}

/**
 * The Zod schema each tool's arguments are checked against, keyed by tool name.
 * A tool registered without an input schema is absent — the SDK does not
 * validate one either.
 */
export type ToolValidators = ReadonlyMap<string, AnyZodType>;

/** `extensions.code` on an error raised by argument validation. */
export const BAD_INPUT = 'BAD_INPUT';

/**
 * `extensions.code` on an error the *caller* cannot fix: the server's own
 * configuration produced a call that cannot be sent.
 *
 * Distinct from {@link BAD_INPUT} because the two ask for opposite responses. An
 * agent that reads `BAD_INPUT` should adjust its arguments and retry; an agent
 * that reads this should stop, because retrying its own arguments cannot
 * possibly help.
 */
export const BAD_TOOL_CONFIG = 'BAD_TOOL_CONFIG';

/**
 * Checks a `tools/call`'s arguments before the SDK does, so a rejection comes
 * back as the same JSON envelope as every other outcome.
 *
 * A call whose arguments parse is passed straight to the SDK's handler, as is
 * one naming a tool not in `validators` (an unknown tool, or one registered
 * without an input schema — the SDK's own answer is the right one there).
 *
 * @param server - A freshly built server, all tools already registered.
 * @param validators - The schema per tool name; see {@link ToolValidators}.
 * @param maxChars - Character budget for the rendered error body.
 */
export function guardToolArguments(
  server: McpServer,
  validators: ToolValidators,
  maxChars: number,
): void {
  const handlers = requestHandlers(server);
  const call = handlers?.get(TOOLS_CALL);
  if (!handlers || !call) return;

  handlers.set(TOOLS_CALL, async (request, extra) => {
    const params = (request as { params?: { name?: unknown; arguments?: unknown } }).params;
    const schema = typeof params?.name === 'string' ? validators.get(params.name) : undefined;
    if (!schema) return call(request, extra);
    // Async to match the SDK's own `safeParseAsync`: a schema with an async
    // refinement must not be accepted here and rejected there.
    const parsed = await schema.safeParseAsync(params?.arguments);
    if (parsed.success) return call(request, extra);
    return toCallToolResult({ errors: inputErrors(parsed.error) }, maxChars);
  });
}

/** A Zod issue, spelled to hold across both majors. */
interface ZodIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey>;
}

/**
 * A Zod failure as GraphQL-shaped errors: one per issue, so a call that got two
 * arguments wrong is told about both rather than only the first (which is all
 * the SDK's message carries).
 */
function inputErrors(error: unknown): GraphqlError[] {
  const issues = (error as { issues?: ReadonlyArray<ZodIssue> } | undefined)?.issues;
  if (!issues?.length) {
    return [{ message: messageOf(error), extensions: { code: BAD_INPUT } }];
  }
  return issues.map((issue) => {
    const where = argumentPath(issue.path);
    return {
      message: where ? `${issue.message} at \`${where}\`` : issue.message,
      extensions: { code: BAD_INPUT },
    };
  });
}

/** A Zod issue path as an agent would write it: `steps[0].order`. */
function argumentPath(path: ReadonlyArray<PropertyKey> | undefined): string {
  if (!path?.length) return '';
  return path.reduce<string>((rendered, key) => {
    if (typeof key === 'number') return `${rendered}[${key}]`;
    return rendered ? `${rendered}.${String(key)}` : String(key);
  }, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SDK's handler table — the one internal this module reaches for.
 *
 * `Protocol.setRequestHandler` would replace a handler outright, and there is no
 * public way to get the one already installed; wrapping needs it. Absent means
 * the SDK moved it, and every caller here treats that as "leave the SDK alone".
 */
function requestHandlers(server: McpServer): Map<string, RawRequestHandler> | undefined {
  return (server.server as unknown as { _requestHandlers?: Map<string, RawRequestHandler> })
    ._requestHandlers;
}
