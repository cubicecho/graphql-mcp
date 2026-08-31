/**
 * The `Request`/`Response` counterpart to {@link createHttpHandler}, for
 * runtimes that never had Node's `IncomingMessage`/`ServerResponse`:
 * Cloudflare Workers, Deno, Bun, Hono, and any other fetch-shaped host.
 *
 * The behaviour is the same one `http.ts` documents — stateless JSON per
 * request by default, optional stateful sessions — over the SDK's web-standard
 * transport rather than its Node wrapper.
 *
 * ## Why the transport is imported lazily
 *
 * `WebStandardStreamableHTTPServerTransport` only exists in `@modelcontextprotocol/sdk`
 * 1.25 and later, while this package's peer range starts at 1.12. A top-level
 * import would make the *entire* package unloadable on an older SDK — including
 * for the Node users who will never call this function. Importing on first use
 * confines the requirement to the one entry point that actually needs it, and
 * turns "module not found" into a sentence saying which version to install.
 *
 * ## Sessions on edge runtimes
 *
 * {@link SessionStore} is per-process memory. That is fine on Deno, Bun, or a
 * long-lived Node worker, and wrong on Cloudflare Workers, where consecutive
 * requests may land in different isolates and a session id would resolve on one
 * and 404 on the next. Stay stateless there unless you have pinned routing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CreateMcpServerOptions, createServerFactory } from './server.ts';
import { type Session, type SessionOptions, SessionStore } from './sessions.ts';

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
  onsessioninitialized?: (id: string) => void | Promise<void>;
  onsessionclosed?: (id: string) => void | Promise<void>;
}

type WebTransportCtor = new (options: WebTransportOptions) => WebTransport;

const REQUIRED_SDK = '1.25';
let ctorPromise: Promise<WebTransportCtor> | undefined;

/**
 * Loads the web-standard transport once, caching the promise so concurrent
 * first requests share a single import.
 */
async function loadTransport(): Promise<WebTransportCtor> {
  ctorPromise ??= import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    .then(
      (module) => module.WebStandardStreamableHTTPServerTransport as unknown as WebTransportCtor,
    )
    .catch((cause) => {
      ctorPromise = undefined; // Let a later call retry rather than cache the failure.
      throw new Error(
        `graphql-mcp: createFetchHandler needs @modelcontextprotocol/sdk >= ${REQUIRED_SDK}, ` +
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
  const sessionOptions = sessions === true ? {} : sessions || undefined;
  const store = sessionOptions ? new SessionStore<WebTransport>(sessionOptions) : null;

  const handler = async (request: Request): Promise<Response> => {
    const Transport = await loadTransport();
    const contextOverride = contextFromRequest ? () => contextFromRequest(request) : undefined;

    if (!store || !sessionOptions) {
      const server = makeServer(contextOverride);
      const transport = new Transport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await connect(server, transport);
      const response = await transport.handleRequest(request);
      // Unlike the Node path there is no `res.on('close')` to hang teardown on,
      // and a stateless transport has nothing left to do once it has produced a
      // Response — the body is already fully buffered as JSON.
      await transport.close();
      await server.close();
      return response;
    }

    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const existing = store.take(sessionId);
      if (!existing?.transport) {
        // 404 tells a spec-compliant client to initialize again; see http.ts.
        return jsonRpcError(404, -32001, 'Session not found');
      }
      return existing.transport.handleRequest(request);
    }

    const server = makeServer(contextOverride);
    const session: Session<WebTransport> = { server, lastSeen: Date.now() };
    const transport = new Transport({
      sessionIdGenerator: store.generateSessionId,
      enableJsonResponse: sessionOptions.enableJsonResponse ?? false,
      onsessioninitialized: (id) => store.add(id, session),
      onsessionclosed: (id) => store.drop(id),
    });
    session.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) void store.drop(transport.sessionId);
    };
    await connect(server, transport);
    const response = await transport.handleRequest(request);
    if (!transport.sessionId) {
      await transport.close();
      await server.close();
    }
    return response;
  };

  handler.close = async (): Promise<void> => {
    await store?.closeAll();
  };
  return handler;
}

/**
 * Connects a server to the loaded transport.
 *
 * The transport satisfies the SDK's `Transport` interface, but this module
 * models only the parts it drives so the public types stay independent of an
 * SDK version the peer range doesn't require — hence the cast at this one seam.
 */
async function connect(server: McpServer, transport: WebTransport): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: bridging the structural WebTransport to the SDK's Transport
  await server.connect(transport as any);
}

/** A JSON-RPC error as a `Response`, for requests no transport owns yet. */
function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
