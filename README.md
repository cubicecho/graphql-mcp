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
npm install @modelcontextprotocol/sdk graphql zod
```

Needs Node ≥ 22, `@modelcontextprotocol/sdk` ≥ 1.12, `graphql` ≥ 16, and `zod`
3.25+ or 4.x. [`createFetchHandler`](#non-node-runtimes) alone needs SDK ≥ 1.25.

`zod` is a peer dependency rather than a bundled one: the MCP SDK validates tool
arguments against *your* copy, and a second copy inside this package would make
those checks fail across the boundary. Bring whichever major you already use —
both are tested.

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

…you get four tools — `todo`, `todos`, `create_todo`, `set_completed` — each
with an input schema derived from the field's arguments and a description built
from the SDL docstrings. (Tool names are `snake_case` by convention; pass
`nameCase: 'preserve'` to keep your field names verbatim.) Calling `create_todo`
runs the equivalent of:

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
| `connectServer(server, transport)` | Connects a server to a transport. Use this instead of `server.connect` — see [Connecting your own transport](#connecting-your-own-transport). |
| `createServerFactory(options)` | Builds the tool descriptors once and returns a `() => McpServer` factory. |
| `createLocalExecutor(schema, opts?)` | Executor that runs operations in-process via graphql-js (the default). |
| `createHttpExecutor(endpoint, opts?)` | Executor that forwards operations to a remote GraphQL HTTP endpoint. |
| `buildTools(schema, opts?)` | The pure core: schema → `ToolDescriptor[]` (no SDK, no executor). |

Lower-level helpers (`buildOperation`, `buildSelectionSet`, `argsToZodShape`,
`registerGraphqlTools`, `compileRules`, `extendSchemaForMcp`, `stripRootTypes`,
`buildMetaTools`) and all types are exported too.

## How fields become tools

- **Both queries and mutations become tools.** MCP has no query/mutation
  distinction; queries are annotated `readOnlyHint`, mutations `destructiveHint`
  — see [Write hints](#write-hints), because that mutation default is
  deliberately blunt.
- **Names are `snake_case`.** `createTodo` becomes `create_todo`. The MCP spec
  doesn't mandate a convention, but every example in it names tools that way and
  so does most of the ecosystem, so it's what an agent has seen most. The
  humanized `title` (`Create Todo`) and the description still carry the real
  field name, and `include`/`exclude` patterns always match the GraphQL field
  name. Pass `nameCase: 'preserve'` for verbatim field names, or `toolName` for
  full control.
- **Arguments → input schema.** Each field's args are converted to a Zod schema
  (the MCP input-schema format): non-null args are required, scalars/enums/lists/
  input-objects map across, custom scalars fall back to an opaque value (see
  [Custom scalars](#custom-scalars)).
- **Unknown arguments are rejected.** Input objects — and the argument object
  itself — are strict, matching the `additionalProperties: false` the tool
  listing already advertises. A misspelled field comes back as an error naming
  the key, rather than a success with the value silently dropped, which is the
  failure an agent has no way to notice or retry.
- **Return type → selection set.** A selection set is auto-generated: every
  scalar/enum leaf plus nested objects up to `selectionDepth` (default 2), always
  including `__typename`. Fields that require arguments and cyclic types are
  skipped. The depth is per field — see [Selection depth](#selection-depth).
- **Descriptions come from the SDL** — the field docstring, its signature, and a
  per-argument list carrying each argument's default (as the GraphQL literal
  you'd write) and any argument-level deprecation. Each description also ends
  with the exact selection the tool will return, so an agent doesn't plan around
  fields it won't receive.
- **Deprecations are stated, not hidden.** A field with `@deprecated` keeps its
  tool — it's often still the only way to do something — but the reason sits
  directly under the summary, where an agent reads it before choosing:

  ```
  The `legacyTodos` query.

  DEPRECATED — Use todos instead.
  ```

  Pass `includeDeprecated: false` to drop them from the tool surface entirely.

## What a tool returns

Every tool — generated or meta — returns JSON text you can parse directly:

```json
{
  "data": { "todos": [{ "id": "1", "__typename": "Todo" }] },
  "errors": [{ "message": "…", "path": ["todos", 1, "owner"] }],
  "note": "Partial result: some fields failed and are null in `data`; …"
}
```

- **`isError` means nothing usable came back.** GraphQL happily returns `data`
  *and* `errors` when some fields resolve and others don't. Flagging that whole
  call an error makes an agent throw away rows it could have used, so `isError`
  is set only when no root field resolved — otherwise the result carries a
  `note` saying part of it failed.
- **Errors are condensed** to `message`, `path`, and `extensions` (where app
  codes like `UNAUTHENTICATED` live). `locations` are dropped: they're line and
  column offsets into a query string the agent never wrote and can't see.
- **Results are clamped** to `maxChars` (default `50_000`), so one large
  collection can't flood the agent's context:

```ts
createMcpServer({ schema, maxChars: 20_000 });
```

  The clamp is *structural*: whole array elements are dropped, evenly across
  every collection in the payload, and the body stays parseable JSON. Cutting
  the serialized text instead would leave the client a `SyntaxError` where its
  rows used to be — and would take `errors` and `note` with it, since they
  serialize last. `errors`, the partial-result `note`, and a `truncated` record
  are always kept.

- **A clamped result says what went missing, and names the argument to page
  with** when the field has one. "This was cut" on its own leaves an agent with
  no move but to re-run the identical call:

```json
{
  "data": { "todos": [{ "id": "1" }] },
  "truncated": {
    "droppedItems": 419,
    "totalItems": 420,
    "advice": "narrow the query or request fewer fields. This field paginates: pass `first` to cap the page size, then `after` to continue from where this page ended."
  }
}
```

  The arguments are read off the schema, matching the conventions in wide use
  (`first`/`after`, `limit`/`offset`, `take`/`skip`, `page`/`pageSize`). A field
  with none keeps the plain advice.

  When nothing can be dropped — one enormous scalar, say — `data` is left out
  entirely and `truncated.dataOmitted` says so, rather than handing back a value
  silently cut in half that an agent might act on.

That holds when the executor *throws*, too — a refused connection or a broken
custom executor comes back as `{ "errors": [{ "message": "…" }] }` with
`isError` set, never as a bare string a client can't parse.

- **A malformed call answers in the same envelope**, which matters because it's
  the failure an agent hits most: a wrong scalar, a misspelled key, a bad enum
  member. Each Zod issue becomes one error naming the argument it's about, so a
  call with two mistakes is told about both:

```json
{
  "errors": [
    {
      "message": "Invalid input: expected number, received string at `limit`",
      "extensions": { "code": "BAD_INPUT" }
    },
    {
      "message": "Invalid option: expected one of \"LOW\"|\"HIGH\" at `filter.priority`",
      "extensions": { "code": "BAD_INPUT" }
    }
  ]
}
```

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

Patterns match GraphQL field names (not the `snake_case`d or renamed tool
names), and they apply to
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

## Custom scalars

Built-in scalars map to the obvious Zod types; a custom scalar (`DateTime`,
`JSON`, `URL`) has no shape we can infer, so it falls back to an opaque value
carrying the scalar's own SDL description — so documenting the format in your
schema already helps:

```graphql
"An ISO-8601 timestamp, e.g. 2026-08-30T12:00:00Z."
scalar DateTime
```
```
Custom scalar DateTime — An ISO-8601 timestamp, e.g. 2026-08-30T12:00:00Z.
```

The value still isn't *validated* on our side. Pass `scalars` for that:

```ts
import { z } from 'zod';

