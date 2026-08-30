# TODO

Deferred work and known MVP limitations.

## HTTP / transport

- **Other HTTP servers / endpoint handlers.** `createHttpHandler` returns an
  Express-style `(req, res)` handler that expects a Node `IncomingMessage` with a
  parsed JSON `req.body` and a Node `ServerResponse`. Add first-class adapters
  for other runtimes/frameworks (Fastify, Koa, Hono, the raw `node:http` server,
  Bun/Deno/edge `Request`/`Response`). Consider a small `toFetchHandler()` that
  wraps the transport for `(Request) => Response` environments.
- **stdio transport.** Expose a `createStdioServer()` convenience for local MCP
  clients (the SDK's `StdioServerTransport`).
- **Stateful sessions.** Currently stateless JSON (`sessionIdGenerator:
  undefined`, fresh server per request). Optionally support session-based
  transports for streaming/long-lived connections.

## Schema coverage

- **Interfaces/unions in selection sets.** `buildSelectionSet` selects an
  interface's own fields and emits inline fragments for union members, but does
  not expand per-implementation fields of an interface. Add inline fragments for
  an interface's possible types.
- **Field arguments on nested selections** are skipped (we can't invent values).
  Consider letting a tool request specific nested fields via input, or a
  configurable field-selection strategy.
- **Subscriptions** are ignored (MCP has no streaming-subscription tool shape).
  The `execute` meta tool refuses them explicitly.

## Tools & output

- **Structured output.** Tool results are JSON text. Consider deriving an
  `outputSchema` from the field's return type and returning `structuredContent`.
- **Response size.** Generated tools return large GraphQL results whole. The
  meta tools already clamp at `maxChars` with a truncation note; apply the same
  guard to generated tools, plus pagination hints.
- **Meta-tool result caching.** `graphql_introspect`/`graphql_search` recompute
  from the schema on every call. Memoize per schema if it shows up in profiles.
