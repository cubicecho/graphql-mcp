/**
 * Picks the server one HTTP request is answered by, which both handlers share so they stay in step. Without a hook
 * every request gets a server from one factory with every tool. `toolsFor` narrows that server's tools per caller,
 * and `serverFor` hands the whole server to the host, while the handler keeps the transport, the headers and the
 * body either way. Both hooks see the request's context, so `contextFromRequest` is then resolved once per request
 * and its value is every call's context, because the caller has to be known before the server is chosen.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageError } from '../core/errors.ts';
import { type CreateMcpServerOptions, createServerFactory, type ToolSelection } from '../runtime/server.ts';

/** Chooses the tools one request's server offers, from the request and its resolved context. */
export type ToolsForRequest<R> = (
  request: R,
  context: unknown,
) => ToolSelection | undefined | Promise<ToolSelection | undefined>;

/** Builds the server one request is answered by, unconnected; the handler connects and closes it. */
export type ServerForRequest<R> = (request: R, context: unknown) => McpServer | Promise<McpServer>;

/** The per-request hooks both handlers take, typed by the request shape each one receives. */
export interface RequestServerOptions<R> {
  /** Derives the GraphQL context from the request. */
  contextFromRequest?: (request: R) => unknown | Promise<unknown>;
  /** Narrows the tools per request. */
  toolsFor?: ToolsForRequest<R>;
  /** Replaces the handler's own server per request. */
  serverFor?: ServerForRequest<R>;
}

/**
 * Builds the function that mints a request's server. The schema projection is built here, once, unless `serverFor`
 * is given, which leaves nothing for this package to build.
 *
 * @typeParam R - The request shape the handler receives.
 * @param hooks - The handler's per-request hooks.
 * @param serverOptions - The server options, read only when `serverFor` is absent.
 * @returns A function from a request to an unconnected server for it.
 * @throws When both `toolsFor` and `serverFor` are given, since a server the host builds has no tools for this package
 *   to narrow.
 */
export function requestServers<R>(
  hooks: RequestServerOptions<R>,
  serverOptions: CreateMcpServerOptions,
): (request: R) => Promise<McpServer> {
  const { contextFromRequest, toolsFor, serverFor } = hooks;
  if (toolsFor && serverFor) {
    throw packageError(
      'toolsFor and serverFor cannot be combined: a server from serverFor is built by your code, so narrow its tools ' +
        'there, for example by passing a selection to your own createServerFactory factory.',
    );
  }
  if (serverFor) {
    return async (request) => serverFor(request, await contextOf(contextFromRequest, request));
  }
  const makeServer = createServerFactory(serverOptions);
  if (toolsFor) {
    return async (request) => {
      const context = await contextOf(contextFromRequest, request);
      const selection = await toolsFor(request, context);
      return makeServer(contextFromRequest ? () => context : undefined, selection);
    };
  }
  // No hook needs the caller up front, so the context stays lazy, derived per call as it always was.
  return async (request) => makeServer(contextFromRequest ? () => contextFromRequest(request) : undefined);
}

/**
 * Resolves a request's context once.
 *
 * @typeParam R - The request shape the handler receives.
 * @param contextFromRequest - The handler's `contextFromRequest`, or `undefined` when it has none.
 * @param request - The request being answered.
 * @returns The derived context, or `undefined` without a `contextFromRequest`.
 */
async function contextOf<R>(
  contextFromRequest: ((request: R) => unknown | Promise<unknown>) | undefined,
  request: R,
): Promise<unknown> {
  return contextFromRequest ? await contextFromRequest(request) : undefined;
}
