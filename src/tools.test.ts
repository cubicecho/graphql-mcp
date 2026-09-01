import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { buildSchema, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { z } from 'zod';
import { makeTodoSchema, setMcpExtensions } from './fixtures.test.ts';
import { buildTools } from './tools.ts';

describe('buildTools', () => {
  test('creates one tool per query and mutation field', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema);
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.deepEqual([...byName.keys()].sort(), ['create_todo', 'set_completed', 'todo', 'todos']);
  });

  test('names tools in snake_case by default', () => {
    const schema = buildSchema(`
      type Query {
        getHTTPResponse: String
        already_snake: String
        userID: String
        me: String
      }
    `);
    assert.deepEqual(
      buildTools(schema)
        .map((t) => t.name)
        .sort(),
      ['already_snake', 'get_http_response', 'me', 'user_id'],
    );
  });

  test("nameCase: 'preserve' keeps the field name verbatim", () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { nameCase: 'preserve' });
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'createTodo',
      'setCompleted',
      'todo',
      'todos',
    ]);
  });

  test('the title and description keep the real field name', () => {
    const { schema } = makeTodoSchema();
    const createTodo = buildTools(schema).find((t) => t.name === 'create_todo');
    assert.equal(createTodo?.title, 'Create Todo');
    assert.match(createTodo?.description ?? '', /`createTodo`/);
    assert.match(createTodo?.query ?? '', /createTodo\(/);
  });

  test('toolName wins over nameCase and is not re-cased', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { toolName: (field) => `gqlDo_${field.name}` });
    assert.ok(tools.every((t) => t.name.startsWith('gqlDo_')));
  });

  test('two fields colliding under snake_case throw', () => {
    const schema = buildSchema(`
      type Query {
        myField: String
        my_field: String
      }
    `);
    assert.throws(() => buildTools(schema), /duplicate tool name 'my_field'/);
  });

  test('carries SDL descriptions, signature, and args into the description', () => {
    const { schema } = makeTodoSchema();
    const createTodo = buildTools(schema).find((t) => t.name === 'create_todo');
    assert.ok(createTodo);
    assert.match(createTodo.description, /Create a new todo for a user\./);
    assert.match(createTodo.description, /GraphQL mutation: `createTodo` → `Todo!`/);
    assert.match(createTodo.description, /- `input`: `CreateTodoInput!`/);
  });

  test('annotations mark queries read-only and mutations destructive', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema);
    const todo = tools.find((t) => t.name === 'todo');
    const createTodo = tools.find((t) => t.name === 'create_todo');
    assert.equal(todo?.annotations.readOnlyHint, true);
    assert.equal(todo?.annotations.destructiveHint, false);
    assert.equal(createTodo?.annotations.readOnlyHint, false);
    assert.equal(createTodo?.annotations.destructiveHint, true);
  });

  test('humanizes the title', () => {
    const { schema } = makeTodoSchema();
    const createTodo = buildTools(schema).find((t) => t.name === 'create_todo');
    assert.equal(createTodo?.title, 'Create Todo');
  });

  test('respects includeQueries / includeMutations', () => {
    const { schema } = makeTodoSchema();
    const onlyMutations = buildTools(schema, { includeQueries: false });
    assert.deepEqual(onlyMutations.map((t) => t.kind).sort(), ['mutation', 'mutation']);
  });

  test('filter and toolName options are applied', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      filter: (field) => field.name === 'todo',
      toolName: (field) => `q_${field.name}`,
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['q_todo'],
    );
  });

  test('throws on a tool-name collision', () => {
    const schema = buildSchema(`
      type Query { ping: String }
      type Mutation { ping: String }
    `);
    assert.throws(() => buildTools(schema), /duplicate tool name 'ping'/);
  });

  test('descriptors keep the document operation name when the tool is renamed', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { toolName: (field) => `q_${field.name}` });
    const todo = tools.find((t) => t.name === 'q_todo');
    assert.equal(todo?.operationName, 'todo');
    assert.match(todo?.query ?? '', /^query todo/);
  });
});

