# AGENTS.md

## Project

`@cubicecho/graphql-mcp` — middleware that turns a GraphQL schema into a
[Model Context Protocol](https://modelcontextprotocol.io/) server. Each
`Query`/`Mutation` root field is projected into an MCP **tool**, described from
the SDL (field and argument descriptions, types) so an AI can discover and call
your API. It is designed to run **side-by-side** with your GraphQL server: mount
the returned HTTP handler on a route in the same app, or run it as its own
process and forward to a remote GraphQL endpoint.

## Stack

- **Language:** TypeScript 5.7+, strict mode, ESM only, "erasable syntax only"
  (no enums/namespaces/parameter-properties) so the source runs unbuilt under
  Node's type stripping.
- **Runtime/build:** Source uses `.ts` import specifiers. Run it directly with
  `node --experimental-strip-types`; `tsc` (with `rewriteRelativeImportExtensions`)
  rewrites the specifiers to `.js` and emits `dist/`. Requires Node ≥ 22 and
  TypeScript ≥ 5.7.
- **Tests:** Node's built-in test runner (`node --test`) with type stripping —
  **no test framework dependency**. Test files are `src/**/*.test.ts`.
- **Formatting/linting:** [Biome](https://biomejs.dev/) (`npm run check`).
- **Dependencies:** `@graphql-tools/schema` (schema merging for the `extend`
  option) is the only runtime dependency. `@modelcontextprotocol/sdk`
  (`>=1.12`), `graphql` (`>=16`) and `zod` (`^3.25 || ^4.0`) are **peer deps** —
  zod because the SDK validates against the caller's copy, and a second one in
  our own tree makes `instanceof` checks fail across the boundary. Express is *not* a dependency — the HTTP handler
  is framework-agnostic. `createFetchHandler` needs SDK ≥ 1.25 and loads that
  transport lazily so the floor stays at 1.12 for everyone else.
- **Guiding constraint:** avoid adding libraries unless writing it ourselves
  isn't worth the effort (e.g. the GraphQL→Zod mapping is hand-written). The
  `scalars` option is a plain `Record<string, AnyZodType>` for the same reason —
  it's structurally identical to what generators emit (e.g. `defaultScalarMap`
  from `@vantreeseba/graphql-zod`), so interop needs no adapter or dependency.

## Scripts

```bash
npm test               # node --test over src/**/*.test.ts (strip types)
npm run coverage       # node --test with built-in coverage + thresholds
npm run typecheck      # tsc --noEmit (src)
npm run typecheck:tests # tsc -p tsconfig.tests.json (src + *.test.ts)
npm run build          # tsc → dist/
npm run check          # biome lint + format check
npm run format         # biome format --write
```

`node --test` type-strips rather than type-checks, so `typecheck:tests` is the
gate that catches type errors in test files.

## Project structure

```
src/
  index.ts        — public API entry point (re-exports + package overview)
  types.ts        — GraphqlExecutor / GraphqlRequest / GraphqlResult, the execution seam
  zodSchema.ts    — GraphQL args → Zod input schema (argsToZodShape)
  selection.ts    — auto-built selection sets for return types (buildSelectionSet)
  outputSchema.ts — return type → Zod schema for results (buildOutputSchema)
  operation.ts    — per-field operation documents (buildOperation)
  rules.ts        — include/exclude pattern matching (compileRules)
  extend.ts       — MCP-only schema additions via mergeSchemas (extendSchemaForMcp, stripRootTypes)
  tools.ts        — schema → ToolDescriptor[] (buildTools): names, descriptions, annotations
  operations.ts   — hand-written documents → ToolDescriptor[] (buildOperationTools)
  meta.ts         — opt-in schema-exploration tools (buildMetaTools): introspect/search/validate/execute
  result.ts       — GraphqlResult → CallToolResult (toCallToolResult): isError, error condensing, clamping
  executor.ts     — createLocalExecutor (in-process) / createHttpExecutor (forwarding)
  server.ts       — createMcpServer / createServerFactory / connectServer / registerGraphqlTools (+ custom tools)
  handlers.ts     — the SDK request handlers this package wraps (shareToolListing, guardToolArguments)
  zodCompat.ts    — zod v3/v4-tolerant type aliases (AnyZodType, ZodShape)
  version.ts      — VERSION, read from package.json (the version servers advertise)
  pagination.ts   — paging-argument detection for truncation hints (paginationHint)
  argExample.ts   — a literal JSON example of one argument's shape (buildArgExample)
  sessions.ts     — the bounded session table behind stateful HTTP (SessionStore)
                    plus SessionDirectory, which reports session ownership across instances
  eventStore.ts   — the bounded SSE replay buffer behind resumability (MemoryEventStore)
  http.ts         — createHttpHandler for Node (IncomingMessage/ServerResponse)
  fetch.ts        — createFetchHandler for Request/Response runtimes
  *.test.ts       — co-located tests; fixtures.test.ts holds the shared "todos" schema
```

## Architecture & conventions

- **The schema is the source of truth.** Tool name, description, and input
  schema mirror the GraphQL surface one-to-one. Don't hardcode domain types.
- **Tool names are `snake_case`** (`createTodo` → `create_todo`). The MCP spec
  only requires a unique `name`, but every example in it — and most of the
  ecosystem — is snake_case, so that's what an agent has seen most. Only the
  name changes: `title`, the description, the operation, and `include`/`exclude`
  patterns all keep the real field name. `nameCase: 'preserve'` opts out;
  `toolName` overrides entirely and is never re-cased.
- **Mutation write hints are a default, not a derivation** (`annotationsFor`).
  Queries get `readOnlyHint`/`idempotentHint`, which the schema genuinely knows.
  Mutations get `destructiveHint: true` uniformly, which it does not — the
  schema says a field writes, not what it writes. `mutationHints: 'byName'`
  opts into the conventional prefixes (`create`/`add`/`insert` → additive,
  `delete`/`remove`/`destroy` → idempotent; everything else keeps the
  conservative default). Opt-in, because it changes what a client confirms on,
  and it matches the **GraphQL field name** so a renamed tool can't misdescribe
  itself. Document the default as conservative wherever annotations come up: a
  hint spent on every mutation is spent on none.
- **`selectionDepth` is per field, through the same pipeline as everything else**:
  the option (a number *or* a `(field, kind) => number` callback) → `extensions.mcp.selectionDepth`
  → a `decorate` patch. A patch that changes the depth rebuilds the descriptor
  from that depth — query, description, and `outputSchema` together — and the
  rest of the patch is then applied over the rebuild, so an explicit `query`
  alongside it still wins. `ToolDescriptor.selectionDepth` records the depth the
  descriptor was actually built at; it is optional so hand-built descriptors and
  `registerGraphqlTools` callers stay valid.
- **Per-field pipeline in `buildTools`** (later stages win): `exclude` rules →
  `include` rules → `filter` callback → `extensions.mcp.hidden` → SDL-derived
  defaults → `extensions.mcp` metadata → `decorate` callback → duplicate-name
  check on the *final* name. Rules match GraphQL field names (never cased or
  remapped tool names) and only drop fields, never rename.
- **`extend` merges MCP-only SDL + resolvers** (via `extendSchemaForMcp` /
  `@graphql-tools/schema`'s `mergeSchemas`) before tool generation. The extended
  schema feeds both `buildTools` and the default local executor; a custom/HTTP
  executor must itself know the extended fields. Because the merge happens
  first, `include`/`exclude` rules also apply to extend-added fields.
- **`extend.typesOnly` drops the base root types** (`stripRootTypes`) before the
  merge, keeping every other type — objects, inputs, enums, interfaces, unions,
  and custom scalars *with their serializers*, since the `GraphQLScalarType`
  instances are carried over, not re-created. It lets a caller design a
  tool-specific operation surface on top of the real schema's types. The
  extension `typeDefs` must then declare `type Query` (not `extend type Query`);
  `extendSchemaForMcp` throws with that guidance if the merged schema has no
  query type.
- **A hand-written operation is a tool the same way a root field is**
  (`operations.ts`). `buildOperationTools` produces the identical
  `ToolDescriptor` shape, so an operation tool runs through the same
  registration, `validators` entry, executor seam, and `result.ts` formatting —
  and overrides a generated tool of the same name, exactly as a `tools` entry
  does. Everything is decided at build time: documents are merged into one
  `DocumentNode` (so a fragment file resolves from an operation file), validated
  minus `NoUnusedFragmentsRule` (a shared fragment file legitimately holds
  fragments not every run uses), then split with `separateOperations`, which
  already does the transitive fragment collection. Three things it does *not*
  share with the generated path, each for a stated reason: `include`/`exclude`/
  `filter` do not apply (they match GraphQL field names and govern schema
  projection — an operation is the server author's own code, at the same trust
  level as a `CustomTool` handler); a non-null variable **with a default** is
  advertised as optional (`$limit: Int! = 20` means "you may omit it", and
  `argsToZodShape`'s NonNull ⇒ required is still right for a field argument,
  which never carries a variable default); and `outputSchema` is `z.unknown()`
  until a selection-set-driven walker exists, which nothing observes today
  because it is not registered with the SDK (issue #15). Descriptions come from
  `#` comments via `loc.startToken.prev` — a lexer detail, not documented
  graphql-js surface, so a `noLocation` document degrades to a generic summary
  rather than crashing. Input types are **not** deduplicated across operations;
  a shared memo would have to key on `scalars` and `nullBranches` too, and one
  that doesn't is the 18 MB → 456 kB bug in a new place.
- **`include` fails closed.** An omitted `include` keeps everything; a present
  but empty array matches nothing (consistent with `compileRules([])`), so a
  dynamically built allow-list can't silently expose the whole schema.
- **Meta tools enforce the same rules as tool generation.** `metaTools` is
  opt-in because `graphql_execute` runs agent-written documents rather than a
  pre-built operation. `buildMetaTools` defaults its `include`/`exclude`/
  `allowMutations` to the server's own, and `executeTool` checks *every* root
  field of the incoming document — expanding fragment spreads and inline
  fragments first, so a root-level spread can't hide a denied field. Without
  that check a raw document would be a way around the allow-list; keep the two
  surfaces in sync when either changes.
- **Stay zod-version-agnostic (`zodCompat.ts`).** The peer range spans v3 and
  v4, whose type surfaces differ: v4's `ZodTypeAny` resolves to the core
  `$ZodType` (no `.parse`, no `.describe`) and its `ZodRawShape` is `Readonly`,
  so shapes built by assignment are rejected. Import `AnyZodType` and `ZodShape`
  from `./zodCompat.ts` instead of either name from `zod`. In tests, assert on
  an issue's `code` and `keys` rather than its message text, and search the
  whole rendered JSON Schema rather than `properties` — v4 hoists shared object
  schemas into `definitions` and leaves a `$ref` behind. CI runs the whole gate
  against both majors.
- **`meta.ts` imports `CustomTool` type-only.** `server.ts` imports `meta.ts` at
  runtime, so the reverse import must stay erasable to avoid a cycle.
- **One seam for execution: `GraphqlExecutor`.** A tool builds a
  `{ query, variables, operationName, context }` request and hands it to the
  executor; it never knows whether GraphQL runs in-process or over HTTP. The
  default is `createLocalExecutor(schema)`.
- **Every input type is built once (`zodSchema.ts`'s `done` memo).** A generated
  CRUD schema filters through relations — a task by its runs, a run back by its
  task — and the same handful of filter types is reached by dozens of routes.
  GraphQL says that by *naming* a type; JSON Schema has to *write it out*, so a
  per-route copy expands combinatorially. Returning the identical Zod instance is
  what lets `toJSONSchema` emit a `$ref` instead: on a real seventeen-tool server
  it took the advertised listing from **18 MB to 456 kB**, with nothing pruned.
  `pending` is the cycle guard for a type still on the stack (`z.lazy`), `done`
  is the memo for one already finished — deleting from `pending` is not the same
  thing, and conflating them is what caused the blow-up.
- **A hoisted input type carries its GraphQL name (`withName` in
  `zodCompat.ts`).** Left anonymous, v4's render keys `definitions` by position
  — `__schema0`, `__schema7` — and the reader is a model, for whom the type name
  (`TaskFilters`, `StringFilter`) is the whole meaning. `.meta({ id })` is
  v4-only and returns a *clone*, so the return value is what goes into `done`
  and `holder.schema`; on v3 it is a no-op, which is right because v3 inlines
  and never renders a `$ref`. Naming also makes v4 hoist a single-use type it
  would otherwise inline — about +2% on a listing, for a name at every site.
  It pays for that many times over on a *reused* type: v4 hoists only what it
  must (cycles), so a non-cyclic filter shared by ten columns used to be written
  out ten times, where v3's converter back-referenced every repeat. Six tables
  of that rendered at 275 kB on v4 against v3's 149 kB; named, it is 106 kB.
  `server.test.ts` guards the invariant — a shared type appears exactly once —
  rather than a byte count, since where the copy lives differs by major.
- **An argument's default is *advertised*, never applied (`withDefault` in
  `zodCompat.ts`).** The JSON Schema `default` keyword is advisory — it takes no
  part in validation — so it rides on `.meta()` rather than on Zod's
  `.default()`. `.default()` would substitute the value at parse time, which
  puts it into the GraphQL `variables`; the server would then receive an
  explicitly-passed `10` and could never apply its own default, so the SDL and
  this package would be two sources of truth for one value and the wrong one
  would win the moment the SDL changed. Apply it *after* nullability wrapping,
  or the keyword lands inside one branch of an `anyOf` instead of on the
  property. Like `withName` this is v4-only; on v3 the prose in the description
  is the only statement of the default, so tests check the prose
  unconditionally and the keyword only where `.meta()` exists.
  The value is read with `valueFromASTUntyped` off the AST literal, because an
  enum's internal value need not be its SDL name and the *name* is what crosses
  the wire. The description says "omit for the default" rather than "default:",
  and warns that an explicit `null` is sent as null — GraphQL does not read a
  passed null as a request for the default, and an agent sending null to mean
  "no preference" would silently get null. Under `nullBranches: 'never'` the
  warning is dropped, since null can no longer be sent at all.
- **The shape of an argument goes in the prose, not only in the schema
  (`argExample.ts`).** A controlled A/B on one consumer's 17-field surface
  (issue #21, reported 2026-09-02): a generated arm against a hand-written-
  operations arm, same schema, same model, same transport. `tools/list` was
  423,373 bytes against 12,609; the largest single tool 49,651 against 2,688;
  the share of bytes that is prose 2.4% against 40%; 33 tool calls against 27 —
  and **3 failed calls against 0**. All three failures were one mistake: an
  argument's shape guessed from its name (`orderBy: { startedAt: "desc" }` for a
  type that is really `{ <column>: { direction, priority } }`, with an enum
  spelled `ASC`). The correct shape was in the JSON Schema the whole time. So a
  correct answer being *available* is not the same as it being read, which is
  why the examples are on by default and cost ~1% of the listing. The counter-
  result from the same report belongs beside it: on a bulk analytical read the
  *generated* arm won 3 calls to 5, because raw field access is a natural join
  for a question no hand-written operation anticipated. A curated surface is a
  bet that you know the questions.
  **The rule the renderer must not lose: a truncated example is worse than
  none.** An example missing a required field is valid-looking JSON the server
  rejects — the same failure, relocated. So `exampleDepth` bounds *optional*
  expansion only, every non-null field is expanded however deep it goes, and a
  non-null position that cannot be rendered abandons the whole example. The
  module walks `GraphQLInputType` alone — no zod, no SDK — so it is the rare
  thing that cannot render differently across the zod peer range.
  `graphql_introspect` gets the same example on its **per-type** path and
  deliberately not on the overview: the overview is a whole-schema listing on
  schemas large enough to need meta tools, clamped by `maxChars`, and one example
  per argument per field would spend that budget on what the per-type call
  answers better. A signature is not a contradiction of a signature-plus-example,
  so the two surfaces still agree.
- **A nullable input position states its optionality twice, and the default
  keeps it that way (`nullBranches` in `zodSchema.ts`).** A nullable argument is
  left out of `required` *and* given an explicit null branch (`anyOf: [T, {type:
  'null'}]`, or `type: [X, 'null']` for a scalar). The second statement is the
  expensive one: on a filter-per-column schema those branches are roughly 40% of
  the schema nodes and 20% of the listing, and one of them — `anyOf: [{$ref},
  {type: 'null'}]` — has *no* legal draft-07 rendering, since siblings of `$ref`
  are ignored there and strict validators reject them, so a consumer can neither
  keep the combinator (backends that compile tools into a grammar refuse it) nor
  collapse it (the result is an illegal node). Naming input types made `$ref` the
  common case, so that shape went from a corner to the default.
  `nullBranches: 'never'` drops the branch in *property* positions only. The
  default stays `'always'` because the trade is real and only the schema's author
  can make it: `'never'` turns an explicit `null` into a validation error, which
  breaks the mutation idiom of passing `null` to clear a field. **List elements
  are exempt under either setting** — an element can be null but never absent, so
  there `.nullable()` is the type, not a redundant restatement of it.
  The setting is **per field** (option value or callback → `extensions.mcp` →
  `decorate`, the `selectionDepth` pipeline exactly), because the trade splits by
  kind far more often than by schema: reads never legitimately take an explicit
  null, writes use one to clear a column. `toDescriptor` resolves it once and
  passes the same value to the description and to `argsToZodShape`, so prose and
  schema cannot be built at different modes; `buildTools`' rebuild branch fires
  when a patch changes *either* `selectionDepth` or `nullBranches` and resolves
  both before comparing, or a patch naming one silently resets the other.
  **Per-argument is not offered, and the reason is measured, not stylistic.**
  `withName` hoists each input type under a `.meta({ id })` keyed on its GraphQL
  name, so rendering one named type at two modes inside a single field throws
  from the conversion — verified on zod 4.5.4: `Duplicate schema id "F" detected
  during JSON Schema conversion`. Making it work would mean inventing a second
  `$defs` name in the one namespace `withName` exists to keep legible, with a
  thrown `tools/list` as the failure mode. A safe widening, if it is ever asked
  for, is a mode that is a pure function of the *containing input type*
  (`(type: GraphQLInputObjectType) => NullBranches`): one type, one mode, one id.
- **`connectServer(server, transport)` is how a server should be connected.**
  `params.arguments` is optional in the MCP schema, and a tool whose arguments
  are all optional gives a client nothing to put there — but the SDK hands that
  `undefined` straight to the input schema, which rejects it before the handler
  runs, and the tool is uncallable. The fix cannot live in the schema: the SDK
  renders `tools/list` from the same value it validates against, and anything
  that parses `undefined` stops being recognised as an object schema (the tool
  is then advertised as taking no arguments at all). So `connectServer` wraps
  `transport.onmessage` after `connect` and defaults a missing `arguments` to
  `{}`. The same applies to `prompts/get` for a prompt registered with an empty
  argument schema, so `OPTIONAL_ARGUMENTS` lists both methods — add to that set
  rather than adding a second wrapper. `createHttpHandler` and
  `createFetchHandler` use it; a caller wiring up its own transport (stdio)
  should too.
- **Tools pass arguments as GraphQL variables**, never inlined into the query
  string — the executor's variable layer handles coercion/escaping.
- **`mapArgs` turned `argNames` from a pluck list into a check list**
  (`toVariables` in `server.ts`). A descriptor's `argNames` is the operation's
  *declared* variables; without a mapper it is still the pluck list and the
  behaviour is byte-identical. With one, the mapper's output is checked against
  it first, because graphql-js discards a variable the document never declared
  **silently** — the call succeeds with the mapped intent thrown away, which is
  the expensive failure when the caller is a model. Both mapper failures are
  *reported*, never thrown: `result.ts` promises a parseable JSON body on every
  outcome, so a throw here would be the one code path that breaks that promise.
  They carry different codes on purpose — `BAD_INPUT` for a mapper that threw
  (the caller can fix its arguments and retry), `BAD_TOOL_CONFIG` for an
  undeclared key (the caller cannot; the message says so, or an agent loops).
  A patch setting both `mapArgs` and `inputSchema` without a `description` is
  refused in `applyPatch` at boot, because the generated prose — down to the
  `shape:` literal from `argExample.ts` — would confidently describe arguments
  the tool now rejects. Regenerating that prose from the advertised Zod shape
  would mean walking zod across the v3/v4 split; the throw is the cheaper guard.
- **Selection sets are auto-generated** (`buildSelectionSet`): all scalar/enum
  leaves at each level, descending into nested objects up to `selectionDepth`
  (default `DEFAULT_SELECTION_DEPTH`, exported from `selection.ts` so the depth a
  descriptor reports and the depth it was built at cannot drift), always
  including `__typename`. Fields requiring arguments and cyclic types are
  skipped. Because the agent can't choose the selection, each
  generated tool's description ends with the exact selection it will get back —
  otherwise the agent assumes the full return type and plans around fields that
  never arrive.
- **`outputSchema.ts` mirrors `selection.ts`.** A descriptor's `outputSchema` is
  a Zod schema for what the generated operation actually returns, so it obeys the
  same skip/depth/cycle rules and is driven by the *same* `selectionDepth` —
  there is no separate depth option, because a schema describing fields the query
  never selects would be wrong. Change one module and change the other.
- **One place formats results: `result.ts`.** Generated tools and the `execute`
  meta tool both hand their `GraphqlResult` to `toCallToolResult`, so success,
  failure, and size read the same everywhere. Three rules live there, all about
  the agent's experience: `isError` means *nothing usable came back* (at least
  one non-null root field ⇒ partial success, which carries a `note` rather than
  a failure flag, so an agent doesn't discard rows it could have used); errors
  are condensed to `message`/`path`/`extensions`, dropping `locations` because
  they index into a query string the agent never wrote and cannot see; and the
  JSON is clamped to `maxChars` (default 50k) **structurally** — whole array
  elements are dropped, evenly across every collection, and the envelope is
  re-serialized, so the body is always parseable JSON. Slicing the serialized
  string instead cut mid-token, so a client got a `SyntaxError` in place of its
  rows, and took `errors` and the partial-result `note` with it, because they
  serialize after `data` — the clamp destroyed exactly the diagnostics the
  failure existed to deliver. A `truncated` record carries the counts and the
  advice, naming the field's paging argument when it has one, because a bare
  "this was cut" leaves an agent with no move but to re-run the identical call.
  Validity outranks the budget: when nothing can be dropped, `data` is omitted
  with `dataOmitted: true` rather than returned half-written, and the record
  itself may exceed a very small `maxChars`.
  Don't format a result anywhere else. Every executor call goes through
  `runExecutor`, which turns a *thrown* executor error into an `{ errors }`
  result — an uncaught throw reaches the SDK, which emits the bare message as
  text and breaks the parseable-JSON promise on exactly the failure a client
  most needs to read. These helpers are exported from `index.ts` on purpose: a
  custom tool that runs GraphQL must be able to produce the same envelope
  instead of hand-rolling `isError` and reintroducing the bugs they fix.
- **Pure vs. bound.** `buildTools` produces pure `ToolDescriptor`s (no SDK, no
  executor). `server.ts` binds them to an executor + `McpServer`. Keep that split.
- **Stateless HTTP needs a fresh server per request.** An `McpServer` owns a
  single transport, so the handlers mint a new server+transport per request
  (descriptors are built once and reused). Don't share one server across
  concurrent requests. Stateful mode (`sessions`) is the deliberate exception:
  one server per *session* is what makes server-initiated messages possible at
  all, and the price is state that has to be bounded — hence `SessionStore`'s
  idle timeout and LRU cap. It sweeps on lookup rather than on a timer, because
  a timer would need `unref`ing and would add a lifecycle callers must own.
- **The tool listing is rendered once per factory (`handlers.ts`).** The SDK
  converts each tool's Zod schema to JSON Schema *inside* its `tools/list`
  handler, not at registration — so a stateless server repeats that conversion on
  every request, and it is the bulk of the request: on a 50-tool CRUD schema,
  20-29 ms per listing against 0.3 ms to mint the server. Its handler reads
  neither the request nor `extra`, and every server a factory mints registers the
  same tools, so `shareToolListing` renders the first one and reuses it (0.5-0.8
  ms). It *wraps* the SDK's handler rather than reimplementing it, so the bytes
  stay the SDK's; if the handler can't be found, nothing is cached and every
  listing renders as before. Any change to a tool set — `registerTool` on a live
  server, or `enable`/`disable`/`update`/`remove`, all of which call
  `sendToolListChanged` — retires the cache permanently, because from then on two
  servers can disagree about what they expose. `registerGeneratedTool` hoists its
  `z.object(shape).strict()` for the same reason (a `WeakMap` on the shape).
- **A session's stream is resumable, and the buffer is bounded** (`eventStore.ts`).
  The SDK writes SSE event ids only when given an `eventStore`, so without one a
  dropped connection loses whatever was in flight — which is the work a stateful
  session exists to deliver. Each session gets its own `MemoryEventStore`
  (`replay: true`, the default), capped on events per stream *and* streams per
  session, so the ceiling is `maxSessions × maxStreams × maxEventsPerStream` and
  the buffers die with the session the table was already bounding. One store per
  session, never shared: a shared buffer would let one session's reconnect replay
  another's events. An aged-out event id is reported as *unknown*
  (`getStreamIdForEventId` → `undefined`, which the transport answers with a
  400) rather than replayed as the surviving suffix — a client told its resume
  point is gone can start over, one handed a stream with a silent gap cannot.
- **A session can't move between instances**, so `SessionDirectory` shares session
  *ownership*, not sessions. An `McpServer` is a live object — a connected
  transport and registered handlers — which is why the table stays per-process
  and why the store interface is keyed on identity (`claim`/`owner`/`release`)
  rather than session objects. It does no routing: a request that reached the
  wrong instance still gets the spec's 404, but one that names the owner (and
  repeats it in `Mcp-Session-Owner`) instead of an anonymous one, which is the
  difference between a diagnosable stickiness bug and an intermittent mystery.
  `claim` is re-issued on every use so it doubles as a TTL refresh; every path
  that ends a session releases, and a directory that throws never blocks
  teardown — a stale claim expires, a leaked session does not. No directory by
  default, so the single-process case stays zero-config.
  `EventStore` is modelled structurally here rather than imported, so the public
  types hold across the whole peer range and a caller can supply Redis or a
  Durable Object for replay that survives a restart.
- **Two handlers, one behaviour.** `http.ts` (Node) and `fetch.ts`
  (`Request`/`Response`) differ only in how a request reaches the transport;
  session handling, context derivation, and the 404-for-an-unknown-session rule
  are shared and must stay in step. `fetch.ts` imports the SDK's web-standard
  transport *lazily* — it only exists in SDK ≥ 1.25 while the peer range starts
  at 1.12, and a top-level import would make the whole package unloadable for
  Node users who will never call it.
- **Custom tools** (the `tools` option) add to — or override by name — generated
  tools. `registerTool` throws on duplicate names, so overrides are resolved
  *before* registering. Full precedence, four surfaces deep:
  `generated < operations < meta < tools`. The `operations` fold (`withOperations`
  in `server.ts`) is a `Map` keyed by name, so an operation replacing a generated
  tool keeps that tool's **slot** in the listing — swapping an implementation
  should not reshuffle a listing an agent may already have read.
- **`decorateServer` runs in the only window that works.** Prompts and resources
  can declare their capabilities only while no transport is attached, so the
  hook is called between minting the server and connecting it — and *before*
  `shareToolListing`, because the SDK's `registerTool` calls
  `sendToolListChanged`, whose override latches `cache.off` unconditionally and
  would retire issue #16's listing cache factory-wide. It is synchronous by
  construction (a thenable return throws): `ServerFactory` is sync and both
  handlers mint-then-connect, so an await there is registration racing
  `initialize`. Two hazards live in the README rather than in code, because
  neither is detectable at runtime: a hook that varies its *tool* set serves one
  server's cached listing to another (`sendToolListChanged` is a no-op
  pre-connect, so nothing can invalidate it), and a tool registered in the hook
  is absent from `validators`, so a bad call falls back to the SDK's `-32602`
  instead of the `BAD_INPUT` envelope.
- **Anything the SDL says, the agent sees.** A description carries the field's
  deprecation reason (right under the summary, before the signature), each
  argument's default rendered as the GraphQL literal a caller would write, and
  argument-level deprecations; an unmapped custom scalar keeps its own SDL
  description, which is where the wire format is documented. Deprecated fields
  stay callable by default (`includeDeprecated: false` drops them) — the schema
  is the source of truth, and a deprecated field is often still the only way to
  do something. When adding a projection, ask what graphql-js already knows that
  we're discarding — and apply it to *both* surfaces: `graphql_introspect`'s
  root-field overview builds its own lines rather than printing SDL, so it needs
  the same treatment as a tool description or a large schema's only discovery
  path silently disagrees with its tools.
- **Annotations:** queries are `readOnlyHint`/`idempotentHint`; mutations are
  `destructiveHint`. All tools set `openWorldHint` (they reach a backend).
- **The advertised version comes from `package.json`** (`version.ts`), not a
  literal. semantic-release bumps the manifest, so a hardcoded default would
  have every published server announcing the version it shipped with.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary` (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`). Keep the summary imperative and under ~72 characters; one logical
