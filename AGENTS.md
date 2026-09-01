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
  meta.ts         — opt-in schema-exploration tools (buildMetaTools): introspect/search/validate/execute
  result.ts       — GraphqlResult → CallToolResult (toCallToolResult): isError, error condensing, clamping
  executor.ts     — createLocalExecutor (in-process) / createHttpExecutor (forwarding)
  server.ts       — createMcpServer / createServerFactory / connectServer / registerGraphqlTools (+ custom tools)
  zodCompat.ts    — zod v3/v4-tolerant type aliases (AnyZodType, ZodShape)
  version.ts      — VERSION, read from package.json (the version servers advertise)
  pagination.ts   — paging-argument detection for truncation hints (paginationHint)
  sessions.ts     — the bounded session table behind stateful HTTP (SessionStore)
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
- **`connectServer(server, transport)` is how a server should be connected.**
  `params.arguments` is optional in the MCP schema, and a tool whose arguments
  are all optional gives a client nothing to put there — but the SDK hands that
  `undefined` straight to the input schema, which rejects it before the handler
  runs, and the tool is uncallable. The fix cannot live in the schema: the SDK
  renders `tools/list` from the same value it validates against, and anything
  that parses `undefined` stops being recognised as an object schema (the tool
  is then advertised as taking no arguments at all). So `connectServer` wraps
  `transport.onmessage` after `connect` and defaults a missing `arguments` to
  `{}`. `createHttpHandler` and `createFetchHandler` use it; a caller wiring up
  its own transport (stdio) should too.
- **Tools pass arguments as GraphQL variables**, never inlined into the query
  string — the executor's variable layer handles coercion/escaping.
- **Selection sets are auto-generated** (`buildSelectionSet`): all scalar/enum
  leaves at each level, descending into nested objects up to `selectionDepth`
  (default 2), always including `__typename`. Fields requiring arguments and
  cyclic types are skipped. Because the agent can't choose the selection, each
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
  JSON is clamped to `maxChars` (default 50k) with a note saying how much was
  cut — naming the field's paging argument when it has one, because a bare
  "truncated" leaves an agent with no move but to re-run the identical call.
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
- **Two handlers, one behaviour.** `http.ts` (Node) and `fetch.ts`
  (`Request`/`Response`) differ only in how a request reaches the transport;
  session handling, context derivation, and the 404-for-an-unknown-session rule
  are shared and must stay in step. `fetch.ts` imports the SDK's web-standard
  transport *lazily* — it only exists in SDK ≥ 1.25 while the peer range starts
  at 1.12, and a top-level import would make the whole package unloadable for
  Node users who will never call it.
- **Custom tools** (the `tools` option) add to — or override by name — generated
  tools. `registerTool` throws on duplicate names, so overrides are resolved
  *before* registering.
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

See [TODO.md](./TODO.md).
