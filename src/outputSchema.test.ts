import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLObjectType, type GraphQLOutputType } from 'graphql';
import { z } from 'zod';
import { createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';
import { buildOutputSchema } from './outputSchema.ts';
import { buildTools } from './tools.ts';

function fieldType(sdl: string, field: string): GraphQLOutputType {
  const schema = buildSchema(sdl);
  return (schema.getQueryType() as GraphQLObjectType).getFields()[field].type;
}

/** The object schema behind whatever list/nullable wrappers a field carries. */
function unwrap(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    if (current instanceof z.ZodNullable || current instanceof z.ZodOptional) {
      current = current.unwrap();
    } else if (current instanceof z.ZodArray) {
      current = current.element;
    } else {
      return current as z.ZodObject<z.ZodRawShape>;
    }
  }
}

describe('buildOutputSchema leaf types', () => {
  test('a scalar return type maps to that scalar, not an object', () => {
    const schema = buildOutputSchema(fieldType('type Query { name: String }', 'name'));
    assert.equal(schema.parse('hi'), 'hi');
    assert.equal(schema.parse(null), null);
    assert.throws(() => schema.parse(42));
  });

  test('a non-null scalar rejects null', () => {
    const schema = buildOutputSchema(fieldType('type Query { name: String! }', 'name'));
    assert.equal(schema.parse('hi'), 'hi');
    assert.throws(() => schema.parse(null));
  });

  test('an enum return type maps to the enum values', () => {
    const schema = buildOutputSchema(fieldType('enum S { A B } type Query { s: S! }', 's'));
    assert.equal(schema.parse('A'), 'A');
    assert.throws(() => schema.parse('C'));
  });

  test('an unmapped custom scalar falls back to a described any', () => {
    const schema = buildOutputSchema(fieldType('scalar JSON type Query { j: JSON! }', 'j'));
    assert.deepEqual(schema.parse({ any: 'thing' }), { any: 'thing' });
  });

  test('the scalars option retypes custom scalars on the output side', () => {
    const schema = buildOutputSchema(
      fieldType('scalar DateTime type Query { at: DateTime! }', 'at'),
      2,
      {
        DateTime: z.string(),
      },
    );
    assert.equal(schema.parse('2026-08-30'), '2026-08-30');
    assert.throws(() => schema.parse(123));
  });
});

describe('buildOutputSchema object types', () => {
  test('scalar leaves are typed and __typename is a literal', () => {
    const schema = buildOutputSchema(
      fieldType('type T { a: String b: Int! } type Query { t: T! }', 't'),
    );
    const shape = unwrap(schema).shape;
    assert.equal(shape.a.parse('hello'), 'hello');
    assert.equal(shape.b.parse(42), 42);
    assert.throws(() => shape.b.parse('nope'));
    assert.equal(shape.__typename.parse('T'), 'T');
    assert.throws(() => shape.__typename.parse('Other'));
  });

  test('list return types produce an array schema, not an object', () => {
    const sdl = 'type T { a: String! } type Query { ts: [T!]! }';
    const schema = buildOutputSchema(fieldType(sdl, 'ts'));
    assert.deepEqual(schema.parse([{ a: 'x', __typename: 'T' }]), [{ a: 'x', __typename: 'T' }]);
    assert.throws(() => schema.parse({ a: 'x', __typename: 'T' }));
  });

  test('nullable fields accept null, non-null fields do not', () => {
    const sdl = 'type T { maybe: String required: String! } type Query { t: T! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 't'))).shape;
    assert.equal(shape.maybe.parse(null), null);
    assert.throws(() => shape.required.parse(null));
  });

  test('field descriptions are carried onto the schema', () => {
    const sdl = 'type T { "The id." id: String! } type Query { t: T! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 't'))).shape;
    assert.equal(shape.id.description, 'The id.');
  });

  test('nested objects are expanded up to maxDepth', () => {
    const sdl = 'type B { x: String! } type A { id: String! b: B! } type Query { a: A! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 'a'))).shape;
    assert.ok(shape.id);
    assert.ok(shape.b);
    assert.ok(unwrap(shape.b).shape.x);
  });

  test('depth 1 omits nested objects entirely, matching the selection set', () => {
    const sdl = 'type B { x: String! } type A { id: String! b: B! } type Query { a: A! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 'a'), 1)).shape;
    assert.ok(shape.id);
    assert.ok(shape.__typename);
    assert.equal(shape.b, undefined);
  });

  test('skips fields that require non-null arguments without defaults', () => {
    const sdl = 'type A { id: String! child(n: Int!): String } type Query { a: A! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 'a'))).shape;
    assert.ok(shape.id);
    assert.equal(shape.child, undefined);
  });

  test('cyclic types stop at the repeated type', () => {
    const sdl = 'type User { id: String! friends: [User!]! } type Query { user: User! }';
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 'user'), 10)).shape;
    assert.ok(shape.id);
    // `friends` expands once, and the User inside it drops its own `friends`.
    const friend = unwrap(shape.friends).shape;
    assert.ok(friend.id);
    assert.equal(friend.friends, undefined);
  });
});