describe('buildTools include/exclude rules', () => {
  test('include keeps only matching fields', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { include: ['Query.*'] });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['todo', 'todos']);
  });

  test('exclude drops matching fields and wins over include', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { include: ['*'], exclude: ['set*', 'Query.todo'] });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['create_todo', 'todos']);
  });

  test('rules compose with the filter callback (all must pass)', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      include: ['todo*'],
      filter: (field) => field.name.endsWith('s'),
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['todos'],
    );
  });

  test('an invalid rule prefix throws at build time', () => {
    const { schema } = makeTodoSchema();
    assert.throws(() => buildTools(schema, { exclude: ['Subscription.x'] }), /invalid rule/);
  });
});

describe('buildTools extensions.mcp metadata', () => {
  test('hidden skips the field', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Mutation', 'setCompleted', { hidden: true });
    const names = buildTools(schema).map((t) => t.name);
    assert.ok(!names.includes('set_completed'));
    assert.equal(names.length, 3);
  });

  test('name renames the tool and wins over the toolName option', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { name: 'fetchTodo' });
    const tools = buildTools(schema, { toolName: (field) => `q_${field.name}` });
    const renamed = tools.find((t) => t.name === 'fetchTodo');
    assert.ok(renamed);
    assert.equal(renamed.operationName, 'todo');
    assert.ok(tools.find((t) => t.name === 'q_todos'));
  });

  test('title is reflected in the descriptor and annotations', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { title: 'Fetch One Todo' });
    const todo = buildTools(schema).find((t) => t.name === 'todo');
    assert.equal(todo?.title, 'Fetch One Todo');
    assert.equal(todo?.annotations.title, 'Fetch One Todo');
  });

  test('description replaces; appendDescription appends after a blank line', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { description: 'Replaced.' });
    setMcpExtensions(schema, 'Query', 'todos', { appendDescription: 'Prefer status filters.' });
    const tools = buildTools(schema);
    assert.equal(tools.find((t) => t.name === 'todo')?.description, 'Replaced.');
    const todos = tools.find((t) => t.name === 'todos');
    assert.match(todos?.description ?? '', /List every todo/);
    assert.match(todos?.description ?? '', /\n\nPrefer status filters\.$/);
  });

  test('annotations merge over the kind-derived defaults', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Mutation', 'setCompleted', {
      annotations: { destructiveHint: false, idempotentHint: true },
    });
    const tool = buildTools(schema).find((t) => t.name === 'set_completed');
    assert.equal(tool?.annotations.destructiveHint, false);
    assert.equal(tool?.annotations.idempotentHint, true);
    // Untouched defaults survive the merge.
    assert.equal(tool?.annotations.openWorldHint, true);
  });

  test('selectionDepth applies per field', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { selectionDepth: 1 });
    const tools = buildTools(schema);
    const shallow = tools.find((t) => t.name === 'todo');
    const deep = tools.find((t) => t.name === 'todos');
    // Depth 1 stops before the nested `createdBy` user object.
    assert.ok(!shallow?.query.includes('createdBy'));
    assert.ok(deep?.query.includes('createdBy'));
  });
});