createHttpHandler({
  schema,
  scalars: {
    DateTime: z.string().datetime().describe('ISO 8601 timestamp'),
    URL: z.string().url(),
  },
});
```

Keys are **scalar names**, and the mapping is consulted before the built-ins, so
you can retype `ID` or `String` too. A function form gets the
`GraphQLScalarType` itself; return `undefined` to fall through:

```ts
createHttpHandler({
  schema,
  scalars: (scalar) => (scalar.name.endsWith('Date') ? z.string().date() : undefined),
});
```

Nullability, lists, and input-object nesting are applied around whatever you
return — map the *base* type only.

Since the map is a plain `Record<string, ZodTypeAny>`, a generated one drops
straight in. With [`@vantreeseba/graphql-zod`](https://www.npmjs.com/package/@vantreeseba/graphql-zod):

```ts
import { defaultScalarMap } from '@vantreeseba/graphql-zod';

createHttpHandler({
  schema,
  scalars: { ...defaultScalarMap, DateTime: z.string().datetime() },
});
```

Tool arguments cross the wire as JSON, so keep the mapped types
JSON-representable — `z.string().datetime()` rather than `z.date()`.

## Argument defaults

An argument's SDL default shows up in two places. The tool description states it
in prose, and the rendered JSON Schema carries the `default` keyword:

```graphql
type Query {
  list(limit: Int = 10, status: Status = OPEN): [T!]!
}
```

```json
{ "limit": { "type": ["integer", "null"], "default": 10 },
  "status": { "anyOf": [{ "enum": ["OPEN", "DONE"] }, { "type": "null" }], "default": "OPEN" } }
