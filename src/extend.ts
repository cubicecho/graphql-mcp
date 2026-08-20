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
import { GraphQLSchema, isIntrospectionType, isSpecifiedScalarType } from 'graphql';

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
  /**
   * Drop the base schema's `Query`/`Mutation`/`Subscription` types before
   * merging ({@link stripRootTypes}), keeping every other type. Use it to define
   * a **tool-specific** operation surface in `typeDefs` while reusing the real
   * schema's objects, inputs, enums, and custom scalars — instead of listing the
   * fields you don't want via `exclude`.
   *
   * With this on, `typeDefs` must declare `type Query { … }` outright (there is
   * no base `Query` left to `extend`), and `resolvers` must resolve every field
   * it declares — the base schema's resolvers went with its root types.
   */
  typesOnly?: boolean;
}

/**
 * Returns a schema containing every named type from `schema` **except** its
 * `Query`/`Mutation`/`Subscription` root types (introspection types and the
 * built-in scalars are left to graphql-js to re-derive). Custom scalar
 * behaviour, enum values, and field/type extensions are preserved.
 *
 * The result has no root operation type and so is not independently valid — it
 * is a type library meant to be merged with an operation surface, which is what
 * `extend.typesOnly` does.
 *
 * @param schema - The schema to take types from.
 * @returns A schema holding only the non-root types.
 */
export function stripRootTypes(schema: GraphQLSchema): GraphQLSchema {
  const rootNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((type) => type != null)
      .map((type) => type.name),
  );
  const types = Object.values(schema.getTypeMap()).filter(
    (type) =>
      !rootNames.has(type.name) && !isIntrospectionType(type) && !isSpecifiedScalarType(type),
  );
  return new GraphQLSchema({ types, directives: schema.getDirectives() });
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
 * @throws If `typesOnly` is set but the result has no `Query` type — with the
 *   base root types dropped, `typeDefs` has to declare the operation surface.
 */
export function extendSchemaForMcp(
  schema: GraphQLSchema,
  extension: SchemaExtension,
): GraphQLSchema {
  const base = extension.typesOnly ? stripRootTypes(schema) : schema;
  const merged = mergeSchemas({
    schemas: [base],
    typeDefs: extension.typeDefs,
    resolvers: extension.resolvers,
  });
  if (extension.typesOnly && !merged.getQueryType()) {
    throw new Error(
      'graphql-mcp: `extend.typesOnly` dropped the base root types, so `extend.typeDefs` must ' +
        'declare its own `type Query { … }` (use `type`, not `extend type`).',
    );
  }
  return merged;
}
