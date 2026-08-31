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
