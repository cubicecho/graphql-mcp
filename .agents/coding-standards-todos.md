# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. This file lives at
`.agents/coding-standards-todos.md`. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from reading rather than confirmed by a run.
Nothing here is implemented until approved.

Baseline (2026-10-07, v2.10.0): `biome check .` clean, both typechecks clean, 491 tests pass,
coverage 99.35% lines / 96.41% branches, build clean.

## Model

**Purpose.** Turn a GraphQL schema into an MCP server: each root field (or hand-written
operation) becomes a tool whose input is validated, whose call runs through an executor, and
whose result is shaped into one text envelope.

**Flow.** schema → (extend) → per-field pipeline → tool descriptor → folded with operation,
meta and custom tools → registered on an `McpServer` → served over stdio, Node HTTP or fetch,
optionally with sessions and replay.

Concepts that have two owners today, and the single owner proposed:

- **M1 — Session lifecycle.** `http.ts` and `fetch.ts` each resolve session options, look a
  session up, answer 404 with the owner, and mint a session with the same callbacks. To be: one
  owner of the lifecycle; each adapter only translates its request and response types.
- **M2 — Returnable-field walk.** `selection.ts` and `output-schema.ts` each decide which fields
  are returned (skip fields with required arguments, stop at depth, stop on a cycle). The output
  schema is only true while both agree. To be: one walk, two renderers.
- **M3 — Argument listing.** `tools.ts` and `operations.ts` each build the same "Arguments"
  block of a tool description. To be: one builder.

**Explain test.** After M1–M3: "a field is projected once into a descriptor; one walk decides
what it returns; one session lifecycle serves both transports."

## Summary