```

The keyword is **advisory**. The value is not injected into the arguments, so an
omitted argument stays omitted on the wire and *GraphQL* applies its own
default — the SDL stays the single source of truth. An enum's default is
rendered as its name, which is what a variable actually carries.

The description is careful about one thing worth knowing:

```text
- `limit`: `Int` (omit for the default `10`; an explicit `null` is sent as null)
```

GraphQL does not read a passed `null` as a request for the default. Omitting the
argument gets you `10`; sending `null` gets you `null`. (Where
`nullBranches: 'never'` is in force for that field, the caveat is dropped, since
`null` can't be sent.)

On zod 3 the `default` keyword is absent — there is no metadata channel that
doesn't also change parsing — and the prose carries it alone.

## Argument shape examples

An argument whose type is an input object carries a compact JSON example in its
description, showing the minimum a caller has to send:

```text
Arguments (`shape:` shows a minimal JSON example — required fields only):
- `where`: `TaskFilters` — Filter the tasks returned.
  shape: {"name":{"eq":"string"}}
- `orderBy`: `[TaskOrderBy!]`
  shape: [{"startedAt":{"direction":"ASC","priority":0}}]
- `limit`: `Int` (omit for the default `50`; an explicit `null` is sent as null)
```

The shape was always in `inputSchema`, and that is exactly why this exists.
Measured against a hand-written-operations arm on the same schema, the generated
surface's only failed calls were argument shapes guessed from the argument's
*name* — `orderBy: { startedAt: "desc" }` for a type that is really a nested
object keyed by column, with an enum spelled `ASC`. The correct answer was in
the JSON Schema. It was inside a listing where a fortieth of the bytes are
prose, and the prose is what gets read. The examples add roughly one percent.

What goes in one, and what doesn't:

- **Every required field, however deep.** An example missing one is
  valid-looking JSON the server rejects, which relocates the failure instead of
  removing it. If a required field can't be rendered — the only case is a type
  that contains itself — the whole example is dropped rather than shipped
  incomplete.
- **The first field of an all-optional object.** A required-only rule renders
  `{}` for a filter type and teaches nothing, and rendering every optional field
  is the size problem again.
- **An enum's member as the schema spells it**, which is the half of the
  measured failure that prose alone would not have fixed.
- **One element of a list**, and a field's own default in place of a
  placeholder.
- Nothing at all for a scalar argument, for an argument whose own default is
  already printed as a GraphQL literal on the line above, or for an example that
  outgrows its budget — past a few hundred characters it stops being a hint and
  becomes the schema again, in a second syntax.

`exampleDepth` bounds how far *optional* expansion goes, and `0` turns examples
off — per schema, per field, or from the SDL:

```ts
createMcpServer({ schema, exampleDepth: 0 });
createMcpServer({ schema, exampleDepth: (field, kind) => (kind === 'query' ? 3 : 0) });
field.extensions = { mcp: { exampleDepth: 0 } };
```

Unlike [selection depth](#selection-depth) there is no `descriptor.exampleDepth`
and no `decorate` rebuild. Depth is on the descriptor because the query, the
output schema and the description all have to agree about it; an example affects
the description alone, and `decorate` can already replace that outright.

## Trimming null branches

A nullable GraphQL argument is advertised two ways at once: it is absent from
`required`, *and* it carries an explicit null branch — `anyOf: [T, {"type":
"null"}]` for an input object, `type: [X, "null"]` for a scalar. The second is
what costs. On a schema with a filter type per column those branches are around
40% of the schema nodes and 20% of the whole advertised listing.

There is also one shape with no legal rendering downstream:

```json
{ "anyOf": [{ "$ref": "#/definitions/StringFilter" }, { "type": "null" }] }
```

Draft-07 has no way to say "nullable" next to a `$ref` — siblings of `$ref` are
ignored and strict validators reject them. A consumer either keeps the
combinator, which backends that compile every tool into one grammar refuse, or
collapses it into an illegal node.

`nullBranches: 'never'` drops the branch:

```ts
createMcpServer({ schema, nullBranches: 'never' });
```

The argument's *shape* is not lost — `required` already says it may be absent.
What is lost is the ability to send an explicit `null`, which becomes a
validation error. For most GraphQL servers absent and null are the same thing,
but not all: a mutation that clears a field with `updateUser(bio: null)` needs
the branch. That is why the default is `'always'`, and why this is an option
rather than a fix — only your schema knows which kind it is.

**List elements are exempt** under either setting. `[String]` permits a null
element, and an element can be null but never absent, so dropping the branch
there would change the type rather than compress it.

### Per field

The trade above is rarely the same across a whole schema, because it usually
splits by *kind*. On a generated CRUD surface a filter argument set to an
explicit null is a caller mistake, while a mutation uses one to clear a column —
so the reads can drop their branches and the writes must keep theirs. A callback
says exactly that:

```ts
createMcpServer({
  schema,
  nullBranches: (field, kind) => (kind === 'query' ? 'never' : 'always'),
});
```

The callback receives the GraphQL field and its kind, and runs once per field.
The same decision is available everywhere a per-field decision already lives:

```ts
// on the schema, where it is defined
field.extensions = { mcp: { nullBranches: 'never' } };