change per commit. Commit messages **drive releases**: `feat:` → minor, `fix:` →
patch, a `BREAKING CHANGE:` footer → major; `chore:`/`docs:`/`test:`/`ci:` don't
publish.

**Integrate with `merge`, never `rebase`.** When `main` has moved ahead — most
often because semantic-release pushed a `chore(release):` commit while you were
working — bring it in with `git merge` (or `git pull --no-rebase`). Rebasing
rewrites commits that are already published on `main` and that release tags
point at, so never reach for `git rebase` or `git pull --rebase` here.

## CI & releases

Two GitHub Actions workflows:

- **`.github/workflows/test.yml`** — runs on every push: biome check, typecheck,
  typecheck:tests, test, coverage, build.
- **`.github/workflows/release.yml`** — runs after **Test** succeeds on `main`,
  then `npx semantic-release` ([`.releaserc.json`](./.releaserc.json)).
  `@semantic-release/npm` bumps `package.json`, updates `CHANGELOG.md`, and
  publishes; `@semantic-release/github` cuts the `v${version}` tag + release.

Requires repo secret **`NPM_ACCESS_TOKEN`** (OIDC trusted publishing via
`id-token: write` is preferred; the token is the fallback for the first publish).
`GITHUB_TOKEN` is provided by Actions. Validate locally with
`npx semantic-release --dry-run`.