| Prefix | Kind |
|---|---|
| `R` | Refactor: same behavior, better shape |
| `F` | Feature: new behavior |
| `T` | Test work |
| `D` | Comment or doc that no longer matches the code |
| `B` | Bug, or near copies that behave differently |
| `A` | Public API change; needs a decision |

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| B1 | Bug | A session directory whose `claim` fails no longer escapes as an unhandled rejection (or aborts `add` when it throws synchronously). | A Redis blip stops being able to crash the Node process | — | done |
| T1 | Test [pin] | Adds a test that the generated selection and the output schema name exactly the same fields at depths 1–3 on the fixture schema. | Protects R1; guards a hand-synced pair today | — | done |
| R1 | Refactor [reuse] | Selection set and output schema are produced from one walk over returnable fields instead of two copies of the rules. | M2 | T1 | done |
| R2 | Refactor [reuse] | The HTTP and fetch handlers share one session lifecycle; each keeps only its request/response translation. | M1 | — | done |
| R3 | Refactor [reuse] | Generated tools and operation tools build the "Arguments" part of a description with one function. | M3 | — | done |
| R4 | Refactor [sweep] | Merges 12 small helper pairs that exist twice (describe, enum-to-zod, scalar lookup, error text, kind-from-operation, and others). | P6 sweep | — | done |
| R5 | Refactor [readability] | Splits the 60-line closure inside `buildTools` into named steps and renames single-letter parameters. | The hottest file (24 commits/yr) reads as its pipeline | — | done |
| R6 | Refactor [pattern] | Internal functions taking 5–7 positional arguments take one named-field object instead. | Call sites stop depending on argument order | — | done |
| R7 | Refactor [pattern] | The meta-tool `switch` and the example-leaf `switch` become lookup tables, and the meta-tool name list and its type are derived from one source. | P24, P14: a new meta tool is one entry | — | done |
| R8 | Refactor [sweep] | Braces every single-line `if`/`for` body (128 in source, 17 in tests) and turns the lint rule on. | P15 sweep | — | done |
| R9 | Refactor [sweep] | Rewrites 36 logic negations (`!x`) as named positive conditions and turns the lint plugin on. | P20 sweep | R8 | done |
| R10 | Refactor [sweep] | Names the magic values: 10 numbers plus repeated strings (error prefix, session header, JSON-RPC codes, the search limit that is also typed into its description). | P16 sweep | — | done |
| R11 | Refactor [sweep] | Removes the type assertions that a narrower type makes unnecessary (about 12 of 28) and gives each remaining one a stated reason. | P17 sweep | — | done |
| R12 | Refactor [sweep] | Adds the missing doc blocks (30 functions) and missing `@param`/`@returns` tags (78 and 85 functions). | P4 sweep | — | done |
| R13 | Refactor [sweep] | Shortens 54 doc blocks over four sentences and 25 body comments over two lines; the rationale already lives in AGENTS.md. | P19 sweep; source is 45% comment lines | decision | done |
| R14 | Refactor [consistency] | Adds the house tsconfig flags and the `check:biome` / `check:types` script names. | Same commands and checks as other cubicecho repos | — | done |
| T2 | Test [reuse] | Moves test helpers that exist in two or three test files (`connect`, `fieldType`, `unwrap`, result-body readers) into the shared fixtures file. | One place to change when the SDK client API moves | — | done |
| T3 | Test [reliability] | Replaces the wall-clock comparison in the listing-cache test with a count of renders; it fails about one run in three on zod 3. | The peer-version CI leg stops failing at random | — | done |
| A1 | API change | `registerGraphqlTools` takes an options object instead of five positional arguments; breaks every caller. | Same reason as R6 | decision | open |
| A2 | API change | `GraphqlError`'s extra keys become `unknown` instead of `any`; consumers reading extra keys need a narrowing. | P18 | decision | open |
| B2 | Bug · low value | Three `messageOf` copies differ: only one turns an empty message or a thrown plain object into readable text. Is that intended? | Consistent error text | — | done |
| B3 | Bug · low value | `createHttpExecutor` trusts the response body's shape; a JSON body that is not an object gives a confusing error (unverified). | Clearer failure message | — | done |
| B4 | Bug · low value | The stateless HTTP path closes transport and server in a `close` listener without handling a rejection (unverified). | No stray rejection | — | done |
| R15 | Refactor [consistency] · low value | Groups the eight scattered `DEFAULT_*` tunables in one `defaults.ts`, keeping every exported name. | P22 | — | done |
| R16 | Refactor [consistency] · low value | Renames nine camelCase files to kebab-case and updates AGENTS.md's module list. | House file naming | — | done |
| R17 | Refactor [consistency] · low value | Reformats to line width 120. | House formatter setting; touches every file | — | done |
| R18 | Refactor [structure] · low value | Groups the flat 23-module `src/` into folders by concept. | P21; AGENTS.md documents the flat layout today | decision | done |
| A3 | API change · low value | Exports named objects for the closed sets (`NameCase`, `NullBranches`, `MutationHints`, operation kind). | P16 for consumers | decision | done |
| R19 | Refactor [structure] | Moves the `NullBranches` type into `core/types.ts`, removing the only upward import. | P21 layering | — | done |
| A4 | API change | Groups the defaults into frozen objects (`RESULT_DEFAULTS`, `REPLAY_DEFAULTS`, `SESSION_DEFAULTS`, …); renames six exported constants. | P22 full form | decision | open |

Status is `open`, `approved`, `declined` or `done`.

## Conventions

- Failures throw with a teaching message prefixed `graphql-mcp: `; tool-call failures return an
  error envelope through `toCallToolResult` instead of throwing.
- Tests are co-located as `src/**/*.test.ts` on `node --test` (AGENTS.md; overrides P21's
  separate test folders).
- Shared test fixtures live in `src/core/fixtures.test.ts`.
- `index.ts` is the only re-exporter; anything exported there is public API.
- Generated files: `CHANGELOG.md` (semantic-release), `dist/` (`npm run build`, ignored).
- Every change runs the AGENTS.md gate, including the `zod@^3.25` + `graphql@^17` leg.
- Commit types: `refactor:`/`test:`/`docs:`/`chore:` do not publish; `fix:` and `feat:` do.

