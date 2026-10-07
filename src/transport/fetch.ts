/**
 * The `Request`/`Response` counterpart to {@link createHttpHandler}, for fetch-shaped hosts such as Cloudflare
 * Workers, Deno, Bun and Hono. It behaves as `http.ts` documents, over the SDK's web-standard transport. That
 * transport is imported on first use because it only exists in `@modelcontextprotocol/sdk` 1.25 and later, and a
 * top-level import would make the whole package unloadable on the older SDKs the peer range allows.
 * {@link SessionStore} is per-process memory, so stay stateless on Cloudflare Workers unless each session is pinned to
 * one isolate, for example with a Durable Object per session.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageError } from '../core/errors.ts';
import { type CreateMcpServerOptions, connectServer, createServerFactory } from '../runtime/server.ts';
import type { EventStore } from './event-store.ts';
import { closeQuietly, SESSION_ID_HEADER, SessionHost, type SessionOptions } from './sessions.ts';

/** A fetch-style MCP handler: give it a `Request`, get a `Response`. */
export interface McpFetchHandler {
  (request: Request): Promise<Response>;
  /**
   * Ends every live session and releases the servers behind them. A no-op in
   * stateless mode. Call it on shutdown so open SSE streams close cleanly.
   */
  close(): Promise<void>;
}

/** Options for {@link createFetchHandler}. */
export interface FetchHandlerOptions extends CreateMcpServerOptions {
  /**
   * Derive per-request GraphQL context from the incoming `Request` (e.g. read an
   * auth header). Takes precedence over the `context` option.
   *
   * With `sessions` enabled this runs only on the request that creates the
   * session and is then reused for its lifetime — see the same note on
   * {@link HttpHandlerOptions.contextFromRequest}.
   */
  contextFromRequest?: (request: Request) => unknown | Promise<unknown>;
  /**
   * Keep a server alive per client session instead of one per request. Off by
   * default, and a poor fit for isolate-per-request platforms — see the module
   * note above.
   */
  sessions?: boolean | SessionOptions;
}

/** The subset of the web-standard transport this module drives. */
interface WebTransport {
  sessionId?: string;
  onclose?: () => void;
  handleRequest(request: Request, options?: { parsedBody?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

/** Constructor options passed straight through to the SDK transport. */
interface WebTransportOptions {
  sessionIdGenerator?: () => string;
  enableJsonResponse?: boolean;
  eventStore?: EventStore;
  onsessioninitialized?: (id: string) => void | Promise<void>;
  onsessionclosed?: (id: string) => void | Promise<void>;
}

type WebTransportCtor = new (options: WebTransportOptions) => WebTransport;

const REQUIRED_SDK = '1.25';
let ctorPromise: Promise<WebTransportCtor> | undefined;

/**
 * Loads the web-standard transport once, caching the promise so concurrent
 * first requests share a single import.
 *
 * @returns The transport's constructor. The promise rejects if the installed SDK lacks the web-standard transport.
 */
async function loadTransport(): Promise<WebTransportCtor> {
  ctorPromise ??= import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    .then(
      // Cast: the SDK's class is read through the structural type this file declares for it.
      (module) => module.WebStandardStreamableHTTPServerTransport as unknown as WebTransportCtor,
    )
    .catch((cause) => {
      ctorPromise = undefined; // Let a later call retry rather than cache the failure.
      throw packageError(
        `createFetchHandler needs @modelcontextprotocol/sdk >= ${REQUIRED_SDK}, ` +
          'which is where WebStandardStreamableHTTPServerTransport was added. Upgrade the SDK, ' +
          'or use createHttpHandler on a Node server.',
        { cause },
      );
    });
  return ctorPromise;
}

/**
 * Creates a `(Request) => Response` handler serving the schema's tools over MCP.
 *
 * @param options - The same options as {@link createMcpServer}, plus
 *   `contextFromRequest` and `sessions`.
 * @returns A fetch handler carrying a `close()` for shutdown.
 * @throws If the installed MCP SDK predates the web-standard transport — on the
 *   first call, not at import, so Node users on an older SDK are unaffected.
 * @example
 * ```ts
 * // Cloudflare Workers / Deno / Bun
 * const handler = createFetchHandler({ schema });
 * export default { fetch: handler };
 *
 * // Hono
 * app.all('/mcp', (c) => handler(c.req.raw));
 * ```
 */
export function createFetchHandler(options: FetchHandlerOptions): McpFetchHandler {
  const { contextFromRequest, sessions, ...serverOptions } = options;
  const makeServer = createServerFactory(serverOptions);
  const host = SessionHost.from<WebTransport>(sessions);

  const handler = async (request: Request): Promise<Response> => {
    const Transport = await loadTransport();
    const contextOverride = contextFromRequest ? () => contextFromRequest(request) : undefined;

    if (!host) {
      const server = makeServer(contextOverride);
      const transport = new Transport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await connect(server, transport);
      const response = await transport.handleRequest(request);
      // Unlike the Node path there is no `res.on('close')` to hang teardown on, and the stateless Response body is
      // already fully buffered as JSON.
      await closeQuietly({ server, transport });
      return response;
    }

    const sessionId = request.headers.get(SESSION_ID_HEADER);
    if (sessionId) {
      const existing = host.store.take(sessionId);
      if (!existing?.transport) {
        const miss = await host.miss(sessionId);
        return new Response(miss.body, { status: miss.status, headers: miss.headers });
      }
      return existing.transport.handleRequest(request);
    }

    const server = makeServer(contextOverride);
    const transport = host.begin(server, (options) => new Transport(options));
    await connect(server, transport);
    const response = await transport.handleRequest(request);
    await host.settle(server, transport);
    return response;
  };

  handler.close = async (): Promise<void> => {
    await host?.store.closeAll();
  };
  return handler;
}

/**
 * Connects a server to the loaded transport.
 *
 * The transport satisfies the SDK's `Transport` interface, but this module
 * models only the parts it drives so the public types stay independent of an
 * SDK version the peer range doesn't require — hence the cast at this one seam.
 *
 * @param server - The server that will answer requests arriving on the transport.
 * @param transport - The web-standard transport to attach to the server.
 */
async function connect(server: McpServer, transport: WebTransport): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: bridging the structural WebTransport to the SDK's Transport
  await connectServer(server, transport as any);
}
