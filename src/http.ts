/**
 * The HTTP glue for running the MCP server "side-by-side" with your GraphQL
 * server: {@link createHttpHandler} returns a plain `(req, res)` handler you
 * mount on a route (e.g. `app.post('/mcp', handler)` in Express).
 *
 * It uses the MCP SDK's Streamable HTTP transport in stateless JSON mode and
 * creates a fresh `McpServer` + transport per request — the transport owns a
 * single connection, so per-request isolation is what keeps concurrent calls
 * from clobbering each other.
 *
 * Express is assumed for the MVP, but nothing here imports it: any framework
 * works as long as it hands the handler a Node `IncomingMessage` whose parsed
 * JSON body is on `req.body` (Express's `express.json()` does this) and a Node
 * `ServerResponse`. Adapting other servers is tracked in TODO.md.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateMcpServerOptions, createServerFactory } from './server.ts';

/** A request with its parsed JSON body attached (as `express.json()` provides). */
export type McpHttpRequest = IncomingMessage & { body?: unknown };

/** An Express/Node-compatible request handler for MCP-over-HTTP. */
export type McpHttpHandler = (req: McpHttpRequest, res: ServerResponse) => Promise<void>;

/** Options for {@link createHttpHandler}. */
export interface HttpHandlerOptions extends CreateMcpServerOptions {
  /**
   * Derive per-request GraphQL context from the HTTP request (e.g. read an auth
   * header). Takes precedence over the `context` option for HTTP calls and lets
   * you key context off the real request rather than the MCP `extra`.
   */
  contextFromRequest?: (req: McpHttpRequest) => unknown | Promise<unknown>;
}

/**
 * Creates an HTTP handler that serves the schema's tools over the MCP Streamable
 * HTTP transport. Tool descriptors are built once; each request gets a fresh
 * server and transport.
 *
 * @param options - The same options as {@link createMcpServer}, plus
 *   `contextFromRequest` for request-derived GraphQL context.
 * @returns A `(req, res)` handler to mount on a route.
 * @example
 * ```ts
 * const handler = createHttpHandler({ schema });
 * app.post('/mcp', handler); // run beside app.post('/graphql', ...)
 * ```
 */
export function createHttpHandler(options: HttpHandlerOptions): McpHttpHandler {
  const { contextFromRequest, ...serverOptions } = options;
  const makeServer = createServerFactory(serverOptions);

  return async (req, res) => {
    // Per-request context derived from the real HTTP request wins over a static
    // `context`; otherwise fall back to whatever `serverOptions.context` holds.
    const server = makeServer(contextFromRequest ? () => contextFromRequest(req) : undefined);

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
  };
}