describe('buildTools decorate', () => {
  test('a partial patch merges onto the descriptor', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      decorate: (descriptor, _field, kind) =>
        kind === 'mutation'
          ? { description: `${descriptor.description}\n\nAsk before writing.` }
          : undefined,
    });
    assert.match(
      tools.find((t) => t.name === 'create_todo')?.description ?? '',
      /Ask before writing\.$/,
    );
    assert.doesNotMatch(tools.find((t) => t.name === 'todo')?.description ?? '', /Ask before/);
  });

  test('decorate sees extensions-applied values and wins over them', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { name: 'fetchTodo', title: 'From Extensions' });
    let seenName = '';
    const tools = buildTools(schema, {
      decorate: (descriptor) => {
        if (descriptor.name !== 'fetchTodo') return;
        seenName = descriptor.name;
        return { title: 'From Decorate' };
      },
    });
    assert.equal(seenName, 'fetchTodo');
    assert.equal(tools.find((t) => t.name === 'fetchTodo')?.title, 'From Decorate');
  });

  test('a rename collision introduced by decorate throws', () => {
    const { schema } = makeTodoSchema();
    assert.throws(
      () => buildTools(schema, { decorate: () => ({ name: 'same' }) }),
      /duplicate tool name 'same'/,
    );
  });

  test('a patched title also updates annotations.title', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      decorate: (d) => (d.name === 'todo' ? { title: 'Patched Title' } : undefined),
    });
    const todo = tools.find((t) => t.name === 'todo');
    assert.equal(todo?.title, 'Patched Title');
    assert.equal(todo?.annotations.title, 'Patched Title');
  });

  test('patched annotations merge over the defaults', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      decorate: (d) =>
        d.kind === 'mutation' ? { annotations: { destructiveHint: false } } : undefined,
    });
    const createTodo = tools.find((t) => t.name === 'create_todo');
    assert.equal(createTodo?.annotations.destructiveHint, false);
    // Defaults the patch didn't mention survive.
    assert.equal(createTodo?.annotations.openWorldHint, true);
    assert.equal(createTodo?.annotations.title, 'Create Todo');
  });

  test('explicitly undefined patch keys never blank a field', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      decorate: () => ({ description: undefined, name: undefined, query: undefined }),
    });
    const todo = tools.find((t) => t.name === 'todo');
    assert.ok(todo);
    assert.match(todo.description, /Fetch a single todo by id\./);
    assert.match(todo.query, /^query todo/);
  });
});

describe('buildTools empty include', () => {
  test('an omitted include keeps every field', () => {
    const { schema } = makeTodoSchema();
    assert.equal(buildTools(schema, {}).length, 4);
  });

  test('a present but empty include exposes nothing (fails closed)', () => {
    const { schema } = makeTodoSchema();
    assert.deepEqual(buildTools(schema, { include: [] }), []);
  });
});

describe('buildTools outputSchema', () => {
  test('a list return type produces an array schema', () => {
    const { schema } = makeTodoSchema();
    const todos = buildTools(schema).find((t) => t.name === 'todos');
    assert.ok(todos);
    const todo = {
      id: '1',
      completed: false,
      description: 'd',
      createdBy: { id: 'u1', __typename: 'User' },
      __typename: 'Todo',
    };
    // `todos: [Todo!]!` — an array, so a bare object must not validate.
    assert.throws(() => todos.outputSchema.parse(todo));
    assert.deepEqual(todos.outputSchema.parse([todo]), [todo]);
  });

  test('a nullable object return type accepts null', () => {
    const { schema } = makeTodoSchema();
    const todo = buildTools(schema).find((t) => t.name === 'todo');
    assert.ok(todo);
    assert.equal(todo.outputSchema.parse(null), null);
  });

  test('selectionDepth drives the output schema too, so the two agree', () => {
    const { schema } = makeTodoSchema();
    const shallow = buildTools(schema, { selectionDepth: 1 }).find((t) => t.name === 'todo');
    const deep = buildTools(schema, { selectionDepth: 2 }).find((t) => t.name === 'todo');
    assert.ok(shallow);
    assert.ok(deep);
    // Depth 1 selects no nested objects, so `createdBy` is absent from both the
    // query and the schema; depth 2 selects it in both.
    assert.ok(!shallow.query.includes('createdBy'));
    assert.throws(() => shallow.outputSchema.parse({ __typename: 'Todo', createdBy: {} }));
    assert.ok(deep.query.includes('createdBy'));
    assert.deepEqual(
      deep.outputSchema.parse({
        id: '1',
        completed: false,
        description: 'd',
        createdBy: { id: 'u1', __typename: 'User' },
        __typename: 'Todo',
      }),
      {
        id: '1',
        completed: false,
        description: 'd',
        createdBy: { id: 'u1', __typename: 'User' },
        __typename: 'Todo',
      },
    );
  });

  test('a per-field selectionDepth extension applies to the output schema', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { selectionDepth: 1 });
    const todo = buildTools(schema).find((t) => t.name === 'todo');
    assert.ok(todo);
    assert.ok(!todo.query.includes('createdBy'));
    assert.throws(() => todo.outputSchema.parse({ __typename: 'Todo', createdBy: {} }));
  });
});

