# TODO

Deferred work and known MVP limitations.

## HTTP / transport

- **Other HTTP servers / endpoint handlers.** `createHttpHandler` returns an
  Express-style `(req, res)` handler that expects a Node `IncomingMessage` with a
  parsed JSON `req.body` and a Node `ServerResponse`. Add first-class adapters
  for other runtimes/frameworks (Fastify, Koa, Hono, the raw `node:http` server,
  Bun/Deno/edge `Request`/`Response`). Consider a small `toFetchHandler()` that
  wraps the transport for `(Request) => Response` environments.
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

- **Pagination hints.** Results are clamped at `maxChars` with a truncation
  note, but a truncated list gives the agent no way to ask for the rest. Detect
  connection/pagination arguments (`first`/`after`, `limit`/`offset`) and have
  the truncation note name the argument to page with.
- **Argument defaults in the input schema.** Defaults are stated in a tool's
  description but not encoded as Zod `.default()`, because that would inject the
  value into `variables` rather than letting GraphQL apply its own. The JSON
  Schema therefore carries no `default` keyword. Revisit if a client turns out
  to read it. Related: an argument with an SDL default is `.nullable()`, so an
  agent can send explicit `null` — which GraphQL treats as null, not as
  "use the default".
- **Meta-tool result caching.** `graphql_introspect`/`graphql_search` recompute
  from the schema on every call. Memoize per schema if it shows up in profiles.
- **Structured output (SDK registration).** `ToolDescriptor.outputSchema`
  describes a field's return type (mirroring the generated selection set) and is
  exposed for introspection, but isn't registered with the MCP SDK: registering
  it obliges the handler to return `structuredContent` matching the schema,
  while tools return the whole `{ data, errors }` envelope — and a partial
  result with resolver errors nulls out fields the schema marks non-null.
  Consider an opt-in `validate` option that parses `data[field]` against the
  schema and attaches `structuredContent` only when it succeeds.
- **Abstract types in `outputSchema`.** Interfaces contribute only their own
  fields, matching `buildSelectionSet`. Expanding per-implementation fields
  there should expand here too — the two must stay in lockstep.

## Decided against

- **stdio transport.** No `createStdioServer()` convenience. This package is
  built to run *side-by-side* with a GraphQL server — mounted on a route in the
  same app, or as a process forwarding to a remote endpoint — and both are HTTP
  shapes. A caller who genuinely wants stdio can wrap `createMcpServer` with the
  SDK's `StdioServerTransport` in a few lines, and owning that surface would
  mean owning a lifecycle (process signals, stream teardown) the HTTP path never
  touches. Revisit only if the side-by-side model stops being the primary one.
