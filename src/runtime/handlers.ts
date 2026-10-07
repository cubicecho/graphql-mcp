/**
 * Wraps the SDK's `tools/list` and `tools/call` request handlers, and holds the one SDK internal used to find them.
 * Both wrappers delegate to the SDK's own handler and do nothing if it cannot be found, so a change in the SDK's
 * internals costs a slower listing and a worse error message, never a wrong answer.
 *
 * `tools/list` is rendered once per factory, because the SDK converts every Zod input schema to JSON Schema on each
 * request and stateless HTTP mints a fresh server per request. The arguments of `tools/call` are checked before the SDK
 * checks them, because the SDK reports a validation failure as bare text while every other outcome is the JSON envelope
 * that `result.ts` documents.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { messageOf } from '../core/errors.ts';
import type { GraphqlError } from '../core/types.ts';
import type { AnyZodType } from '../core/zod-compat.ts';
import { toCallToolResult } from '../output/result.ts';

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
  const handlers = requestHandlers(server);
  const render = handlers?.get(TOOLS_LIST);
  if (!handlers || !render) {
    return;
  }

  handlers.set(TOOLS_LIST, (request, extra) => {
    if (cache.off) {
      return render(request, extra);
    }
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
export function guardToolArguments(server: McpServer, validators: ToolValidators, maxChars: number): void {
  const handlers = requestHandlers(server);
  const call = handlers?.get(TOOLS_CALL);
  if (!handlers || !call) {
    return;
  }

  handlers.set(TOOLS_CALL, async (request, extra) => {
    // Cast: a raw request; `name` and `arguments` are checked below before use.
    const params = (request as { params?: { name?: unknown; arguments?: unknown } }).params;
    const schema = typeof params?.name === 'string' ? validators.get(params.name) : undefined;
    if (!schema) {
      return call(request, extra);
    }
    // Async to match the SDK's own `safeParseAsync`: a schema with an async
    // refinement must not be accepted here and rejected there.
    const parsed = await schema.safeParseAsync(params?.arguments);
    if (parsed.success) {
      return call(request, extra);
    }
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
 *
 * @param error - The error from a failed parse, normally a `ZodError`.
 * @returns One `BAD_INPUT` error per issue, or a single one when the error carries no issues.
 */
function inputErrors(error: unknown): GraphqlError[] {
  // Cast: a `ZodError` under either major has `issues`; anything else has none.
  const issues = (error as { issues?: ReadonlyArray<ZodIssue> } | undefined)?.issues;
  if (!issues?.length) {
    return [
      {
        message: messageOf(error, 'The arguments were rejected.'),
        extensions: { code: BAD_INPUT },
      },
    ];
  }
  return issues.map((issue) => {
    const where = argumentPath(issue.path);
    return {
      message: where ? `${issue.message} at \`${where}\`` : issue.message,
      extensions: { code: BAD_INPUT },
    };
  });
}

/**
 * A Zod issue path as an agent would write it: `steps[0].order`.
 *
 * @param path - The keys and indexes leading to the rejected value.
 * @returns The rendered path, or an empty string when the path is missing or empty.
 */
function argumentPath(path: ReadonlyArray<PropertyKey> | undefined): string {
  if (!path?.length) {
    return '';
  }
  return path.reduce<string>((rendered, key) => {
    if (typeof key === 'number') {
      return `${rendered}[${key}]`;
    }
    return rendered ? `${rendered}.${String(key)}` : String(key);
  }, '');
}

/**
 * The SDK's handler table — the one internal this module reaches for.
 *
 * `Protocol.setRequestHandler` would replace a handler outright, and there is no
 * public way to get the one already installed; wrapping needs it. Absent means
 * the SDK moved it, and every caller here treats that as "leave the SDK alone".
 *
 * @param server - The server whose handler table is wanted.
 * @returns The table keyed by request method, or `undefined` when the SDK no longer has it there.
 */
function requestHandlers(server: McpServer): Map<string, RawRequestHandler> | undefined {
  return (server.server as unknown as { _requestHandlers?: Map<string, RawRequestHandler> })._requestHandlers;
}