// or last, from decorate
decorate: (d) => (d.name === 'tasks' ? { nullBranches: 'never' } : undefined);
```

`decorate` rebuilds the input schema *and* the description at the new setting,
because the per-argument advice about sending an explicit `null` is only true
under `'always'` — advice describing a call the tool now rejects is worse than
none. Each descriptor records what it was built at, as `descriptor.nullBranches`.

**One caveat if you post-process the listing.** Splitting by kind means the same
input type renders two ways across the surface — a `TaskFilters` with null
branches under a mutation and without under a query. That is fine as MCP serves
it: each tool's schema is converted on its own, so nothing collides. It stops
being fine if you flatten every tool's `$defs` into one shared namespace
downstream, where you get two definitions claiming one name. Split by kind when
the read and write input families are disjoint (the generated-CRUD case), and
key by `(tool, type)` if you merge.

There is deliberately no per-*argument* setting. A named input type is hoisted
once under its GraphQL name, so rendering one type at two modes inside a single
tool asks for two definitions under one id — which is an error from the JSON
Schema conversion, not a size trade.

## Write hints

Queries are annotated `readOnlyHint: true, idempotentHint: true`, which is
simply true of them. By default every mutation is annotated
`destructiveHint: true, idempotentHint: false`, which is **conservative rather
than derived**: the schema says a field writes, not what it writes, so a create
is flagged the same as a delete.

That default under-reports nothing, but the hint's only real consumer is a
client deciding whether to interrupt the operator for confirmation. Spent on
every mutation, it is spent on none in particular — an operator who confirms
`create_task` a dozen times a day is being trained to click through the dialog
that also guards `delete_task`.

`mutationHints: 'byName'` opts into reading the conventional prefixes that
generated schemas use:

```ts
createMcpServer({ schema, mutationHints: 'byName' });
```

| Field name | `destructiveHint` | `idempotentHint` |
| --- | --- | --- |
| `create*`, `add*`, `insert*` | `false` | `false` |
| `delete*`, `remove*`, `destroy*` | `true` | `true` |
| anything else | `true` | `false` |

A prefix matches only on a word boundary — `createTask`, `create_task`, and
`create` match; `creationFor` doesn't — and it's read from the **GraphQL field
name**, so `nameCase`, `toolName`, and `extensions.mcp.name` can't change what a
tool claims about itself. Everything unmatched keeps the conservative default,
which is already right for `update*`/`set*` and is the only safe answer for a
name the convention says nothing about (`runTask`, `stopTask`).

It's opt-in because it changes what clients confirm on, and no existing server
should have that change under it on a minor upgrade.

Either way this is a naming convention, not knowledge. Where the convention is
broken or absent, say so directly — per field in the schema, or across the board
with `decorate`:

```ts
decorate: (descriptor) =>
  descriptor.name === 'run_task' ? { annotations: { destructiveHint: false } } : undefined,
