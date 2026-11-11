/**
 * Wraps the SDK's `tools/list` and `tools/call` request handlers, and holds the one SDK internal used to find them.
 * Both wrappers delegate to the SDK's own handler and do nothing if it cannot be found, so a change in the SDK's
 * internals costs a slower listing and a worse error message, never a wrong answer.
 *
 * `tools/list` is rendered once per factory and tool set, because the SDK converts every Zod input schema to JSON
 * Schema on each request and stateless HTTP mints a fresh server per request. The arguments of `tools/call` are checked before the SDK
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
 * One factory's rendered listings, one per set of tools a server offers, so servers that offer different tools are
 * never handed each other's listing. The table is bounded and evicts the least recently used set, because a set is
 * chosen per caller and the number of distinct ones is the host's, not this package's; an evicted set is rendered
 * again. `off` latches: once any server's tool set has changed after it was minted, servers can disagree about what
 * they expose and no rendered listing is right for any of them.
 */
export class ToolListings {
  /** Set once a server's tools change after registration; from then on every listing renders afresh. */
  off = false;
  readonly #max: number;
  readonly #renderings = new Map<string, { rendering?: Promise<unknown> }>();

  /**
   * Creates an empty table.
   *
   * @param max - Tool sets to keep a rendering for at once.
   */
  constructor(max: number) {
    this.#max = max;
  }

  /**
   * The slot for one tool set, created when the set is new and moved to most recently used either way.
   *
   * @param names - The names of the tools a server registered, in registration order.
   * @returns The slot whose `rendering` every server offering exactly these tools shares.
   */
  slot(names: ReadonlyArray<string>): { rendering?: Promise<unknown> } {
    const key = JSON.stringify(names);
    const slot = this.#renderings.get(key) ?? {};
    this.#renderings.delete(key);
    this.#renderings.set(key, slot);
    if (this.#renderings.size > this.#max) {
      const oldest = this.#renderings.keys().next().value;
      if (oldest !== undefined) {
        this.#renderings.delete(oldest);
      }
    }
    return slot;
  }

  /** Stops sharing for good and drops every held rendering. */
  retire(): void {
    this.off = true;
    this.#renderings.clear();
  }
}

/**
 * Points `server`'s `tools/list` at the shared rendering for the tools it registered, rendering it (via the SDK) on
 * the first request that needs it and reusing that answer everywhere after.
 *
 * Call it once, after every tool is registered. Any later change to the tool set — a `registerTool` on the live
 * server, or `enable`/`disable`/`update`/`remove` on a registered one — retires sharing for good: each of those paths
 * calls `sendToolListChanged`, which is what this hooks.
 *
 * @param server - A freshly built server, all tools already registered.
 * @param listings - The table shared by every server from the same factory.
 * @param names - The names of the tools the server registered, which pick its slot in `listings`.
 */
export function shareToolListing(server: McpServer, listings: ToolListings, names: ReadonlyArray<string>): void {
  const handlers = requestHandlers(server);
  const render = handlers?.get(TOOLS_LIST);
  if (!handlers || !render) {
    return;
  }
  const slot = listings.slot(names);

  handlers.set(TOOLS_LIST, (request, extra) => {
    if (listings.off) {
      return render(request, extra);
    }
    // Stored as the promise, not the value: two listings arriving together on a
    // cold cache should share one rendering rather than both paying for it.
    slot.rendering ??= render(request, extra).catch((error: unknown) => {
      slot.rendering = undefined;
      throw error;
    });
    return slot.rendering;
  });

  const notify = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {
    listings.retire();
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