describe('buildOutputSchema abstract types', () => {
  test('an interface contributes only its own fields', () => {
    const sdl = `
      interface Node { id: String! }
      type T implements Node { id: String! name: String! }
      type Query { n: Node! }
    `;
    const shape = unwrap(buildOutputSchema(fieldType(sdl, 'n'))).shape;
    assert.ok(shape.id);
    assert.equal(shape.name, undefined);
    // The concrete implementation's name comes back, so only a string is known.
    assert.equal(shape.__typename.parse('T'), 'T');
  });

  test('a union accepts any member shape', () => {
    const sdl = `
      type A { x: String! }
      type B { y: Int! }
      union R = A | B
      type Query { r: R! }
    `;
    const schema = buildOutputSchema(fieldType(sdl, 'r'));
    assert.deepEqual(schema.parse({ x: 'hi', __typename: 'A' }), { x: 'hi', __typename: 'A' });
    assert.deepEqual(schema.parse({ y: 1, __typename: 'B' }), { y: 1, __typename: 'B' });
    // `x` belongs to A, so claiming to be B with A's shape fails.
    assert.throws(() => schema.parse({ x: 'hi', __typename: 'B' }));
  });
});

describe('buildOutputSchema matches real results', () => {
  // The strongest guarantee: what a generated tool's operation actually returns
  // must validate against the descriptor's outputSchema.
  const cases = [
    { tool: 'todos', variables: {} },
    { tool: 'todo', variables: { id: 'todo-1' } },
    { tool: 'create_todo', variables: { input: { userId: 'user-1', description: 'new' } } },
  ];

  for (const { tool, variables } of cases) {
    test(`${tool} results validate against its outputSchema`, async () => {
      const { schema, root } = makeTodoSchema();
      const executor = createLocalExecutor(schema, { rootValue: root });
      const descriptor = buildTools(schema).find((t) => t.name === tool);
      assert.ok(descriptor);

      const result = await executor({
        query: descriptor.query,
        variables,
        operationName: descriptor.operationName,
      });
      assert.equal(result.errors, undefined);

      // Keyed by the GraphQL field name (`operationName`), not the tool name —
      // the two differ whenever `nameCase` rewrites the field name.
      const data = result.data as Record<string, unknown>;
      descriptor.outputSchema.parse(data[descriptor.operationName]);
    });
  }

  test('a null result validates for a nullable return type', async () => {
    const { schema, root } = makeTodoSchema();
    const executor = createLocalExecutor(schema, { rootValue: root });
    // `todo(id): Todo` is nullable, and the fixture returns null for a miss.
    const descriptor = buildTools(schema).find((t) => t.name === 'todo');
    assert.ok(descriptor);

    const result = await executor({
      query: descriptor.query,
      variables: { id: 'does-not-exist' },
      operationName: descriptor.operationName,
    });
    const data = result.data as Record<string, unknown>;
    assert.equal(data.todo, null);
    assert.equal(descriptor.outputSchema.parse(data.todo), null);
  });
});

describe('buildOutputSchema scalar descriptions', () => {
  // Input and output sides share `builtinScalar`, so a scalar reads the same
  // whichever direction it appears in.
  test('an unmapped scalar carries its SDL description on the output side too', () => {
    const sdl = '"An ISO-8601 timestamp." scalar DateTime type Query { at: DateTime! }';
    const schema = buildOutputSchema(fieldType(sdl, 'at'));
    assert.equal(schema.description, 'Custom scalar DateTime — An ISO-8601 timestamp.');
  });

  test('an undocumented scalar falls back to its name alone', () => {
    const schema = buildOutputSchema(fieldType('scalar Blob type Query { b: Blob! }', 'b'));
    assert.equal(schema.description, 'Custom scalar Blob');
  });
});
