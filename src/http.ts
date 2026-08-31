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
 *   server-initiated messages — possible. It also pins a client to one process;
 *   see {@link SessionOptions} and TODO.md.
 *
 * Express is assumed for the MVP, but nothing here imports it: any framework
 * works as long as it hands the handler a Node `IncomingMessage` and a Node
 * `ServerResponse`. A parsed JSON body on `req.body` (as `express.json()`
 * provides) is used when present, but the transport reads the request stream
 * itself when it isn't — so a bare `node:http` server needs no body parser.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateMcpServerOptions, createServerFactory } from './server.ts';
import { type Session, type SessionOptions, SessionStore } from './sessions.ts';

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
  const sessionOptions = sessions === true ? {} : sessions || undefined;
  const store = sessionOptions
    ? new SessionStore<StreamableHTTPServerTransport>(sessionOptions)
    : null;

  const handler = async (req: McpHttpRequest, res: ServerResponse): Promise<void> => {
    // Per-request context derived from the real HTTP request wins over a static
    // `context`; otherwise fall back to whatever `serverOptions.context` holds.
    const contextOverride = contextFromRequest ? () => contextFromRequest(req) : undefined;

    if (!store || !sessionOptions) {
      const server = makeServer(contextOverride);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId) {
      const existing = store.take(sessionId);
      if (!existing?.transport) {
        // 404 specifically: the spec has clients treat it as "your session is
        // gone, initialize again". A 400 would read as a malformed request and
        // leave the client retrying an id that will never come back.
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // No session id: either an `initialize` — which mints one — or a stray
    // request, which the transport itself rejects with 400 because it has not
    // been initialized. Either way the work is the same, so the body never has
    // to be inspected here.
    const server = makeServer(contextOverride);
    const session: Session<StreamableHTTPServerTransport> = { server, lastSeen: Date.now() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: store.generateSessionId,
      enableJsonResponse: sessionOptions.enableJsonResponse ?? false,
      // Registered before the initialize response is written, so a client that
      // fires its next request immediately can't beat the session into the table.
      onsessioninitialized: (id) => store.add(id, session),
      onsessionclosed: (id) => store.drop(id),
    });
    session.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) void store.drop(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // A request that never initialized leaves nothing in the table; drop the
    // pair rather than leaking a server per stray request.
    if (!transport.sessionId) {
      await transport.close();
      await server.close();
    }
  };

  handler.close = async (): Promise<void> => {
    await store?.closeAll();
  };
  return handler;
}

/** Reads a header, collapsing the array form Node uses for repeated headers. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Writes a JSON-RPC error response, since no transport owns this request yet. */
function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
