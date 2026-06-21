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

- **Recursive input objects** fall back to `z.any()` once a type reappears on
  the path (`zodSchema.ts`). Use `z.lazy()` to model them precisely.
- **Interfaces/unions in selection sets.** `buildSelectionSet` selects an
  interface's own fields and emits inline fragments for union members, but does
  not expand per-implementation fields of an interface. Add inline fragments for
  an interface's possible types.
- **Field arguments on nested selections** are skipped (we can't invent values).
  Consider letting a tool request specific nested fields via input, or a
  configurable field-selection strategy.
- **Custom scalars** map to `z.any()`. Allow a user-supplied scalar→Zod map.
- **Subscriptions** are ignored (MCP has no streaming-subscription tool shape).

## Tools & output

- **Structured output.** Tool results are JSON text. Consider deriving an
  `outputSchema` from the field's return type and returning `structuredContent`.
- **Response size.** Large GraphQL results are returned whole. Add a
  `CHARACTER_LIMIT`-style guard with truncation messaging, and pagination hints.
- **Per-operation overrides.** Allow overriding a single generated tool's
  description / selection set / annotations without fully replacing it.
