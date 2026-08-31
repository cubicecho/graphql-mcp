# TODO

Deferred work and known MVP limitations.

## HTTP / transport

- **Session resumability.** Stateful sessions (`sessions`) keep a server per
  client but no `eventStore`, so a dropped SSE connection loses whatever was in
  flight rather than replaying it. The SDK transport accepts one; wiring it up
  means picking a storage shape that isn't per-process memory.
- **Shared session state.** `SessionStore` is per-process, so a stateful
  deployment behind a load balancer needs sticky routing and can't work at all on
  isolate-per-request platforms. A pluggable store (Redis, Durable Objects) would
  lift both limits — note that a session owns a live `McpServer`, so what
  actually has to move is the routing, not the object.

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
  exposed for introspection, but isn't registered with the MCP SDK. The obvious
  fix — attach `structuredContent` only when the data parses — does not work;
  reading the SDK's `validateToolOutput` shows why, and any real attempt has to
  clear three bars:
  1. Registering an output schema makes `structuredContent` **mandatory** on
     every non-error result. The SDK skips validation when `isError` is set and
     throws `Output validation error` otherwise, so "attach it when it fits" is
     really "fail the call whenever it doesn't".
  2. `structuredContent` must be an **object**, while a field returning
     `[Todo!]!` has an array schema. The registered schema would have to be an
     envelope (`{ data, errors }`), not the field schema itself.
  3. A **partial result** carries `isError: false` with resolver-failed fields
     nulled — including fields the schema marks non-null. So the registered
     schema has to be deep-nullable to describe what actually arrives.
  Together that points at one coherent design: an opt-in flag that registers a
  deep-nullable envelope schema and always attaches `structuredContent`. Worth
  doing, but it is a design, not a patch.
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
