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
- **Dependencies:** `zod` (the SDK's input-schema format) is the only runtime
  dependency. `@modelcontextprotocol/sdk` (`>=1.12`) and `graphql` (`>=16`) are
  **peer deps**. Express is *not* a dependency — the HTTP handler is framework-agnostic.
- **Guiding constraint:** avoid adding libraries unless writing it ourselves
  isn't worth the effort (e.g. the GraphQL→Zod mapping is hand-written).

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
  operation.ts    — per-field operation documents (buildOperation)
  tools.ts        — schema → ToolDescriptor[] (buildTools): names, descriptions, annotations
  executor.ts     — createLocalExecutor (in-process) / createHttpExecutor (forwarding)
  server.ts       — createMcpServer / createServerFactory / registerGraphqlTools (+ custom tools)
  http.ts         — createHttpHandler for the Streamable HTTP transport
  *.test.ts       — co-located tests; fixtures.test.ts holds the shared "todos" schema
```

## Architecture & conventions

- **The schema is the source of truth.** Tool name, description, and input
  schema mirror the GraphQL surface one-to-one. Don't hardcode domain types.
- **One seam for execution: `GraphqlExecutor`.** A tool builds a
  `{ query, variables, operationName, context }` request and hands it to the
  executor; it never knows whether GraphQL runs in-process or over HTTP. The
  default is `createLocalExecutor(schema)`.
- **Tools pass arguments as GraphQL variables**, never inlined into the query
  string — the executor's variable layer handles coercion/escaping.
- **Selection sets are auto-generated** (`buildSelectionSet`): all scalar/enum
  leaves at each level, descending into nested objects up to `selectionDepth`
  (default 2), always including `__typename`. Fields requiring arguments and
  cyclic types are skipped.
- **Pure vs. bound.** `buildTools` produces pure `ToolDescriptor`s (no SDK, no
  executor). `server.ts` binds them to an executor + `McpServer`. Keep that split.
- **Stateless HTTP needs a fresh server per request.** An `McpServer` owns a
  single transport, so `createHttpHandler` mints a new server+transport per
  request (descriptors are built once and reused). Don't share one server across
  concurrent requests.
- **Custom tools** (the `tools` option) add to — or override by name — generated
  tools. `registerTool` throws on duplicate names, so overrides are resolved
  *before* registering.
- **Annotations:** queries are `readOnlyHint`/`idempotentHint`; mutations are
  `destructiveHint`. All tools set `openWorldHint` (they reach a backend).

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary` (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`). Keep the summary imperative and under ~72 characters; one logical
change per commit. Commit messages **drive releases**: `feat:` → minor, `fix:` →
patch, a `BREAKING CHANGE:` footer → major; `chore:`/`docs:`/`test:`/`ci:` don't
publish.

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
