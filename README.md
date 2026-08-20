# @cubicecho/graphql-mcp

Turn a GraphQL schema into a [Model Context Protocol](https://modelcontextprotocol.io/)
server. Point it at a `GraphQLSchema` and every `Query`/`Mutation` root field
becomes an MCP **tool**, described from your SDL — field and argument
descriptions, types — so an AI can discover and call your API.

It's a thin wrapper meant to run **side-by-side** with your GraphQL server:
mount the returned HTTP handler on a route in the same app, or run it as its own
process and forward to a remote GraphQL endpoint.

## Install

```bash
npm install @cubicecho/graphql-mcp
# peer deps
npm install @modelcontextprotocol/sdk graphql
```

## Quick start

Run the MCP endpoint beside your GraphQL endpoint in the same Express app:

```ts
import express from 'express';
import { createHttpHandler } from '@cubicecho/graphql-mcp';
import { schema } from './schema.js'; // your executable GraphQLSchema

const app = express();
app.use(express.json());

app.post('/graphql', /* your existing GraphQL handler */);
app.post('/mcp', createHttpHandler({ schema })); // ← the MCP server

app.listen(4000);
```

Given the schema from the brief:

```graphql
"A user in the system"
type User {
  "The unique id for the user, a UUID"
  id: String!
  "The list of todos this user has created."
  todos: [Todo!]!
}

"A todo entity, able to be marked as completed"
type Todo {
  "The unique id for the todo, a UUID"
  id: String!
  "If the todo is complete or not."
  completed: Boolean!
  "A textual description of what the todo is."
  description: String!
  "The user who created this todo."
  createdBy: User!
}

type Query {
  todo(id: String!): Todo
  todos: [Todo!]!
}

type Mutation {
  "Create a new todo for a user."
  createTodo(input: CreateTodoInput!): Todo!
  setCompleted(id: String!, completed: Boolean!): Todo
}
```

…you get four tools — `todo`, `todos`, `createTodo`, `setCompleted` — each with
an input schema derived from the field's arguments and a description built from
the SDL docstrings. Calling `createTodo` runs the equivalent of:

```graphql
mutation createTodo($input: CreateTodoInput!) {
  createTodo(input: $input) { id completed description __typename }
}
```

## Concepts

| Export | What it does |
|---|---|
| `createHttpHandler(options)` | Returns an Express/Node `(req, res)` handler serving the tools over the MCP Streamable HTTP transport. A fresh server is created per request. |
| `createMcpServer(options)` | Returns a single `McpServer` with all tools registered. Use for stdio or one long-lived connection. |
| `createServerFactory(options)` | Builds the tool descriptors once and returns a `() => McpServer` factory. |
| `createLocalExecutor(schema, opts?)` | Executor that runs operations in-process via graphql-js (the default). |
| `createHttpExecutor(endpoint, opts?)` | Executor that forwards operations to a remote GraphQL HTTP endpoint. |
| `buildTools(schema, opts?)` | The pure core: schema → `ToolDescriptor[]` (no SDK, no executor). |

Lower-level helpers (`buildOperation`, `buildSelectionSet`, `argsToZodShape`,
`registerGraphqlTools`, `compileRules`, `extendSchemaForMcp`) and all types are
exported too.

## How fields become tools

- **Both queries and mutations become tools.** MCP has no query/mutation
  distinction; queries are annotated `readOnlyHint`, mutations `destructiveHint`.
- **Arguments → input schema.** Each field's args are converted to a Zod schema
  (the MCP input-schema format): non-null args are required, scalars/enums/lists/
  input-objects map across, custom scalars fall back to an opaque value.
- **Return type → selection set.** A selection set is auto-generated: every
  scalar/enum leaf plus nested objects up to `selectionDepth` (default 2), always
  including `__typename`. Fields that require arguments and cyclic types are skipped.
- **Descriptions come from the SDL** — the field docstring, its signature, and a
  per-argument list.

## Choosing where GraphQL runs

The single seam is the **executor**. The default runs in-process against the
schema you pass:

```ts
import { createMcpServer, createLocalExecutor } from '@cubicecho/graphql-mcp';

const server = createMcpServer({
  schema,
  executor: createLocalExecutor(schema, { rootValue, contextValue }),
});
```

To run the MCP server as a separate process and forward to a GraphQL HTTP server:

```ts
import { createHttpHandler, createHttpExecutor } from '@cubicecho/graphql-mcp';

const handler = createHttpHandler({
  schema, // used only to derive the tools
  executor: createHttpExecutor('http://localhost:4000/graphql', {
    // forward auth derived from the per-request context
    headers: (ctx) => ({ authorization: (ctx as { token: string }).token }),
  }),
});
```

## Per-request context (auth)

Derive the GraphQL context from the incoming HTTP request — e.g. to forward an
auth token into resolvers or the forwarding executor:

```ts
const handler = createHttpHandler({
  schema,
  contextFromRequest: (req) => ({ token: req.headers.authorization }),
});
```

For non-HTTP setups, pass `context` as a static value or a factory of the MCP
request `extra`.

## Choosing which fields become tools

Allow/deny lists take graphql-shield-style patterns — a field name with optional
`*` wildcards and an optional `Query.`/`Mutation.` prefix:

```ts
const handler = createHttpHandler({
  schema,
  include: ['Query.*', 'createTodo'], // only these become tools (omit to keep all)
  exclude: ['delete*', 'Mutation.resetDb'], // wins over include
});
```

Patterns match GraphQL field names (not renamed tool names), and they apply to
**every** root field of the schema being wrapped — including fields added by
`extend` (below), so an `include` list must name those too. Omitting `include`
keeps every field; passing an empty array matches nothing and exposes no tools
(it fails closed, so a computed-empty allow-list can't accidentally publish your
whole API).

For anything the patterns can't express, the `filter` callback still composes
with both lists:

```ts
createHttpHandler({ schema, filter: (field, kind) => !field.deprecationReason });
```

## Decorating tools for agents

Descriptions come from your SDL, but agents often need more: workflow hints,
warnings, when-to-use guidance. Two ways to layer that on without touching the
public GraphQL surface:

**In schema code**, via `extensions.mcp` on a field (read at tool-build time):

```ts
// graphql-js / @graphql-tools/schema field definition
fields: {
  todos: {
    type: TodoList,
    extensions: {
      mcp: {
        appendDescription: 'Prefer this over `todo` when listing; filter by status.',
        title: 'List Todos',
        // also: hidden, name, description, annotations, selectionDepth
      },
    },
  },
}
```

**Programmatically**, via the `decorate` callback — the last word on every
generated descriptor:

```ts
createHttpHandler({
  schema,
  decorate: (descriptor, field, kind) =>
    kind === 'mutation'
      ? { description: `${descriptor.description}\n\nConfirm with the user first.` }
      : undefined, // keep as-is
});
```

Precedence: SDL-derived defaults < `extensions.mcp` < `decorate`.

## MCP-only schema extensions

Expose fields to agents that don't exist on your public GraphQL API — usage
guides, aggregate helpers — by passing extension SDL (+ resolvers). The schema
is merged with [`@graphql-tools/schema`](https://the-guild.dev/graphql/tools/docs/schema-merging)
before tool generation:

```ts
const handler = createHttpHandler({
  schema,
  extend: {
    typeDefs: /* GraphQL */ `
      extend type Query {
        "How an agent should use this API."
        usageGuide: String!
      }
    `,
    resolvers: {
      Query: { usageGuide: () => 'List todos before creating duplicates…' },
    },
  },
});
```

The extended schema feeds both tool generation and the default in-process
executor. If you pass a custom `executor` (e.g. `createHttpExecutor` forwarding
to a remote endpoint), that endpoint won't know the extended fields — keep
MCP-only fields on the local path.

## Custom tools & overrides

Add bespoke tools, or override a generated one by reusing its name (the surface
stays the same; only that tool's behaviour changes):

```ts
const server = createMcpServer({
  schema,
  tools: [
    {
      name: 'createTodo', // overrides the generated createTodo tool
      description: 'Create a todo, with extra validation.',
      inputSchema: { description: z.string().min(1) },
      handler: async (args) => ({
        content: [{ type: 'text', text: `created: ${args.description}` }],
      }),
    },
  ],
});
```

## Other HTTP servers

`createHttpHandler` returns a framework-agnostic handler: it only needs a Node
`IncomingMessage` with a parsed JSON body on `req.body` (as `express.json()`
provides) and a Node `ServerResponse`. Express is assumed for the MVP; adapters
for other frameworks/runtimes are tracked in [TODO.md](./TODO.md).

## Development

```bash
npm test                # node --test (built-in runner, type stripping)
npm run coverage        # node --test with built-in coverage + thresholds
npm run typecheck       # tsc --noEmit
npm run typecheck:tests # type-check the test files too
npm run build           # compile to dist/
npm run check           # biome lint + format check
```

The source uses `.ts` import specifiers so it runs unbuilt under Node's type
stripping; `tsc` rewrites them to `.js` on build. Requires Node ≥ 22 and
TypeScript ≥ 5.7.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and
drive automated releases: pushes to `main` run the **Test** workflow, and on
success the **Release** workflow runs [semantic-release](https://semantic-release.gitbook.io/)
to version, update the changelog, publish to npm, and tag a GitHub release.