describe('buildTools deprecation', () => {
  const sdl = `
    type T { id: ID! }
    type Query {
      current: [T!]!
      old: [T!]! @deprecated(reason: "Use current instead.")
    }
    type Mutation {
      go(mode: String @deprecated(reason: "ignored since v2")): T!
    }
  `;

  test('a deprecated field says so, right under the summary', () => {
    const old = buildTools(buildSchema(sdl)).find((t) => t.name === 'old');
    assert.ok(old);
    assert.match(old.description, /DEPRECATED — Use current instead\./);
    // Loud enough to be seen before the signature, not buried at the end.
    assert.ok(
      old.description.indexOf('DEPRECATED') < old.description.indexOf('GraphQL query'),
      'the deprecation notice must precede the signature',
    );
  });

  test('a live field carries no deprecation notice', () => {
    const current = buildTools(buildSchema(sdl)).find((t) => t.name === 'current');
    assert.ok(current);
    assert.doesNotMatch(current.description, /DEPRECATED/);
  });

  test('deprecated fields are kept by default — they are still callable', () => {
    const names = buildTools(buildSchema(sdl)).map((t) => t.name);
    assert.ok(names.includes('old'));
  });

  test('includeDeprecated: false drops them entirely', () => {
    const names = buildTools(buildSchema(sdl), { includeDeprecated: false }).map((t) => t.name);
    assert.deepEqual(names.sort(), ['current', 'go']);
  });

  test('a deprecated argument is flagged on its own line', () => {
    const go = buildTools(buildSchema(sdl)).find((t) => t.name === 'go');
    assert.ok(go);
    assert.match(go.description, /`mode`: `String` \(deprecated: ignored since v2\)/);
  });
});

/**
 * Whether the installed zod exposes `.meta()`. The JSON Schema `default`
 * keyword rides on it, so it is a v4-only affordance — on v3 the prose in the
 * tool description is the only statement of a default, which is why every test
 * here checks the prose unconditionally and the keyword only when it can exist.
 */
const HAS_META = typeof (z.string() as { meta?: unknown }).meta === 'function';

/** The rendered JSON Schema properties for a single-field schema's only tool. */
function renderedArgs(sdl: string): Record<string, { default?: unknown }> {
  const tool = buildTools(buildSchema(sdl))[0];
  const rendered = toJsonSchemaCompat(z.object(tool.inputSchema)) as {
    properties: Record<string, { default?: unknown }>;
  };
  return rendered.properties;
}

