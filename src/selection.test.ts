import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { buildSelectionSet } from './selection.ts';

function fieldType(sdl: string, field: string) {
  const schema = buildSchema(sdl);
  return (schema.getQueryType() as GraphQLObjectType).getFields()[field].type;
}

describe('buildSelectionSet', () => {
  test('scalar return types have no selection set', () => {
    const type = fieldType(`type Query { name: String }`, 'name');
    assert.equal(buildSelectionSet(type), '');
  });

  test('selects scalar leaves and always includes __typename', () => {
    const type = fieldType(`type T { a: String b: Int } type Query { t: T }`, 't');
    assert.equal(buildSelectionSet(type), '{ a b __typename }');
  });

  test('descends into nested objects up to maxDepth', () => {
    const sdl = `type B { x: String } type A { id: String b: B } type Query { a: A }`;
    const type = fieldType(sdl, 'a');
    assert.equal(buildSelectionSet(type, 2), '{ id b { x __typename } __typename }');
  });

  test('depth 1 omits nested objects entirely', () => {
    const sdl = `type B { x: String } type A { id: String b: B } type Query { a: A }`;
    const type = fieldType(sdl, 'a');
    assert.equal(buildSelectionSet(type, 1), '{ id __typename }');
  });

  test('skips fields that require arguments', () => {
    const sdl = `type A { id: String child(n: Int!): String } type Query { a: A }`;
    const type = fieldType(sdl, 'a');
    assert.equal(buildSelectionSet(type), '{ id __typename }');
  });

  test('guards against recursive types via the path', () => {
    // User -> todos: [Todo] -> createdBy: User would recurse forever.
    const sdl = `
      type User { id: String todos: [Todo!] }
      type Todo { id: String createdBy: User }
      type Query { user: User }
    `;
    const type = fieldType(sdl, 'user');
    // Under todos, `createdBy: User` would re-enter User; the cycle guard prunes
    // that whole field rather than recursing, so it never appears.
    const result = buildSelectionSet(type, 5);
    assert.equal(result, '{ id todos { id __typename } __typename }');
    assert.ok(!result.includes('createdBy'));
  });

  test('unwraps NonNull and List wrappers', () => {
    const sdl = `type T { a: String } type Query { ts: [T!]! }`;
    const type = fieldType(sdl, 'ts');
    assert.equal(buildSelectionSet(type), '{ a __typename }');
  });
});