```

Annotations merge rather than replace, so overriding one hint keeps the rest.

## Selection depth

`selectionDepth` decides how far a generated selection set descends into nested
objects. The default is 2, and one number for the whole schema is usually wrong
in both directions: the field returning a flat row wants 1, and the one whose
answer is only useful two objects down wants 3.

Pass a callback to decide per field:

```ts
createMcpServer({
  schema,
  selectionDepth: (field, kind) => (kind === 'mutation' ? 1 : field.name === 'tasks' ? 3 : 2),
});
```

A number still works and applies to every field. Per field, `extensions.mcp.selectionDepth`
beats the option, and a `decorate` patch beats both:

```ts
decorate: (descriptor) => (descriptor.name === 'tasks' ? { selectionDepth: 3 } : undefined),
```

A patched depth rebuilds the operation, the description, and the `outputSchema`
around the new selection, so a descriptor never describes a selection it won't
return. Setting `query` in the same patch still wins over the rebuilt one.

Depth is not free in both directions: each level multiplies the fields the
server resolves and the tokens the agent reads, while a level too few means the
agent gets an object it can't see into and has no second tool to ask with.
`descriptor.selectionDepth` reports what each tool was built at.

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
        // also: hidden, name, description, annotations,
        // selectionDepth, nullBranches, exampleDepth
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

### Rewriting a tool's argument shape

A generated argument surface is the schema's shape, not the shape an agent finds
easy. `mapArgs` lets a tool advertise the second while still sending the first,
so flattening one awkward argument no longer means hand-writing the operation
behind it:

```ts
decorate: (descriptor) =>
  descriptor.name === 'tasks'
    ? {
        inputSchema: { id: z.string() },
        description: 'Fetch one task by id.',
        mapArgs: (args) => ({ where: { id: { eq: args.id } } }),
      }
    : undefined;