## Refactoring

### R1 [reuse] — one returnable-field walk

**File:** `src/selection.ts:76-104`, `src/output-schema.ts:96-127`. Both `compositeFields`
apply the same three rules in the same order. A rule changed in one file makes the advertised
output schema disagree with what the query returns. Target: a walk that yields
(field, leaf | nested) decisions, owned by `selection.ts`; each module renders from it.
Implements M2. Needs T1.

### R2 [reuse] — one session lifecycle for both transports

**File:** `src/http.ts:97-173`, `src/fetch.ts:135-198`. Option resolution, lookup, the 404
answer, session minting and `close` are the same; only the stateless teardown and the
response type differ. Target: a helper in `sessions.ts` that the adapters call with a
transport constructor. Implements M1. Covered by `http.test.ts` and `fetch.test.ts`.

### R3 [reuse] — one argument listing

**File:** `src/tools.ts:660-677`, `src/operations.ts:361-376`. Identical block; owner
`tools.ts`, next to `describeArgument`. Implements M3.

### R4 [sweep] — apply P6 (merge copies at two)

**Hits:** 12 pairs. `describe` (zodSchema, outputSchema); enum-to-zod (same two); scalar
lookup `mapped ?? builtinScalar` (same two); "Invalid document" error (meta ×2); operation
kind from AST (meta, operations); visible-type filter (meta ×2); truncation advice (result
×2); bad-input error envelope (server `toVariables` ×2); `_requestHandlers` cast (handlers
×2, a helper already exists); camel-split regex (tools ×2); LRU re-insert and evict-oldest
(sessions, eventStore); JSON-RPC error body (http, fetch — folds into R2 if approved).

Done for ten pairs. Left alone: the LRU re-insert and evict-oldest loops in `sessions.ts` and
`event-store.ts` — two lines each over different maps, and sharing them needs a new module.
The JSON-RPC body went with R2.

### R5 [readability] — name the steps of the per-field pipeline

**File:** `src/tools.ts` (`buildTools` → `collect`, `applyPatch(d, …)`, `applyExtensions(d, …)`).
Five filter one-liners, descriptor build, extensions, decorate-with-rebuild and the duplicate
check sit in one closure. Target: `isExposed(field)`, `describeField`, `decorated`, each named.

### R6 [pattern] — parameter objects for long positional lists

**File:** `src/server.ts` (`registerGeneratedTool`, 6), `src/operations.ts`
(`buildDescription`, 7), `src/tools.ts` (`buildDescription`, 5), `src/meta.ts`
(`executeTool`, 5). Internal only; the public one is A1.

### R7 [pattern] — lookup tables for closed-set picks

**File:** `src/meta.ts:41-43,96-111`, `src/arg-example.ts:197-213`. `MetaToolName` and
`ALL_META_TOOLS` are typed twice by hand.

### R8 [sweep] — apply P15 (braced bodies)

**Hits:** 128 source, 17 test. meta 25, tools 16, argExample 14, server 14, operations 9,
eventStore 8, result 8, sessions 8, zodSchema 8, handlers 7, pagination 5, outputSchema 3,
fetch 1, http 1, rules 1. Enables Biome `useBlockStatements`. AGENTS.md does not ask for the
current style. Mostly an auto-fix.

### R9 [sweep] — apply P20 (no logic negation)

**Hits:** 21 source, 15 test. meta 6, argExample 4, tools 4, extend 3, server 2, operations 1,
result 1. Adds the `no-negation.grit` plugin.

### R10 [sweep] — apply P16 (no magic values)

**Hits:** 10 numbers (meta 3, sessions 3, fetch 2, http 2) and the repeated strings
`'graphql-mcp: '`, `'graphql-mcp-server'`, `'mcp-session-id'`, `404`/`-32001`, `'graphql_'`,
and the search limit `50` that also appears in its description text. Internal constants only.

### R11 [sweep] — apply P17 (type assertions)