describe('buildTools argument defaults', () => {
  const sdl = `
    enum Status { OPEN DONE }
    input Filter { tag: String }
    type T { id: ID! }
    type Query {
      list(
        status: Status = OPEN
        limit: Int = 10
        tags: [String!] = []
        filter: Filter = { tag: "x" }
        "The cursor to resume from."
        after: String
      ): [T!]!
    }
  `;
  const description = () => {
    const list = buildTools(buildSchema(sdl)).find((t) => t.name === 'list');
    assert.ok(list);
    return list.description;
  };

  test('scalar and enum defaults are shown as the literal a caller would write', () => {
    assert.match(description(), /`status`: `Status` \(omit for the default `OPEN`/);
    assert.match(description(), /`limit`: `Int` \(omit for the default `10`/);
  });

  test('list and object defaults are printed as GraphQL literals', () => {
    assert.match(description(), /`tags`: `\[String!\]` \(omit for the default `\[\]`/);
    assert.match(description(), /`filter`: `Filter` \(omit for the default `\{tag: "x"\}`/);
  });

  test('a nullable default says that an explicit null is not a request for it', () => {
    // GraphQL treats a passed `null` as null, not as "use the default". An agent
    // reading "default: 10" and sending null to mean "no preference" gets null.
    assert.match(
      description(),
      /`limit`: `Int` \(omit for the default `10`; an explicit `null` is sent as null\)/,
    );
  });

  test("nullBranches: 'never' drops the null caveat, since null can no longer be sent", () => {
    const list = buildTools(buildSchema(sdl), { nullBranches: 'never' }).find(
      (t) => t.name === 'list',
    );
    assert.match(list?.description ?? '', /`limit`: `Int` \(omit for the default `10`\)/);
    assert.doesNotMatch(list?.description ?? '', /explicit `null`/);
  });

  test('the default is advertised in the rendered JSON Schema, not just the prose', {
    skip: HAS_META ? false : 'zod 3 has no `.meta()`, so there is no metadata channel',
  }, () => {
    // Advisory metadata, not a Zod `.default()`: the keyword tells an agent what
    // it gets by omitting the argument, while the value stays absent on the wire
    // so GraphQL applies its own default rather than this package deciding it.
    const rendered = renderedArgs(sdl);
    assert.equal(rendered.limit?.default, 10);
    // An enum's default is its *name*, which is what crosses the wire as a
    // variable — not the internal value, which need not match it.
    assert.equal(rendered.status?.default, 'OPEN');
    assert.deepEqual(rendered.tags?.default, []);
    assert.deepEqual(rendered.filter?.default, { tag: 'x' });
    assert.equal('default' in (rendered.after ?? {}), false);
  });

  test('advertising the default does not inject it into the parsed arguments', () => {
    // The failure this guards against is silent: a `.default()` would put the
    // value into `variables`, so the server would receive an explicitly-passed
    // 10 and could never apply its own default — two sources of truth, and the
    // wrong one winning the moment the SDL changes.
    const list = buildTools(buildSchema(sdl)).find((t) => t.name === 'list');
    assert.ok(list);
    assert.deepEqual(z.object(list.inputSchema).parse({}), {});
  });

  test('an argument with no default gets no default note', () => {
    assert.match(description(), /`after`: `String` — The cursor to resume from\./);
  });

  test('a programmatic schema with no AST falls back to the coerced value', () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          list: {
            type: GraphQLString,
            args: { limit: { type: GraphQLInt, defaultValue: 25 } },
          },
        },
      }),
    });
    assert.match(buildTools(schema)[0].description, /`limit`: `Int` \(omit for the default `25`/);
    if (HAS_META) {
      const rendered = toJsonSchemaCompat(z.object(buildTools(schema)[0].inputSchema)) as {
        properties: Record<string, { default?: unknown }>;
      };
      assert.equal(rendered.properties.limit?.default, 25);
    }
  });
});

describe('buildTools pagination hints', () => {
  test('a paginated field carries a hint naming its arguments', () => {
    const schema = buildSchema(`
      type Query {
        feed(first: Int, after: String): [String!]!
      }
    `);
    const feed = buildTools(schema).find((t) => t.name === 'feed');
    assert.match(feed?.pageHint ?? '', /pass `first` to cap the page size, then `after`/);
  });

  test('a field with no paging arguments carries no hint', () => {
    const { schema } = makeTodoSchema();
    const todo = buildTools(schema).find((t) => t.name === 'todo');
    assert.equal(todo?.pageHint, undefined);
  });

  test('the hint survives decoration like any other descriptor key', () => {
    const schema = buildSchema('type Query { feed(limit: Int, offset: Int): [String!]! }');
    const [feed] = buildTools(schema, {
      decorate: () => ({ description: 'replaced' }),
    });
    assert.equal(feed.description, 'replaced');
    assert.match(feed.pageHint ?? '', /`limit`/);
  });
});