```

`args` has already been validated against the schema you advertised — the
advertised schema and the pre-call validator are the same object, so replacing
it is coherent end to end and unknown keys are still rejected. The mapper may be
async, and it receives the SDK's per-call `extra` as its second argument, so it
can inject something request-scoped. Every key it returns has to be a variable
the operation declares.

Two failures come back in the [usual JSON envelope](#what-a-tool-returns)
rather than as exceptions:

- **The mapper threw** — `BAD_INPUT`, carrying its message. A mapper is where
  server-side argument rules naturally go, and that is the code an agent already
  reads as "fix your arguments and retry".
- **The mapper returned a key the operation doesn't declare** —
  `BAD_TOOL_CONFIG`, naming the tool. graphql-js discards an undeclared variable
  *silently*, so without this the call succeeds with the mapped intent thrown
  away, which is the expensive failure when the caller is a model. The message
  says retrying will not help, so an agent stops rather than looping on its own
  arguments.

Setting `mapArgs` **and** `inputSchema` without also setting `description` is
refused at startup, naming the tool. The generated description still lists the
field's own arguments — down to the `shape:` example, which would confidently
show a literal for an argument the tool now rejects. A mapper that keeps the
advertised shape (injecting a tenant id, reordering) sets no `inputSchema` and
is unaffected.

The meta tools are not out of step when they still print
`tasks(where: TaskFilters)`: they describe the *schema*, and `graphql_execute`
runs schema documents where that is exactly right. `mapArgs` reshapes one tool's
front door, not the graph behind it.

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

### A tool-specific operation surface (`typesOnly`)

`include`/`exclude` subtract from the root fields you already have. When you'd
rather design the agent's operations from scratch — different names, different
arguments, coarser granularity — set `typesOnly: true`. The base schema's
`Query`/`Mutation`/`Subscription` types are dropped and everything else (objects,
inputs, enums, interfaces, unions, **custom scalars with their serializers
intact**) is kept, so your SDL can still refer to the real types:

```ts
const handler = createHttpHandler({
  schema, // your real, full schema
  extend: {
    typesOnly: true,
    typeDefs: /* GraphQL */ `
      type Query {
        "The one search an agent should use. Returns at most 20 todos."
        findTodos(text: String!, status: TodoStatus): [Todo!]!
      }
    `,
    resolvers: {
      Query: { findTodos: (_, args, ctx) => searchTodos(args, ctx) },
    },
  },
});
```

`Todo` and `TodoStatus` came from the real schema — you write the operations,
not the types. Two consequences worth knowing:

- Your `typeDefs` must declare `type Query { … }` (not `extend type Query`),
  since there's no base root type left to extend. Omitting it throws.
- Nothing from the original root types survives, so every field needs a
  resolver — the base schema's are gone with it.

`stripRootTypes(schema)` is exported if you want the stripped schema on its own.

## Schema-exploration tools (large schemas)

One tool per root field stops scaling somewhere past a few dozen fields — the
tool list itself starts crowding the agent's context. `metaTools` swaps that for
a handful of tools that let an agent navigate the schema instead:

```ts
const handler = createHttpHandler({
  schema,
  includeQueries: false, // no per-field tools at all…
  includeMutations: false,
  metaTools: true, // …just these four
});
```

| Tool | What it does |
|---|---|
| `graphql_introspect` | Prints a type's SDL — plus a JSON [shape example](#argument-shape-examples) when it is an input type; with no argument, the callable root fields plus every type name. |
| `graphql_search` | Finds types and fields by substring, across names and descriptions. |
| `graphql_validate` | Checks a document against the schema without running it. |
| `graphql_execute` | Runs a document, with `variables`. |

The two modes compose — leave the generated tools on and add meta tools for the
long tail. Names collide by design: a `tools` entry overrides a meta tool, which
overrides a generated one.

**`execute` respects your allow-list.** It runs documents the *agent* wrote, so
without a check it would be a way around `include`/`exclude`. Every root field
of the incoming document is matched against the same rules (fragment spreads and
inline fragments expanded, so nothing hides behind one), and a mutation is
refused unless `includeMutations` allows it. Override per-tool if the exploration
surface should differ from the generated one:

```ts
metaTools: {
  tools: ['introspect', 'search', 'execute'], // skip `validate`
  prefix: 'todo_api_',                        // default `graphql_`
  include: ['Query.*'],                       // defaults to the server's rules
  allowMutations: false,
  maxChars: 20_000,                           // result budget, default 50k
}
```

## Custom tools & overrides

Add bespoke tools, or override a generated one by reusing its name (the surface
stays the same; only that tool's behaviour changes):

```ts
const server = createMcpServer({
  schema,
  tools: [
    {
      name: 'create_todo', // overrides the generated tool for the `createTodo` field
      description: 'Create a todo, with extra validation.',
      inputSchema: { description: z.string().min(1) },
      handler: async (args) => ({
        content: [{ type: 'text', text: `created: ${args.description}` }],
      }),
    },
  ],
});
```

A custom tool that runs GraphQL itself should reuse the same result handling the
generated tools use, rather than rolling its own — `runExecutor` turns a thrown
executor into an `{ errors }` result, and `toCallToolResult` applies the
partial-result, error-condensing, and clamping rules described in
[What a tool returns](#what-a-tool-returns):

```ts
import { runExecutor, toCallToolResult } from '@cubicecho/graphql-mcp';

const executor = createLocalExecutor(schema, { rootValue });