**Hits:** 28 in source: operations 7, server 4, meta 3, handlers 3, fetch 3, zodSchema 2,
tools 2, executor 2, http 1, argExample 1. Removable by narrowing: `definition.name?.value as
string` (operations ×2, after `assertUsable`), `applyPatch`'s `as unknown as Record`,
`args.x as …` in meta handlers, the duplicated handlers cast. The SDK-boundary ones
(`fetch.ts:103,209`, `server.ts:583`, `handlers.ts`) stay, with one comment each.

### R12 [sweep] — apply P4 (doc blocks and tags)

**Hits:** 30 of 147 functions have no doc block (meta 11, server 5, eventStore 4,
sessions 4); 78 lack `@param`, 85 lack `@returns`. Existing tag syntax is already correct.

### R13 [sweep] — apply P19 (short comments)

**Hits:** 54 doc blocks over four sentences (tools 14, zodSchema 8, server 6, sessions 5),
25 body-comment runs over two lines (longest 19, in argExample). Decision needed: the long
blocks carry design rationale; most of it is also in AGENTS.md, but not all. Cutting means
moving what is unique into AGENTS.md first.

### R14 [consistency] — house tsconfig flags and script names

**File:** `tsconfig.json`, `package.json`. Adds `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, `isolatedModules`; adds `check:biome` and `check:types`, with
`check` running both. Existing script names stay.

---

## Tests

### T1 [pin] — selection and output schema agree

**File:** `src/output-schema.test.ts`. Only one case (depth 1) compares them today. Pin before R1.

### T2 [reuse] — shared test helpers

**File:** `connect` in `server.test.ts`, `http.test.ts`, `fetch.test.ts`; `fieldType` in
`selection.test.ts`, `output-schema.test.ts`; `unwrap` in `zod-schema.test.ts`,
`output-schema.test.ts`; `parseResult`/`bodyOf`/`body` in `server.test.ts`, `result.test.ts`,
`meta.test.ts`. Owner: `src/fixtures.test.ts`.

### T3 [reliability] — the listing-cache timing test is flaky on zod 3

**File:** `src/server.test.ts` ("the second listing costs a fraction of the first"). Asserts
`withCache * 2 < withoutCache` on wall-clock time. On `zod@^3.25` + `graphql@^17` it failed 2 of
4 runs on 2026-10-07 while every other test passed. Found during R9; not caused by it.

---

## Docs

Not audited: comment-versus-code drift was not checked line by line in this pass.

---

## Bugs

### B1 — a failing directory claim is unhandled

**File:** `src/sessions.ts:231,275`. `void this.directory?.claim(...)` discards the promise.
A probe with `claim: async () => { throw … }` fails the test run with the raw error, so in
production it is an `unhandledRejection`, which ends a Node process by default. A synchronous
throw aborts `add` before the session is usable. `release` is already guarded by
`releaseQuietly`; claim needs the same. Ships as `fix:` (patch release).

---

## API changes (need a decision)

### A1 — `registerGraphqlTools` options object

Breaking for callers; major release, or add an overload and deprecate the positional form.

### A2 — `GraphqlError` index signature `unknown`

**File:** `src/types.ts`. Type-level break only.

---

## Low value

### B2 — `messageOf` copies differ

**File:** `src/result.ts:278`, `src/handlers.ts:198`, `src/operations.ts:430`.

### B3 — HTTP executor trusts the body shape (unverified)

**File:** `src/executor.ts:87`.

### B4 — floating close promises on the stateless HTTP path (unverified)

**File:** `src/http.ts:119-122`.

### R15 [consistency] — `defaults.ts`

Eight `DEFAULT_*` constants across result, selection, argExample, eventStore, sessions. All
are exported, so the names must stay.

### R16 [consistency] — kebab-case file names

argExample, eventStore, outputSchema, zodCompat, zodSchema and four test files.

### R17 [consistency] — line width 120

### R18 [structure] — folders by concept

### A3 — exported vocabulary objects