## Deferred work

Tracked as [GitHub issues](https://github.com/cubicecho/graphql-mcp/issues), not
in a file — a checklist in the repo goes stale silently, and an issue can be
argued with. `TODO.md` was retired once its contents were filed.

Three entries were *decisions*, not deferred work, so they live here instead.
All have been reconsidered and settled; reopen them only against new evidence.

- **No stdio convenience (`createStdioServer()`).** This package is built to run
  *side-by-side* with a GraphQL server — mounted on a route in the same app, or
  as a process forwarding to a remote endpoint — and both are HTTP shapes.
  Owning a stdio entry point would mean owning a lifecycle (process signals,
  stream teardown) the HTTP path never touches, and a caller who genuinely wants
  stdio can wrap `createMcpServer` with the SDK's `StdioServerTransport` in a few
  lines; the README shows how. Revisit only if the side-by-side model stops being
  the primary one.
- **The meta tools are not memoized, and measurement says they shouldn't be.**
  `graphql_introspect` and `graphql_search` recompute from the schema on every
  call, which looks like an obvious cache. It isn't worth one. On a 2,000-type
  schema the no-argument overview costs 2.6 ms and a full-miss search 3.2 ms; at
  an implausible 5,000 types they are 5.7 ms and 8.6 ms. Both are linear and
  small next to the round trip and the model reading the output. The comparison
  that settles it: in stateless mode `createServerFactory` already hoists the
  schema walk out of the request path, and what remains — minting a server and
  registering its tools — costs **32.7 ms** per request at 2,000 root fields. A
  cache would shave ~3 ms off a 33 ms path, and would have to key on the rule
  matcher as well as the schema (a closure, so identity-keyed) or serve one
  caller's filtered view to another. Complexity and a stale-result bug surface
  for no measurable gain. If this is ever revisited, the per-request server
  minting is the number to attack, not the meta tools — issue #16 did exactly
  that and found the real cost was the SDK's per-request `tools/list` rendering,
  now shared by `handlers.ts`.
- **Subscriptions are ignored.** MCP has no streaming-subscription tool shape, so
  there is nothing to project a `Subscription` field *onto* — a tool that can
  only ever return one event misrepresents what the field does. They are dropped
  from tool generation and the `execute` meta tool refuses them explicitly, which
  is the honest failure. Revisit if MCP grows a streaming result shape.
