# [2.7.0](https://github.com/cubicecho/graphql-mcp/compare/v2.6.0...v2.7.0) (2026-09-02)


### Features

* **operations:** build tools from hand-written GraphQL documents ([555b8f4](https://github.com/cubicecho/graphql-mcp/commit/555b8f4939ff21c0587880180be2db779707f4f1)), closes [#15](https://github.com/cubicecho/graphql-mcp/issues/15) [#21](https://github.com/cubicecho/graphql-mcp/issues/21)
* **server:** add the operations option ([cf6da4b](https://github.com/cubicecho/graphql-mcp/commit/cf6da4b8eb6148a45aa56f29ccb72d7a445cdaa7)), closes [#21](https://github.com/cubicecho/graphql-mcp/issues/21) [#21](https://github.com/cubicecho/graphql-mcp/issues/21)

# [2.6.0](https://github.com/cubicecho/graphql-mcp/compare/v2.5.1...v2.6.0) (2026-09-02)


### Features

* add mapArgs, rewriting a generated tool's argument shape ([d038aef](https://github.com/cubicecho/graphql-mcp/commit/d038aefd1701559e074df56d87c272e4ca0b482b)), closes [#21](https://github.com/cubicecho/graphql-mcp/issues/21)
* **meta:** show an input type's shape example under introspect ([4c64895](https://github.com/cubicecho/graphql-mcp/commit/4c6489504da88e868de2619b6a590b0c9fb66e67))
* **server:** add decorateServer for prompts, resources, and the rest of the SDK ([552a947](https://github.com/cubicecho/graphql-mcp/commit/552a947786b21384ce8065220c9e4bbe6b1c44a6)), closes [#20](https://github.com/cubicecho/graphql-mcp/issues/20)
* **tools:** make nullBranches a per-field decision ([df30d5f](https://github.com/cubicecho/graphql-mcp/commit/df30d5ff6b1c23b1cd42cbfa9c28d65daaf7e617)), closes [#22](https://github.com/cubicecho/graphql-mcp/issues/22)
* **tools:** show a literal argument-shape example in descriptions ([1b09f17](https://github.com/cubicecho/graphql-mcp/commit/1b09f17f8133b5d2b5762f79543a9f551920f835)), closes [#21](https://github.com/cubicecho/graphql-mcp/issues/21) [#21](https://github.com/cubicecho/graphql-mcp/issues/21)

## [2.5.1](https://github.com/cubicecho/graphql-mcp/compare/v2.5.0...v2.5.1) (2026-09-02)


### Bug Fixes

* **server:** default a prompts/get with no arguments to {} ([ca5b2fd](https://github.com/cubicecho/graphql-mcp/commit/ca5b2fdcbe6c1eaad1805dfada264e52723e2d62))

# [2.5.0](https://github.com/cubicecho/graphql-mcp/compare/v2.4.0...v2.5.0) (2026-09-01)


### Features

* **sessions:** report session ownership across instances ([40bf31b](https://github.com/cubicecho/graphql-mcp/commit/40bf31b784aa6a20c70cc51480b2a0d68836ab85)), closes [#10](https://github.com/cubicecho/graphql-mcp/issues/10)

# [2.4.0](https://github.com/cubicecho/graphql-mcp/compare/v2.3.0...v2.4.0) (2026-09-01)


### Features

* **sessions:** buffer SSE events so a dropped stream can resume ([7f5f9b2](https://github.com/cubicecho/graphql-mcp/commit/7f5f9b26d387ab86d57f907bb1ce6a6c96d66e7a)), closes [#9](https://github.com/cubicecho/graphql-mcp/issues/9)

# [2.3.0](https://github.com/cubicecho/graphql-mcp/compare/v2.2.1...v2.3.0) (2026-09-01)


### Features

* **tools:** make selectionDepth a per-field decision ([76b8a0b](https://github.com/cubicecho/graphql-mcp/commit/76b8a0bd7b2cf4e8eace735e2ee7d4c6dc0635d8)), closes [#18](https://github.com/cubicecho/graphql-mcp/issues/18)
* **tools:** opt into deriving mutation write hints from field names ([326acbe](https://github.com/cubicecho/graphql-mcp/commit/326acbefa55240a0e35c28d5b5d0c2615d719930)), closes [#19](https://github.com/cubicecho/graphql-mcp/issues/19)

## [2.2.1](https://github.com/cubicecho/graphql-mcp/compare/v2.2.0...v2.2.1) (2026-09-01)


### Bug Fixes

* **server:** answer a malformed call in the JSON envelope ([3e4706e](https://github.com/cubicecho/graphql-mcp/commit/3e4706e57b120f8a623563365b32539322795bdf)), closes [#17](https://github.com/cubicecho/graphql-mcp/issues/17)


### Performance Improvements

* **server:** render the tool listing once per server factory ([535c006](https://github.com/cubicecho/graphql-mcp/commit/535c00644794bf4bf7f5810343ae44b0341b0d2e)), closes [#16](https://github.com/cubicecho/graphql-mcp/issues/16)

# [2.2.0](https://github.com/cubicecho/graphql-mcp/compare/v2.1.0...v2.2.0) (2026-09-01)


### Features

* advertise argument defaults in the JSON Schema without applying them ([5b7f87c](https://github.com/cubicecho/graphql-mcp/commit/5b7f87c74c9a86bee22644ee4a8db8ded3bafe34)), closes [#13](https://github.com/cubicecho/graphql-mcp/issues/13)

# [2.1.0](https://github.com/cubicecho/graphql-mcp/compare/v2.0.2...v2.1.0) (2026-09-01)


### Features

* add nullBranches to drop redundant null branches from input schemas ([4daab91](https://github.com/cubicecho/graphql-mcp/commit/4daab91a4c0eda20ac47f1a54e3ef308d00519e8)), closes [#8](https://github.com/cubicecho/graphql-mcp/issues/8)

## [2.0.2](https://github.com/cubicecho/graphql-mcp/compare/v2.0.1...v2.0.2) (2026-09-01)


### Bug Fixes

* clamp oversized results structurally so the body stays parseable JSON ([5c9ec27](https://github.com/cubicecho/graphql-mcp/commit/5c9ec279b0afa8e9b4db4d6c1da2801bbd0f21ad)), closes [#6](https://github.com/cubicecho/graphql-mcp/issues/6) [#7](https://github.com/cubicecho/graphql-mcp/issues/7)

## [2.0.1](https://github.com/cubicecho/graphql-mcp/compare/v2.0.0...v2.0.1) (2026-09-01)


### Bug Fixes

* name hoisted input types after their GraphQL type ([bd30626](https://github.com/cubicecho/graphql-mcp/commit/bd3062634f2dafb40c6bf407dffe6618b1efbfe2)), closes [#4](https://github.com/cubicecho/graphql-mcp/issues/4)

# [2.0.0](https://github.com/cubicecho/graphql-mcp/compare/v1.0.2...v2.0.0) (2026-09-01)


* feat!: make zod a peer dependency spanning v3 and v4 ([3a440c7](https://github.com/cubicecho/graphql-mcp/commit/3a440c7a0629ce97fa5d992403804ba3d3d0d129)), closes [#3](https://github.com/cubicecho/graphql-mcp/issues/3)


### BREAKING CHANGES

* zod is now a peer dependency instead of a bundled one.
Install it alongside this package: `npm install zod`. Any version in
`^3.25 || ^4.0` works. Consumers who already depend on zod directly — which
is most, since the `scalars` option takes zod schemas — need no change beyond
having it in their own package.json.

## [1.0.2](https://github.com/cubicecho/graphql-mcp/compare/v1.0.1...v1.0.2) (2026-09-01)


### Bug Fixes

* reject unknown input fields instead of silently dropping them ([015bb2b](https://github.com/cubicecho/graphql-mcp/commit/015bb2bc91146097d503c1d115bf50946c926af9)), closes [#2](https://github.com/cubicecho/graphql-mcp/issues/2)

## [1.0.1](https://github.com/cubicecho/graphql-mcp/compare/v1.0.0...v1.0.1) (2026-09-01)


### Bug Fixes

* answer a tools/call that omits its arguments ([8b70d8a](https://github.com/cubicecho/graphql-mcp/commit/8b70d8a5f90db039726b4ac9ea816866ca4f8528))
* build each input type once so tool schemas stay readable ([1f03252](https://github.com/cubicecho/graphql-mcp/commit/1f0325207a5a3e3bc88c0cc0a3383958e1321ee4))

# [1.0.0](https://github.com/cubicecho/graphql-mcp/compare/v0.2.1...v1.0.0) (2026-09-01)


* feat(tools)!: name generated tools in snake_case ([bb7ff8c](https://github.com/cubicecho/graphql-mcp/commit/bb7ff8c17fc3a9e87bcd15161584b30a004760ad))


### BREAKING CHANGES

* generated tool names are now snake_case. A client or prompt
pinned to `createTodo` must call `create_todo`, or pass
`nameCase: 'preserve'` to keep field names verbatim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018oYxVnQ6d7DuVwajtmuGqT

## [0.2.1](https://github.com/cubicecho/graphql-mcp/compare/v0.2.0...v0.2.1) (2026-08-31)


### Bug Fixes

* attach the noExplicitAny suppression to the line it covers ([356a293](https://github.com/cubicecho/graphql-mcp/commit/356a293618548cade915c10b41037e881283978f))

# [0.2.0](https://github.com/cubicecho/graphql-mcp/compare/v0.1.1...v0.2.0) (2026-08-31)


### Bug Fixes

* advertise the real package version, not a hardcoded 0.1.0 ([92a4d04](https://github.com/cubicecho/graphql-mcp/commit/92a4d0440846ff6603560c7ef2b592d3d932f08d))
* drop empty error containers from the result envelope ([9090db7](https://github.com/cubicecho/graphql-mcp/commit/9090db7dca260fc903f75c8dd5768e6c4a7674c3))
* harden decorate merge and make empty include fail closed ([986cf88](https://github.com/cubicecho/graphql-mcp/commit/986cf88d11dc625dea6b73a263c07cc661df80dd))
* keep the JSON result contract when the executor throws ([6fe5285](https://github.com/cubicecho/graphql-mcp/commit/6fe52856dfbec367c26f2583e5bb271781585dc3))
* mark deprecated fields in the graphql_introspect overview ([46168dc](https://github.com/cubicecho/graphql-mcp/commit/46168dcf6ec2f8c99312a5fe451e5f209afb4d73))
* model recursive GraphQL inputs with z.lazy instead of overflowing ([72b76e6](https://github.com/cubicecho/graphql-mcp/commit/72b76e680080bcccf24548c3735e1838eda23566))
* stop flagging partial GraphQL results as failed tool calls ([baf0349](https://github.com/cubicecho/graphql-mcp/commit/baf0349667d07e6462b315b0f3bb271edc7acc27))


### Features

* add createFetchHandler for Request/Response runtimes ([92a360b](https://github.com/cubicecho/graphql-mcp/commit/92a360b57f402c8f49da53a3265d2fa19de6a67c))
* add opt-in stateful sessions to createHttpHandler ([1c0fdab](https://github.com/cubicecho/graphql-mcp/commit/1c0fdab2fe0298e970e2a173679b2245e1bf5186))
* add rule filtering, schema extensions, and tool decoration ([1e7dece](https://github.com/cubicecho/graphql-mcp/commit/1e7dece4e569a5e0ff3ea8d5c82ad470f1e3c4ee))
* add scalar mapping, meta tools, and types-only schemas ([b832733](https://github.com/cubicecho/graphql-mcp/commit/b832733f816a3f4131d44ac3430c2101397c604b))
* derive a result schema for each tool from its return type ([8757469](https://github.com/cubicecho/graphql-mcp/commit/87574699e220cac74e99d03fde5675e15c9d0a25))
* export the result helpers so custom tools share the envelope ([e5ff75a](https://github.com/cubicecho/graphql-mcp/commit/e5ff75adaabe485ada183a57a2343a86742a25fa))
* name the paging argument when a result is truncated ([d51f22f](https://github.com/cubicecho/graphql-mcp/commit/d51f22facd23f76bb216f39a7a21d5e68bddc1ec))
* state each tool's returned selection in its description ([b131500](https://github.com/cubicecho/graphql-mcp/commit/b13150023ff757c3ba3a030b7618366be19fa33c))
* surface deprecations, argument defaults, and scalar docs to agents ([3d8b527](https://github.com/cubicecho/graphql-mcp/commit/3d8b5275c11ebeee05ec03eff4ffafd194ca0a43))

## [0.1.1](https://github.com/cubicecho/graphql-mcp/compare/v0.1.0...v0.1.1) (2026-06-26)


### Bug Fixes

* align node floor with docs and bump CI to newest node ([c4c502f](https://github.com/cubicecho/graphql-mcp/commit/c4c502f0e36a2ac13b61367d9f71d70a6344b9bb))
* repair package publish metadata and release pipeline ([d1b1ea8](https://github.com/cubicecho/graphql-mcp/commit/d1b1ea8d1fbb444be3c23da3fedfa6e0613d211e))
