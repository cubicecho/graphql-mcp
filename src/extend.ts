/**
 * MCP-only schema additions: merge extension SDL (+ resolvers) into a schema
 * before tool generation, so you can expose fields to agents that don't exist
 * on your public GraphQL API (usage guides, aggregate helpers, …).
 *
 * Built on `mergeSchemas` from `@graphql-tools/schema`: the base schema's type
 * definitions, resolvers, and extensions (including `field.extensions.mcp`
 * metadata) are extracted and rebuilt into one plain executable schema together
 * with the extension — no delegation layer, extension resolvers behave like any
 * graphql-js resolver.
 */

import { type IExecutableSchemaDefinition, mergeSchemas } from '@graphql-tools/schema';
import type { GraphQLSchema } from 'graphql';

/** MCP-only additions merged into the schema before tool generation. */
export interface SchemaExtension {
  /** Extension SDL (`extend type Query { … }`, new types/inputs). */
  typeDefs: string | string[];
  /**
   * Resolvers for the added fields, in graphql-tools shape:
   * `{ Query: { field: fn } }`. Optional — `buildSchema` + `rootValue` setups
   * resolve added root fields through the default resolver instead.
   */
  // biome-ignore lint/suspicious/noExplicitAny: resolver source/context types are the caller's business
  resolvers?: IExecutableSchemaDefinition<any>['resolvers'];
}

/**
 * Merges `extension` into `schema`, returning a new executable schema whose
 * extra fields become tools like any other root field.
 *
 * The extended schema must also be where tools *execute*: `createServerFactory`
 * feeds it to the default local executor, but a custom `executor` (e.g.
 * `createHttpExecutor` forwarding to a remote endpoint) won't know the extended
 * fields — keep MCP-only fields on the local path.
 *
 * @param schema - The base schema.
 * @param extension - Extension SDL and (optionally) its resolvers.
 * @returns The merged schema.
 */
export function extendSchemaForMcp(
  schema: GraphQLSchema,
  extension: SchemaExtension,
): GraphQLSchema {
  return mergeSchemas({
    schemas: [schema],
    typeDefs: extension.typeDefs,
    resolvers: extension.resolvers,
  });
}
