/**
 * Sharing of the rendered `tools/list` response across the servers a factory
 * mints.
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
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const TOOLS_LIST = 'tools/list';

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
