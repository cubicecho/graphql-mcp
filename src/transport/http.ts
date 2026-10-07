/**
 * {@link createHttpHandler} returns a plain `(req, res)` handler to mount on a route, over the MCP SDK's Streamable
 * HTTP transport. Stateless mode (the default) builds a fresh `McpServer` and transport per request and answers as
 * JSON, because a transport owns a single connection and isolation keeps concurrent calls apart. Stateful mode
 * (`sessions: true`) routes a client back to the same long-lived server, which allows an open SSE stream but pins the
 * client to one process, so it needs sticky routing behind a load balancer. Any framework works if it passes a Node
 * `IncomingMessage` and `ServerResponse`, and the transport reads the request stream itself when `req.body` is absent.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateMcpServerOptions, connectServer, createServerFactory } from '../runtime/server.ts';
import { closeQuietly, SESSION_ID_HEADER, SessionHost, type SessionOptions } from './sessions.ts';

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
        void closeQuietly({ server, transport });
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
