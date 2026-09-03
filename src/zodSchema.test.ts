import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
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

  test('an unknown field on an input object is rejected, not dropped', () => {
    const shape = searchArgs();
    // The advertised JSON Schema says `additionalProperties: false`; the parse
    // has to agree, and say which key was wrong.
    const result = shape.filter.safeParse({ tag: 't', taag: 'typo' });
    assert.equal(result.success, false);
    // Asserted on the issue, not the sentence: v3 says "Unrecognized key(s) in
    // object: 'taag'" and v4 says 'Unrecognized key: "taag"', but both carry the
    // same code and name the key, which is the part an agent needs.
    const issue = result.error?.issues[0] as { code?: string; keys?: string[] } | undefined;
    assert.equal(issue?.code, 'unrecognized_keys');
    assert.deepEqual(issue?.keys, ['taag']);
    // The keys the type does declare still parse, and survive intact.
    assert.deepEqual(shape.filter.parse({ tag: 't' }), { tag: 't' });
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

describe('nullBranches', () => {
  const listSchema = buildSchema(/* GraphQL */ `
    input Where { eq: String }
    type Query {
      rows(where: Where, tags: [String], ids: [String!]): String
    }
  `);
  const rowsArgs = (options?: ZodShapeOptions) =>
    argsToZodShape((listSchema.getQueryType() as GraphQLObjectType).getFields().rows.args, options);

  const render = (shape: Record<string, unknown>) =>
    JSON.stringify(toJsonSchemaCompat(z.object(shape as Parameters<typeof z.object>[0])));

  test('by default a nullable argument still accepts an explicit null', () => {
    // The default has to keep working: passing `null` to clear a field is a
    // real GraphQL idiom, and `'never'` trades it away deliberately.
    const args = searchArgs();
    assert.equal(z.object(args).safeParse({ term: 't', limit: null }).success, true);
  });

  test("'never' drops the null branch and rejects an explicit null", () => {
    const args = searchArgs({ nullBranches: 'never' });
    const parsed = z.object(args);
    // Absent is still fine — `required` is what carries that, which is the
    // whole argument for the branch being redundant.
    assert.equal(parsed.safeParse({ term: 't' }).success, true);
    assert.equal(parsed.safeParse({ term: 't', limit: null }).success, false);
  });

  test("'never' leaves no null branch in a schema with no nullable elements", () => {
    // `search` has `[String!]`, so every nullable position here is a property
    // and every one of them should lose its branch.
    assert.match(render(searchArgs()), /"null"/);
    assert.doesNotMatch(render(searchArgs({ nullBranches: 'never' })), /"null"/);
  });

  test('a nullable list element keeps its null branch under either setting', () => {
    // `[String]` permits a null *element*, and an element cannot be absent —
    // there is no hole in a JSON array — so dropping the branch there would
    // change the type rather than compress it.
    for (const nullBranches of ['always', 'never'] as const) {
      const args = rowsArgs({ nullBranches });
      assert.equal(
        z.object(args).safeParse({ tags: ['a', null] }).success,
        true,
        `nullBranches: '${nullBranches}' rejected a null element`,
      );
      assert.equal(z.object(args).safeParse({ ids: ['a', null] }).success, false);
    }
  });

  test("'never' removes the `$ref` sitting under a null wrapper", () => {
    // This is the shape with no legal draft-07 rendering: siblings of `$ref`
    // are ignored and strict validators reject them, so a consumer can neither
    // keep the combinator nor collapse it.
    const shared = buildSchema(/* GraphQL */ `
      input Filter { eq: String }
      type Query {
        rows(a: Filter, b: Filter, c: Filter): String
      }
    `);
    const argsOf = (options?: ZodShapeOptions) =>
      argsToZodShape((shared.getQueryType() as GraphQLObjectType).getFields().rows.args, options);

    const refUnderNull = (rendered: string) =>
      (rendered.match(/\{"anyOf":\[\{"\$ref":"[^"]+"\},\{"type":"null"\}\]\}/g) ?? []).length;

    assert.ok(refUnderNull(render(argsOf())) > 0, 'expected the default to produce the shape');
    assert.equal(refUnderNull(render(argsOf({ nullBranches: 'never' }))), 0);
  });

  test("'never' materially shrinks a filter-heavy schema", () => {
    // Optionality is stated twice today and the second statement is the
    // expensive one — on a filter-per-column schema it is most of the nodes.
    const cols = ['id', 'name', 'email', 'status', 'createdAt', 'updatedAt'];
    const wide = buildSchema(/* GraphQL */ `
      input StringFilter { eq: String ne: String lt: String gt: String like: String }
      input Where { ${cols.map((c) => `${c}: StringFilter`).join(' ')} }
      type Query { rows(where: Where): String }
    `);
    const argsOf = (options?: ZodShapeOptions) =>
      argsToZodShape((wide.getQueryType() as GraphQLObjectType).getFields().rows.args, options);

    const before = render(argsOf()).length;
    const after = render(argsOf({ nullBranches: 'never' })).length;
    assert.ok(after < before * 0.85, `expected a real cut, got ${before} → ${after}`);
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

describe('inputField', () => {
  // Two tables whose filters reference each other through relation filters —
  // the shape that made a real listing 92% `definitions`.
  const schema = buildSchema(/* GraphQL */ `
    input StringFilter {
      eq: String
      contains: String
    }
    input TriggerListRelationFilter {
      every: TriggerFilters
      some: TriggerFilters
    }
    input TriggerFilters {
      id: StringFilter
      tasks: TaskListRelationFilter
    }
    input TaskListRelationFilter {
      every: TaskFilters
      some: TaskFilters
    }
    input TaskFilters {
      id: StringFilter
      triggers: TriggerListRelationFilter
    }
    input RequiredWhere {
      id: StringFilter!
      name: StringFilter
    }
    type Query {
      tasks(where: TaskFilters): String
      strict(where: RequiredWhere): String
    }
  `);
  const argsOf = (fieldName: string, options?: ZodShapeOptions) =>
    argsToZodShape(
      (schema.getQueryType() as GraphQLObjectType).getFields()[fieldName].args,
      options,
    );
  const render = (shape: Record<string, unknown>) =>
    JSON.stringify(toJsonSchemaCompat(z.object(shape as Parameters<typeof z.object>[0])));

  const noRelations: ZodShapeOptions = {
    inputField: (field) => !/ListRelationFilter/.test(String(field.type)),
  };

  test('a pruned field is gone from the advertised schema', () => {
    const rendered = render(argsOf('tasks', noRelations));
    assert.doesNotMatch(rendered, /triggers/);
    // The field that carries the actual capability survives untouched.
    assert.match(rendered, /"eq"/);
  });

  test('nothing reached only through a pruned field survives in definitions', () => {
    // The point of pruning at the walk rather than after it: the type is never
    // visited, so it cannot be left behind as an orphan `definitions` entry
    // that costs bytes while nothing references it.
    const rendered = render(argsOf('tasks', noRelations));
    for (const orphan of [
      'TriggerListRelationFilter',
      'TaskListRelationFilter',
      'TriggerFilters',
    ]) {
      assert.doesNotMatch(rendered, new RegExp(orphan), `${orphan} survived the prune`);
    }
  });

  test('pruning the relation closure is most of the schema on this shape', () => {
    const before = render(argsOf('tasks')).length;
    const after = render(argsOf('tasks', noRelations)).length;
    assert.ok(after < before * 0.6, `expected a large cut, got ${before} → ${after}`);
  });

  test('pruning a non-null field throws rather than shipping a broken tool', () => {
    // The server still requires it, so the tool would be advertised as callable
    // and rejected on every call — a failure an agent cannot diagnose from the
    // tool it was given.
    assert.throws(
      () => argsOf('strict', { inputField: (field) => field.name !== 'id' }),
      /pruned `RequiredWhere.id`, which is non-null/,
    );
  });

  test('a nullable sibling of a non-null field still prunes', () => {
    const rendered = render(argsOf('strict', { inputField: (field) => field.name !== 'name' }));
    assert.doesNotMatch(rendered, /"name"/);
    assert.match(rendered, /"id"/);
  });

  test('the parent type is passed, so one type can be pruned and another spared', () => {
    // `StringFilter.contains` goes only where it is reached through TaskFilters.
    const rendered = render(
      argsOf('tasks', {
        inputField: (field, parent) => !(parent.name === 'StringFilter' && field.name === 'eq'),
      }),
    );
    assert.doesNotMatch(rendered, /"eq"/);
    assert.match(rendered, /"contains"/);
  });

  test('keeping every field is byte-identical to no callback at all', () => {
    assert.equal(render(argsOf('tasks', { inputField: () => true })), render(argsOf('tasks')));
  });

  test('pruning every field of a type leaves an empty object, not a crash', () => {
    // Degenerate but coherent: the argument survives and accepts `{}`. Better
    // than a throw, which would punish a broad predicate for a type the caller
    // may never have meant to reach.
    const rendered = render(
      argsOf('tasks', { inputField: (_field, parent) => parent.name !== 'StringFilter' }),
    );
    // Asserted as the empty shape rather than by name: `withName` is a no-op on
    // zod 3, so the type has no `definitions` entry to point at there.
    assert.match(rendered, /"properties":\{\}/);
    assert.doesNotMatch(rendered, /"eq"/);
  });
});

describe('nullBranches byType', () => {
  // A mutation taking both a filter and a patch: the case a per-field mode
  // cannot express, because both arguments sit on the same field.
  const schema = buildSchema(/* GraphQL */ `
    input StringFilter {
      eq: String
      contains: String
    }
    input TaskFilters {
      id: StringFilter
      name: StringFilter
    }
    input TaskUpdate {
      name: String
      notes: String
    }
    type Task {
      id: ID!
    }
    type Mutation {
      updateTask(where: TaskFilters, set: TaskUpdate, dryRun: Boolean): Task
    }
  `);
  const args = (schema.getType('Mutation') as GraphQLObjectType).getFields().updateTask.args;
  const render = (options?: ZodShapeOptions) =>
    JSON.stringify(
      toJsonSchemaCompat(z.object(argsToZodShape(args, options) as Parameters<typeof z.object>[0])),
    );
  /** The null branches surviving anywhere in the rendered schema. */
  const branches = (rendered: string) => (rendered.match(/"null"/g) ?? []).length;

  test('a filter family drops its branches while the patch keeps its own', () => {
    const rendered = render({
      nullBranches: { byType: (type) => (/Filter/.test(type.name) ? 'never' : 'always') },
    });
    // `where` is a `TaskFilters`, so the argument itself loses its branch too —
    // "wherever it appears" includes the top-level position, which is the one
    // rendering the `anyOf: [{$ref}, {type: 'null'}]` that has no legal draft-07
    // form. Keying by the *containing* type could never have reached it.
    assert.doesNotMatch(rendered, /"where":\{"anyOf"/);
    // `TaskUpdate` is untouched, so clearing a column still type-checks.
    assert.match(rendered, /"set":\{"anyOf"/);
  });

  test('the type in the position governs, not the type containing it', () => {
    // `TaskFilters.name` is a `StringFilter`, so sparing `TaskFilters` and
    // pruning `StringFilter` still drops the branch on that field.
    const rendered = render({
      nullBranches: { byType: (type) => (type.name === 'StringFilter' ? 'never' : 'always') },
    });
    assert.match(rendered, /"where":\{"anyOf"/);
    assert.doesNotMatch(rendered, /"name":\{"anyOf"/);
  });

  test('scalars and enums are governed too', () => {
    const all = render();
    const noScalars = render({
      nullBranches: { byType: (type) => (type.name === 'Boolean' ? 'never' : 'always') },
    });
    assert.match(all, /"dryRun":\{"type":\["boolean","null"\]/);
    assert.match(noScalars, /"dryRun":\{"type":"boolean"\}/);
  });

  test("'never' everywhere matches the plain string form exactly", () => {
    // The object form is a widening, not a second implementation.
    assert.equal(
      render({ nullBranches: { byType: () => 'never' } }),
      render({ nullBranches: 'never' }),
    );
    assert.equal(render({ nullBranches: { byType: () => 'always' } }), render());
  });

  test('the type keying is what makes the rendered body unambiguous', () => {
    // Every use of a named type resolves to the same mode, so a type cannot
    // render one way here and another way there — the property that keeps it
    // safe under a downstream `$defs` flatten, where the per-field callback is
    // not.
    const byType = render({
      nullBranches: { byType: (type) => (/Filter/.test(type.name) ? 'never' : 'always') },
    });
    assert.ok(branches(byType) < branches(render()), 'expected the filter branches to be gone');
    // The `$ref`-plus-null combinator — the shape with no legal draft-07 form —
    // is gone from every filter position. It survives on `set`, and that is the
    // trade being made rather than a leak: `TaskUpdate` was asked for `'always'`.
    assert.doesNotMatch(
      byType,
      /\{"\$ref":"[^"]*(?:TaskFilters|StringFilter)"\},\{"type":"null"\}/,
    );
  });

  test('a list of a governed type follows that type', () => {
    // The named type is what is asked about, so the wrapper does not change the
    // answer — but a nullable *element* is exempt either way, since an element
    // can be null and never absent.
    const listSchema = buildSchema(/* GraphQL */ `
      input F {
        eq: String
      }
      type Query {
        q(a: [F], b: [F]): String
      }
    `);
    const listArgs = (listSchema.getQueryType() as GraphQLObjectType).getFields().q.args;
    const rendered = JSON.stringify(
      toJsonSchemaCompat(
        z.object(
          argsToZodShape(listArgs, {
            nullBranches: { byType: () => 'never' },
          }) as Parameters<typeof z.object>[0],
        ),
      ),
    );
    assert.doesNotMatch(rendered, /"a":\{"anyOf"/);
    // The element keeps its branch: `[F]` permits a null element.
    assert.match(rendered, /"items":\{"anyOf"/);
  });
});
