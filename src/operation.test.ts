import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { buildOperation } from './operation.ts';

function field(sdl: string, root: 'Query' | 'Mutation', name: string) {
  const schema = buildSchema(sdl);
  const type = (root === 'Query' ? schema.getQueryType() : schema.getMutationType()) as
    | GraphQLObjectType
    | undefined;
  if (!type) throw new Error('missing root type');
  return type.getFields()[name];
}

describe('buildOperation', () => {
  test('wraps a mutation with variable definitions and a selection set', () => {
    const f = field(
      `input In { a: String! } type T { id: String } type Mutation { make(input: In!): T }
       type Query { _: String }`,
      'Mutation',
      'make',
    );
    const op = buildOperation('mutation', f);
    assert.equal(op.operationName, 'make');
    assert.deepEqual(op.argNames, ['input']);
    assert.equal(
      op.query,
      'mutation make($input: In!) {\n  make(input: $input) { id __typename }\n}',
    );
  });

  test('argument-less scalar query has no var block and no selection set', () => {
    const f = field(`type Query { ping: String }`, 'Query', 'ping');
    const op = buildOperation('query', f);
    assert.deepEqual(op.argNames, []);
    assert.equal(op.query, 'query ping {\n  ping\n}');
  });

  test('preserves the full GraphQL type SDL in variable definitions', () => {
    const f = field(`type Query { search(tags: [String!]): String }`, 'Query', 'search');
    const op = buildOperation('query', f);
    assert.match(op.query, /\$tags: \[String!\]/);
    assert.match(op.query, /search\(tags: \$tags\)/);
  });
});