tools: [
  {
    name: 'urgent_todos',
    description: 'Todos due today, sorted by priority.',
    handler: async () => {
      const result = await runExecutor(executor, {
        query: '{ todos(status: OPEN) { id description } }',
      });
      return toCallToolResult(result);
    },
  },
];
```

Reuse it for the failure path too. A custom tool that returns a plain payload on
success still returns the `{ errors: [...] }` envelope when its arguments don't
validate, because `guardToolArguments` answers above the handler — so a tool
that invents its own success shape shows an agent two different result shapes
for the one tool. `BAD_INPUT`, the `extensions.code` those envelopes carry, is
exported, so a tool that rejects a call on its own rules can answer with the
same code the generated ones do.

## Prompts, resources, and the rest of the SDK

This package generates tools. Everything else the MCP SDK can serve — prompts,
resources, completions — is reached with `decorateServer`, a hook that runs
against each freshly minted `McpServer` before it is connected:

```ts
const handler = createHttpHandler({
  schema,
  executor,
  decorateServer: (server) => {
    server.registerPrompt(
      'triage',
      { title: 'Triage', description: 'How to triage a todo.', argsSchema: {} },
      () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Triage it.' } }] }),
    );
  },
});
```

`server` is the SDK's own `McpServer`, so its full API is available and nothing
here needs to model it. The option is on `createMcpServer`, `createServerFactory`,
`createHttpHandler` and `createFetchHandler` alike.

**The hook has to run where it does.** A server can only declare its
capabilities while no transport is attached — register a prompt after `connect`
and the client is told at `initialize` that there are no prompts, so it never
asks. That window is between minting the server and connecting it, which is the
window this hook occupies. It is why registering prompts on the server your own
code holds works for a single stdio process and silently serves nothing under
`createHttpHandler`, which mints a server per request.

Two things to know:

- **The hook is synchronous.** Anything awaited between minting a server and
  connecting it is registration racing `initialize`. `registerPrompt` and
  `registerResource` are synchronous, so nothing is lost; a hook that returns a
  promise is refused with an error rather than left to fail under load. If your
  registrations need data, load it once outside the hook and close over it. A
  hook that throws fails every request it runs for — on Express 4 a rejected
  promise hangs the request instead of answering it, so wrap your handler in an
  error-catching adapter.
- **Vary prompts and resources freely; do not vary tools.** The rendered
  `tools/list` is shared across every server one factory mints
  ([Sessions](#sessions) mints one per session), so a hook that registers a
  different *tool* set depending on external state will serve one caller's
  listing to another. Prompts and resources are not cached and may differ per
  server. Tools that vary belong in the `tools` option, which also gets the
  `BAD_INPUT` envelope — a tool registered through this hook is not covered by
  the argument guard, so a malformed call to it gets the SDK's raw JSON-RPC
  error rather than the JSON result envelope every other tool answers with.

## Connecting your own transport

`createHttpHandler` and `createFetchHandler` connect their servers for you. If
you build the transport yourself — stdio, or one long-lived connection — use
`connectServer` rather than `server.connect`:

```ts
import { createMcpServer, connectServer } from '@cubicecho/graphql-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createMcpServer({ schema });
await connectServer(server, new StdioServerTransport());
```

It connects, then makes the server tolerant of a `tools/call` that leaves
`params.arguments` out. That key is optional in the MCP spec, and a tool whose
arguments are all optional — or which takes none at all — gives a client nothing
to put there. Without this, such a call is rejected by input validation before
the tool runs. A `prompts/get` for a prompt registered with an empty argument
schema is fixed up the same way, for the same reason.

## Other HTTP servers

`createHttpHandler` returns a framework-agnostic handler: it needs a Node
`IncomingMessage` and a Node `ServerResponse`, and nothing else. A parsed JSON
body on `req.body` (as `express.json()` provides) is used when present, but the
transport reads the request stream itself when it isn't — so a bare `node:http`
server works with no body parser at all:

```ts
import http from 'node:http';

const handler = createHttpHandler({ schema });
http.createServer((req, res) => handler(req, res)).listen(4000);
```

## Non-Node runtimes

Cloudflare Workers, Deno, Bun, and Hono speak `Request`/`Response` rather than
Node's `IncomingMessage`/`ServerResponse`. `createFetchHandler` takes the same
options and returns a fetch-shaped handler:

```ts
import { createFetchHandler } from '@cubicecho/graphql-mcp';

const handler = createFetchHandler({ schema });

export default { fetch: handler }; // Cloudflare Workers / Deno / Bun
app.all('/mcp', (c) => handler(c.req.raw)); // Hono
```

It needs `@modelcontextprotocol/sdk` **1.25 or later**, which is where the SDK's
web-standard transport was added. The import happens on the first call rather
than at module load, so this package still loads on the older SDKs its peer
range allows — only `createFetchHandler` is unavailable there, and it says so.

## Sessions

Both handlers are **stateless** by default: every request gets its own server and
transport, so any instance can serve any call and nothing has to be cleaned up.
That is the right shape for a tool server, and it's what you want unless you need
the server to *send* something unprompted.

Setting `sessions` flips that. The client initializes once, gets an
`Mcp-Session-Id` back, and every later request is routed to the same long-lived
server — which is what makes progress notifications and the standalone SSE stream
possible, since a connection stays open to deliver them on.

```ts
const handler = createHttpHandler({
  schema,
  sessions: {
    idleTimeoutMs: 5 * 60 * 1000, // evict a client that walked away (default)
    maxSessions: 1000, // LRU cap on live sessions (default)
    enableJsonResponse: false, // SSE; set true behind a buffering proxy
    replay: true, // buffer events so a dropped stream can resume (default)
  },
});

