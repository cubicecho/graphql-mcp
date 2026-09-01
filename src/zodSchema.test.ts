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

describe('argsToZodShape recursive inputs', () => {
  const recursiveSchema = buildSchema(/* GraphQL */ `
    input TreeNode {
      value: String!
      children: [TreeNode!]
    }
    input TreeFilter {
      node: TreeNode!
      depth: Int
    }
    type Query {
      find(filter: TreeFilter!): String
      mutual(a: A!): String
    }
    input A {
      b: B
      label: String!
    }
    input B {
      a: A
      count: Int!
    }
  `);

  function argsFor(fieldName: string) {
    const field = (recursiveSchema.getQueryType() as GraphQLObjectType).getFields()[fieldName];
    return argsToZodShape(field.args);
  }

  test('a self-referential input validates arbitrarily deep data', () => {
    const { filter } = argsFor('find');
    const value = {
      node: { value: 'a', children: [{ value: 'b', children: [{ value: 'c', children: [] }] }] },
      depth: 3,
    };
    assert.deepEqual(filter.parse(value), value);
  });

  test('the recursion is modelled, not opaque — nested nodes are still validated', () => {
    const { filter } = argsFor('find');
    // A child missing the required `value` must fail; `z.any()` would accept it.
    assert.throws(() => filter.parse({ node: { value: 'a', children: [{}] } }));
    assert.throws(() =>
      filter.parse({ node: { value: 'a', children: [{ value: 'b', children: [{ value: 1 }] }] } }),
    );
  });

  test('an omitted nullable recursive field is allowed', () => {
    const { filter } = argsFor('find');
    assert.deepEqual(filter.parse({ node: { value: 'x' } }), { node: { value: 'x' } });
    const withNull = { node: { value: 'x', children: null } };
    assert.deepEqual(filter.parse(withNull), withNull);
  });

  test('mutually recursive inputs terminate and validate both directions', () => {
    const { a } = argsFor('mutual');
    const value = { label: 'root', b: { count: 1, a: { label: 'leaf' } } };
    assert.deepEqual(a.parse(value), value);
    // `count` is required on B, so a malformed nested B is still caught.
    assert.throws(() => a.parse({ label: 'root', b: { a: { label: 'leaf' } } }));
  });
});

describe('unmapped custom scalars', () => {
  const scalarSchema = buildSchema(/* GraphQL */ `
    "An ISO-8601 timestamp, e.g. 2026-08-30T12:00:00Z."
    scalar DateTime
    scalar Undocumented
    type Query {
      at(when: DateTime!, other: Undocumented!): String
    }
  `);

  function atArgs(options?: ZodShapeOptions) {
    const field = (scalarSchema.getQueryType() as GraphQLObjectType).getFields().at;
    return argsToZodShape(field.args, options);
  }

  // The SDL is where a custom scalar's wire format is documented; describing the
  // arg as nothing but the scalar's name leaves an agent guessing at it.
  test('the scalar description carries through, since it documents the format', () => {
    assert.equal(
      atArgs().when.description,
      'Custom scalar DateTime — An ISO-8601 timestamp, e.g. 2026-08-30T12:00:00Z.',
    );
  });

  test('an undocumented scalar falls back to its name alone', () => {
    assert.equal(atArgs().other.description, 'Custom scalar Undocumented');
  });

  test('an explicit scalars mapping still wins over the fallback', () => {
    const { when } = atArgs({ scalars: { DateTime: z.string().min(4) } });
    assert.equal(when.parse('2026-08-30'), '2026-08-30');
    assert.throws(() => when.parse('no'));
  });
});

describe('argsToZodShape shares repeated input types', () => {
  // Four tables filtering through one another, which is what a generated CRUD
  // schema looks like: a task filters by its runs, a run filters back by its
  // task. Every column filter is the same `StringFilter` type, over and over.
  const crud = buildSchema(/* GraphQL */ `
    input StringFilter {
      eq: String
      ne: String
      contains: String
      OR: [StringFilter!]
      AND: [StringFilter!]
    }
    input TaskFilters {
      id: StringFilter
      name: StringFilter
      runs: RunFilters
      triggers: TriggerFilters
      OR: [TaskFilters!]
      NOT: TaskFilters
    }
    input RunFilters {
      id: StringFilter
      status: StringFilter
      task: TaskFilters
      steps: StepFilters
      OR: [RunFilters!]
    }
    input StepFilters {
      id: StringFilter
      run: RunFilters
      task: TaskFilters
      OR: [StepFilters!]
    }
    input TriggerFilters {
      id: StringFilter
      task: TaskFilters
      OR: [TriggerFilters!]
    }
    type Query {
      tasks(where: TaskFilters): String
    }
  `);

  const whereShape = () => {
    const field = (crud.getQueryType() as GraphQLObjectType).getFields().tasks;
    return argsToZodShape(field.args);
  };

  test('a type met by several routes is one instance, not a copy per route', () => {
    const { where } = whereShape();
    const task = shapeOf(where);
    // `TaskFilters.id` and `RunFilters.id` are both `StringFilter`. Reached by
    // different routes they used to be rebuilt into distinct-but-identical
    // schemas, which the JSON Schema render then had to write out twice.
    const run = shapeOf(task.runs);
    assert.equal(unwrap(task.id), unwrap(run.id));
    // And the same holds for a type reached back through a longer cycle.
    const step = shapeOf(run.steps);
    assert.equal(unwrap(step.id), unwrap(task.id));
    assert.equal(unwrap(step.run), unwrap(task.runs));
  });

  test('sharing does not flatten the types — each still validates its own fields', () => {
    const { where } = whereShape();
    const value = {
      id: { eq: 'a' },
      runs: { status: { contains: 'ok' }, task: { name: { eq: 'b' } } },
    };
    assert.deepEqual(where.parse(value), value);
    // `RunFilters` has no `name`, and a shared-by-mistake schema would take it.
    assert.throws(() => where.parse({ runs: { id: 1 } }));
    assert.throws(() => where.parse({ id: { eq: 5 } }));
  });
});

/**
 * The schema behind a field's optional/lazy wrappers, so two references to one
 * input type can be compared by identity.
 *
 * Written against the runtime rather than a Zod version: this package's peer
 * range spans v3 and v4, whose internals differ, but both expose `unwrap()` on
 * the nullability wrappers and `schema` on a lazy node.
 */
function unwrap(schema: unknown): unknown {
  let current = schema as { unwrap?: () => unknown; schema?: unknown };
  for (let i = 0; i < 8; i++) {
    if (typeof current?.unwrap === 'function') current = current.unwrap() as typeof current;
    else if (current?.schema) current = current.schema as typeof current;
    else break;
  }
  return current;
}

/** The unwrapped object's field shape. */
function shapeOf(schema: unknown): Record<string, unknown> {
  return (unwrap(schema) as { shape: Record<string, unknown> }).shape;
}
