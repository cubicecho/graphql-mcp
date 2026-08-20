import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { z } from 'zod';
import { argsToZodShape, type ZodShapeOptions } from './zodSchema.ts';

const schema = buildSchema(/* GraphQL */ `
  input Filter { tag: String, limit: Int }
  enum Color { RED GREEN }
  scalar JSON
  type Query {
    search(
      "the term"
      term: String!
      limit: Int
      tags: [String!]
      filter: Filter
      color: Color
      meta: JSON
    ): String
  }
`);

function searchArgs(options?: ZodShapeOptions) {
  const field = (schema.getQueryType() as GraphQLObjectType).getFields().search;
  return argsToZodShape(field.args, options);
}

describe('argsToZodShape', () => {
  test('non-null args are required, nullable args are optional', () => {
    const shape = searchArgs();
    // required: parsing an object without `term` fails
    assert.throws(() => shape.term.parse(undefined));
    assert.equal(shape.term.parse('hi'), 'hi');
    // optional: undefined is accepted for a nullable arg
    assert.equal(shape.limit.parse(undefined), undefined);
    assert.equal(shape.limit.parse(3), 3);
  });

  test('scalars map to the right primitive', () => {
    const shape = searchArgs();
    assert.equal(shape.term.parse('x'), 'x');
    assert.throws(() => shape.limit.parse(1.5)); // Int rejects floats
  });

  test('lists become arrays of the element type', () => {
    const shape = searchArgs();
    assert.deepEqual(shape.tags.parse(['a', 'b']), ['a', 'b']);
    assert.throws(() => shape.tags.parse([1]));
  });

  test('input objects become nested object schemas', () => {
    const shape = searchArgs();
    assert.deepEqual(shape.filter.parse({ tag: 't', limit: 2 }), { tag: 't', limit: 2 });
  });

  test('enums accept their member names only', () => {
    const shape = searchArgs();
    assert.equal(shape.color.parse('RED'), 'RED');
    assert.throws(() => shape.color.parse('BLUE'));
  });

  test('custom scalars fall back to any (server still validates)', () => {
    const shape = searchArgs();
    assert.deepEqual(shape.meta.parse({ anything: true }), { anything: true });
  });

  test('arg descriptions are carried onto the schema', () => {
    const shape = searchArgs();
    assert.equal(shape.term.description, 'the term');
  });
});

describe('argsToZodShape scalar mapping', () => {
  test('a record maps a custom scalar instead of falling back to any', () => {
    const shape = searchArgs({ scalars: { JSON: z.record(z.string(), z.number()) } });
    assert.deepEqual(shape.meta.parse({ a: 1 }), { a: 1 });
    assert.throws(() => shape.meta.parse({ a: 'not a number' }));
    // Still nullable — the mapping supplies the base type, we wrap it.
    assert.equal(shape.meta.parse(undefined), undefined);
  });

  test('a resolver function is consulted, and undefined falls through', () => {
    const shape = searchArgs({
      scalars: (scalar) => (scalar.name === 'JSON' ? z.string() : undefined),
    });
    assert.equal(shape.meta.parse('raw'), 'raw');
    assert.throws(() => shape.meta.parse({}));
    // `String` fell through to the built-in mapping.
    assert.equal(shape.term.parse('hi'), 'hi');
  });

  test('the mapping wins over the built-in scalars', () => {
    const shape = searchArgs({ scalars: { String: z.string().email() } });
    assert.equal(shape.term.parse('a@b.com'), 'a@b.com');
    assert.throws(() => shape.term.parse('not-an-email'));
  });

  test('a mapped scalar is wrapped by list and input-object structure', () => {
    const shape = searchArgs({ scalars: { String: z.string().min(2) } });
    // list element
    assert.deepEqual(shape.tags.parse(['ab']), ['ab']);
    assert.throws(() => shape.tags.parse(['a']));
    // nested input-object field
    assert.deepEqual(shape.filter.parse({ tag: 'ab' }), { tag: 'ab' });
    assert.throws(() => shape.filter.parse({ tag: 'a' }));
  });

  test('an unmapped custom scalar still falls back to any', () => {
    const shape = searchArgs({ scalars: { Other: z.string() } });
    assert.deepEqual(shape.meta.parse({ anything: true }), { anything: true });
  });
});
