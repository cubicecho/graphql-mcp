import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLArgument, type GraphQLObjectType } from 'graphql';
import { buildArgExample, exampleForType, MAX_EXAMPLE_CHARS } from './argExample.ts';

const schema = buildSchema(/* GraphQL */ `
  enum Direction {
    ASC
    DESC
  }
  scalar DateTime
  input StringFilter {
    eq: String
    contains: String
  }
  input OrderByField {
    direction: Direction!
    priority: Int!
  }
  input TaskOrderBy {
    startedAt: OrderByField
    name: OrderByField
  }
  input TaskFilters {
    name: StringFilter
    OR: [TaskFilters!]
    NOT: TaskFilters
  }
  input TaskInput {
    name: String!
    done: Boolean!
    ratio: Float!
    id: ID!
    due: DateTime!
    tags: [String!]!
  }
  input Defaults {
    limit: Int! = 25
    dir: Direction! = DESC
  }
  input SelfNonNull {
    self: SelfNonNull!
    name: String!
  }
  input Empty {
    _unused: String
  }
  input Narrow {
    a: StringFilter!
  }
  input Wide {
    a: StringFilter!
    b: StringFilter!
    c: StringFilter!
    d: StringFilter!
    e: StringFilter!
    f: StringFilter!
    g: StringFilter!
    h: StringFilter!
    i: StringFilter!
    j: StringFilter!
    k: StringFilter!
    l: StringFilter!
    m: StringFilter!
    n: StringFilter!
    o: StringFilter!
    p: StringFilter!
    q: StringFilter!
    r: StringFilter!
    s: StringFilter!
    t: StringFilter!
  }
  type Task {
    id: ID!
  }
  type Query {
    filtered(where: TaskFilters, orderBy: [TaskOrderBy!], limit: Int, when: DateTime): [Task!]!
    created(input: TaskInput!, defaults: Defaults, cyclic: SelfNonNull, wide: Wide, narrow: Narrow): Task
    prefilled(where: TaskFilters = { name: { eq: "x" } }, tags: [String!] = ["a"]): Task
  }
`);

const args = (fieldName: string): Map<string, GraphQLArgument> =>
  new Map(
    (schema.getQueryType() as GraphQLObjectType)
      .getFields()
      [fieldName].args.map((arg) => [arg.name, arg]),
  );

const inputType = (name: string) => schema.getType(name) as never;

describe('buildArgExample', () => {
  test('shows every required field of an input object', () => {
    assert.equal(
      buildArgExample(args('created').get('input') as GraphQLArgument),
      '{"name":"string","done":true,"ratio":0,"id":"string","due":"<DateTime>","tags":["string"]}',
    );
  });

  test('an all-optional object still shows its first field', () => {
    // A required-only rule renders `{}` here, which teaches nothing — and this
    // is exactly the shape that caused the measured failures: an optional outer
    // object wrapping a required inner one.
    assert.equal(
      buildArgExample(args('filtered').get('where') as GraphQLArgument),
      '{"name":{"eq":"string"}}',
    );
  });

  test('a list renders one element, and an enum renders a member name', () => {
    // `"desc"` is what a model writes when it pattern-matches the field name.
    // The member's spelling is the whole point of showing one.
    assert.equal(
      buildArgExample(args('filtered').get('orderBy') as GraphQLArgument),
      '[{"startedAt":{"direction":"ASC","priority":0}}]',
    );
  });

  test("a field's own default is preferred over a placeholder", () => {
    // Accurate, and the enum default arrives as its SDL name rather than
    // whatever internal value the schema happens to bind to it.
    assert.equal(
      buildArgExample(args('created').get('defaults') as GraphQLArgument),
      '{"limit":25,"dir":"DESC"}',
    );
  });

  test('an optional cycle drops the field rather than the example', () => {
    // TaskFilters.OR/NOT refer back to TaskFilters. The `name` branch is still
    // worth printing.
    const example = buildArgExample(args('filtered').get('where') as GraphQLArgument);
    assert.equal(example, '{"name":{"eq":"string"}}');
  });

  test('a required cycle abandons the whole example', () => {
    // `SelfNonNull.self` has no finite literal, so any example omits a required
    // field — valid-looking JSON the server rejects, which is the failure this
    // module exists to remove rather than relocate.
    assert.equal(buildArgExample(args('created').get('cyclic') as GraphQLArgument), undefined);
  });

  test('depth bounds optional expansion only', () => {
    const where = args('filtered').get('where') as GraphQLArgument;
    // `where` is optional all the way down, so one level of budget reaches
    // `name` but cannot look inside it — and `{"name":{}}` names a key while
    // showing nothing, so the example is dropped rather than half-built.
    assert.equal(buildArgExample(where, 2), '{"name":{"eq":"string"}}');
    assert.equal(buildArgExample(where, 1), undefined);
    // Required fields are unaffected by the budget: this one is three deep.
    assert.equal(
      buildArgExample(args('created').get('input') as GraphQLArgument, 1),
      '{"name":"string","done":true,"ratio":0,"id":"string","due":"<DateTime>","tags":["string"]}',
    );
  });

  test('depth 0 turns the example off', () => {
    assert.equal(buildArgExample(args('filtered').get('where') as GraphQLArgument, 0), undefined);
  });

  test('a scalar or enum argument gets no example', () => {
    // The argument line already carries `\`limit\`: \`Int\``; a bare `0` under it
    // is noise.
    assert.equal(buildArgExample(args('filtered').get('limit') as GraphQLArgument), undefined);
    assert.equal(buildArgExample(args('filtered').get('when') as GraphQLArgument), undefined);
  });

  test('an argument with an object or list default gets no example', () => {
    // The description prints that default as a GraphQL literal one line up, and
    // two literals in two syntaxes read as one.
    const prefilled = args('prefilled');
    assert.equal(buildArgExample(prefilled.get('where') as GraphQLArgument), undefined);
    assert.equal(buildArgExample(prefilled.get('tags') as GraphQLArgument), undefined);
  });

  test('an example that outgrows the budget is dropped, not truncated', () => {
    const created = args('created');
    assert.equal(buildArgExample(created.get('wide') as GraphQLArgument), undefined);
    // The same shape renders fine narrower, so it is the length that
    // disqualified it and not a rendering failure.
    const narrow = buildArgExample(created.get('narrow') as GraphQLArgument);
    assert.equal(narrow, '{"a":{"eq":"string"}}');
    assert.ok((narrow as string).length < MAX_EXAMPLE_CHARS);
  });
});

describe('exampleForType', () => {
  test('renders a named input type directly', () => {
    assert.equal(exampleForType(inputType('OrderByField')), '{"direction":"ASC","priority":0}');
  });

  test('an object with nothing worth showing renders nothing', () => {
    // `{}` is not an example; it is the absence of one.
    assert.equal(exampleForType(inputType('Empty'), 0), undefined);
  });

  test('a non-input type has no example', () => {
    assert.equal(exampleForType(inputType('Direction')), undefined);
  });
});
