/**
 * The HTTP glue for running the MCP server "side-by-side" with your GraphQL
 * server: {@link createHttpHandler} returns a plain `(req, res)` handler you
 * mount on a route (e.g. `app.post('/mcp', handler)` in Express).
 *
 * It uses the MCP SDK's Streamable HTTP transport, in one of two modes:
 *
 * - **Stateless** (default) — a fresh `McpServer` + transport per request,
 *   answered as JSON. The transport owns a single connection, so per-request
 *   isolation is what keeps concurrent calls from clobbering each other, and
 *   nothing is retained between requests: any instance can serve any call.
 * - **Stateful** (`sessions: true`) — the client initializes once, gets an
 *   `Mcp-Session-Id`, and is routed back to the same long-lived server on every
 *   later request. That is what makes an open SSE stream — and therefore
 *   server-initiated messages — possible, and each session buffers what it has
 *   sent so a dropped stream resumes rather than losing it (see `eventStore.ts`).
 *   It also pins a client to one process: an `McpServer` is a live object, so a
 *   session cannot be handed to another replica. Behind a load balancer that
 *   means sticky routing — and optionally a {@link SessionDirectory}, which
 *   makes a misrouted request say which instance it belonged to instead of
 *   failing anonymously. See the README's deployment notes.
 *
 * Express is assumed for the MVP, but nothing here imports it: any framework
 * works as long as it hands the handler a Node `IncomingMessage` and a Node
 * `ServerResponse`. A parsed JSON body on `req.body` (as `express.json()`
 * provides) is used when present, but the transport reads the request stream
 * itself when it isn't — so a bare `node:http` server needs no body parser.
 * Runtimes that speak `Request`/`Response` instead want
 * {@link createFetchHandler}.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateMcpServerOptions, connectServer, createServerFactory } from './server.ts';
import { SESSION_ID_HEADER, SessionHost, type SessionOptions } from './sessions.ts';

/** A request, optionally with a parsed JSON body attached (as `express.json()` provides). */
export type McpHttpRequest = IncomingMessage & { body?: unknown };

/** An Express/Node-compatible request handler for MCP-over-HTTP. */
export interface McpHttpHandler {
  (req: McpHttpRequest, res: ServerResponse): Promise<void>;
  /**
   * Ends every live session and releases the servers behind them. A no-op in
   * stateless mode, where nothing outlives a request. Call it when shutting the
   * host process down so open SSE streams are closed rather than dropped.
   */
  close(): Promise<void>;
}

/** Options for {@link createHttpHandler}. */
export interface HttpHandlerOptions extends CreateMcpServerOptions {
  /**
   * Derive per-request GraphQL context from the HTTP request (e.g. read an auth
   * header). Takes precedence over the `context` option for HTTP calls and lets
   * you key context off the real request rather than the MCP `extra`.
   *
   * With `sessions` enabled this runs on the request that *creates* the session,
   * and the resulting context is reused for that session's lifetime — the
   * server outlives the request it was built from. Keep per-call authorization
   * on the `context` factory (which sees each call's `extra`) rather than here
   * if it has to be re-checked on every tool call.
   */
  contextFromRequest?: (req: McpHttpRequest) => unknown | Promise<unknown>;
  /**
   * Keep a server alive per client session instead of one per request. `true`
   * uses the defaults; pass an object to tune the idle timeout, the cap, or the
   * response mode. Omit for stateless JSON, which is the right default for a
   * request/response tool server.
   */
  sessions?: boolean | SessionOptions;
}

/**
 * Creates an HTTP handler that serves the schema's tools over the MCP Streamable
 * HTTP transport. Tool descriptors are built once; each request (or each
 * session, when `sessions` is set) gets a server.
 *
 * @param options - The same options as {@link createMcpServer}, plus
 *   `contextFromRequest` for request-derived GraphQL context and `sessions` for
 *   stateful mode.
 * @returns A `(req, res)` handler to mount on a route, carrying a `close()` for
 *   shutdown.
 * @example
 * ```ts
 * const handler = createHttpHandler({ schema });
 * app.post('/mcp', handler); // run beside app.post('/graphql', ...)
 * ```
 */
export function createHttpHandler(options: HttpHandlerOptions): McpHttpHandler {
  const { contextFromRequest, sessions, ...serverOptions } = options;
  const makeServer = createServerFactory(serverOptions);
  const host = SessionHost.from<StreamableHTTPServerTransport>(sessions);

  const handler = async (req: McpHttpRequest, res: ServerResponse): Promise<void> => {
    // Per-request context derived from the real HTTP request wins over a static
    // `context`; otherwise fall back to whatever `serverOptions.context` holds.
    const contextOverride = contextFromRequest ? () => contextFromRequest(req) : undefined;

    if (!host) {
      const server = makeServer(contextOverride);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await connectServer(server, transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const sessionId = headerValue(req, SESSION_ID_HEADER);
    if (sessionId) {
      const existing = host.store.take(sessionId);
      if (!existing?.transport) {
        const miss = await host.miss(sessionId);
        res.writeHead(miss.status, miss.headers);
        res.end(miss.body);
        return;
      }
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    const server = makeServer(contextOverride);
    const transport = host.begin(server, (options) => new StreamableHTTPServerTransport(options));
    await connectServer(server, transport);
    await transport.handleRequest(req, res, req.body);
    await host.settle(server, transport);
  };

  handler.close = async (): Promise<void> => {
    await host?.store.closeAll();
  };
  return handler;
}

/** Reads a header, collapsing the array form Node uses for repeated headers. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