// Close open streams on shutdown; a no-op when stateless.
process.on('SIGTERM', () => handler.close());
```

An unknown or expired session id is answered with `404`, which tells a
spec-compliant client to initialize again. The session table is per-process
memory, which is what makes the deployment shape matter — see
[Running more than one instance](#running-more-than-one-instance).

### Resuming a dropped stream

The stream is the reason to be stateful, and streams drop. A client that loses
its SSE connection reconnects with the SSE `Last-Event-ID` header, saying how far
it got; the server sends what came after. That only works if something kept the
events, so each session gets a bounded in-memory buffer — without one the
transport never even writes an event id, and a long tool call's result is simply
gone when the connection dies mid-flight.

Tune the bounds, or turn it off:

```ts
sessions: {
  replay: { maxEventsPerStream: 64, maxStreams: 4 }, // the defaults
}
```

`maxEventsPerStream` is the reconnect window: a client that misses more than
that while disconnected can't resume and must start a new stream. It is told so
— a resume from an event that has aged out is answered `400` rather than with a
stream that silently skips the gap, because a client that believes it caught up
has no way to find out otherwise. The memory ceiling is the product of the three
caps: `maxSessions × maxStreams × maxEventsPerStream` messages.

`replay: false` turns resumability off, which is what the SDK does unaided.

Buffers live in the process that owns the session, so they don't survive a
restart or reach another replica. For that, supply your own store — a factory
called once per session, returning anything with the `EventStore` shape (Redis,
a Durable Object, a table):

```ts
import type { EventStore } from '@cubicecho/graphql-mcp';

sessions: { replay: (): EventStore => new RedisEventStore(redis) };
```

### Running more than one instance

A session owns a live `McpServer`: an open connection, a connected transport, and
registered handlers. That is not a value you can write to Redis and read back
somewhere else, so a session cannot move between instances. Everything below
follows from that.

**Stateless (the default).** Nothing is retained between requests, so any
instance serves any call. Scale it however you like. This is the right answer
unless you need server-initiated messages.

**Stateful, one process.** Zero config — the local table is the whole truth.

**Stateful, behind a load balancer.** You need sticky routing on
`Mcp-Session-Id`, because a request that reaches the wrong instance cannot be
served there. Two ways to arrange it:

- *Encode the instance in the session id* with `generateSessionId`, and have the
  proxy route on it. No shared state at all.
- *Share a session directory* — a small record of which instance holds which
  session id, in Redis or a table — and route on that.

**Stateful, isolate-per-request (Cloudflare Workers).** Sticky routing here means
a Durable Object per session: route by `Mcp-Session-Id` to the object that owns
it, and inside that object `createFetchHandler` is an ordinary single-process
handler. Without that, stay stateless.

#### Session directories

A directory records session *ownership*, never the session. Supplying one does
not make a session portable; it makes a misrouted request explain itself. Without
one, a request that lands on the wrong instance gets a bare `404` — the same
answer as an expired session, which is a miserable thing to debug when a load
balancer quietly loses its stickiness. With one, the response says which instance
holds it and repeats it in an `Mcp-Session-Owner` header:

```http
HTTP/1.1 404 Not Found
Mcp-Session-Owner: web-2

{"jsonrpc":"2.0","error":{"code":-32001,
 "message":"Session not found on this instance; it is held by 'web-2'"},"id":null}
```

It is still a `404`: the client's correct move is to initialize again, and there
is no session here to forward the request to. What changed is that your proxy —
or the person reading the logs — can now see where it should have gone.

Three methods, over whatever store you already run:

```ts
import type { SessionDirectory } from '@cubicecho/graphql-mcp';

const directory: SessionDirectory = {
  // Called on registration and on every later use, so it doubles as the TTL
  // refresh. Make it idempotent.
  claim: (id, owner) => redis.set(`mcp:${id}`, owner, { EX: 600 }),
  owner: (id) => redis.get(`mcp:${id}`).then((v) => v ?? undefined),
  release: (id) => redis.del(`mcp:${id}`),
};

const handler = createHttpHandler({
  schema,
  sessions: { directory, instanceId: process.env.HOSTNAME },
});
```

`instanceId` defaults to a random UUID, which distinguishes instances but tells
you nothing — set it to a pod name or hostname if you mean to route on it, and to
something you're willing to disclose, since a misrouted request is answered with
it. Give claims a TTL so an instance that dies doesn't leave its sessions
attributed to it forever; `claim` is re-issued on every request, so a live
session is always refreshed well before it lapses.

`MemorySessionDirectory` implements the interface in local memory. It is a test
double and a template — memory is exactly what several instances don't share.

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
