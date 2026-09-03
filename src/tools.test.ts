import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { buildSchema, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { z } from 'zod';
import { makeTodoSchema, setMcpExtensions } from './fixtures.test.ts';
import { applyNameCase, buildTools } from './tools.ts';
import type { NullBranchesByType } from './zodSchema.ts';

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

  test('toolName returning undefined falls back to the default name', () => {
    // The point of the fallback: rename one field, leave the rest alone,
    // without the caller reimplementing `nameCase` for the pass-through.
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      toolName: (field) => (field.name === 'todo' ? 'fetch_one_todo' : undefined),
    });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('fetch_one_todo'));
    assert.ok(
      names.includes('create_todo'),
      `expected the default casing, got ${names.join(', ')}`,
    );
  });

  test('declining still respects nameCase, rather than the built-in default', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { nameCase: 'preserve', toolName: () => undefined });
    assert.ok(tools.map((t) => t.name).includes('createTodo'));
  });

  test('applyNameCase is the exported default a toolName callback can delegate to', () => {
    // A hand-rolled snake_case agrees with this one until an acronym run:
    // the naive `/[A-Z]/` replacement gives `parse_u_r_l_filter`.
    assert.equal(applyNameCase('parseURLFilter'), 'parse_url_filter');
    assert.equal(applyNameCase('createTodo'), 'create_todo');
    assert.equal(applyNameCase('createTodo', 'preserve'), 'createTodo');
    // Delegating reproduces the default exactly, transform included.
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      toolName: (field) => applyNameCase(field.name.replace(/Todo$/, 'TodoItem')),
    });
    assert.ok(tools.map((t) => t.name).includes('create_todo_item'));
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
    // `print` spaces an object literal differently across graphql majors —
    // `{tag: "x"}` on v16, `{ tag: "x" }` on v17. Both are the literal a caller
    // would write, which is all `defaultOf` promises, so the assertion tolerates
    // either rather than pinning prose to one major's printer.
    assert.match(description(), /`filter`: `Filter` \(omit for the default `\{ ?tag: "x" ?\}`/);
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

describe('buildTools per-field selection depth', () => {
  // A generated schema has nowhere to hang `extensions.mcp.selectionDepth`, so
  // one expensive field would otherwise force every other tool shallow.
  const sdl = `
    type Run { id: ID! output: String! task: Task! }
    type Trigger { id: ID! cron: String! task: Task! }
    type Task { id: ID! name: String! runs: [Run!]! triggers: [Trigger!]! }
    type Query { tasks: [Task!]! triggers: [Trigger!]! }
  `;
  const schema = buildSchema(sdl);

  const byName = (tools: ReturnType<typeof buildTools>) => new Map(tools.map((t) => [t.name, t]));

  test('a descriptor records the depth it was built at', () => {
    assert.equal(buildTools(schema)[0].selectionDepth, 2);
    assert.equal(buildTools(schema, { selectionDepth: 1 })[0].selectionDepth, 1);
  });

  test('a callback sets the depth per field', () => {
    const tools = byName(
      buildTools(schema, { selectionDepth: (field) => (field.name === 'tasks' ? 1 : 2) }),
    );

    const tasks = tools.get('tasks');
    const triggers = tools.get('triggers');
    assert.equal(tasks?.selectionDepth, 1);
    assert.equal(triggers?.selectionDepth, 2);
    // The shallow one stops at its own leaves; the deep one expands a level.
    assert.doesNotMatch(tasks?.query ?? '', /runs \{/);
    assert.match(triggers?.query ?? '', /task \{/);
  });

  test('the callback sees the field and its kind', () => {
    const seen: Array<[string, string]> = [];
    buildTools(schema, {
      selectionDepth: (field, kind) => {
        seen.push([field.name, kind]);
        return 1;
      },
    });
    assert.deepEqual(seen.sort(), [
      ['tasks', 'query'],
      ['triggers', 'query'],
    ]);
  });

  test('everything derived from the selection moves with it', () => {
    const shallow = byName(buildTools(schema, { selectionDepth: 1 })).get('tasks');
    const deep = byName(buildTools(schema, { selectionDepth: 2 })).get('tasks');
    const row = { id: '1', name: 'a', __typename: 'Task' };

    // The description shows the real selection, so an agent doesn't plan around
    // fields it won't receive...
    assert.doesNotMatch(shallow?.description ?? '', /runs/);
    assert.match(deep?.description ?? '', /runs/);
    // ...and the output schema describes the same rows the query asks for.
    assert.equal(shallow?.outputSchema.safeParse([row]).success, true);
    assert.equal(deep?.outputSchema.safeParse([row]).success, false);
  });

  test('extensions.mcp.selectionDepth still beats the option', () => {
    // A fresh schema: setMcpExtensions annotates the field in place.
    const annotated = buildSchema(sdl);
    setMcpExtensions(annotated, 'Query', 'tasks', { selectionDepth: 2 });
    const tools = byName(buildTools(annotated, { selectionDepth: 1 }));
    assert.equal(tools.get('tasks')?.selectionDepth, 2);
    assert.equal(tools.get('triggers')?.selectionDepth, 1);
  });

  test('decorate can set the depth, and the query is rebuilt for it', () => {
    const tools = byName(
      buildTools(schema, {
        selectionDepth: 1,
        decorate: (d) => (d.name === 'triggers' ? { selectionDepth: 2 } : undefined),
      }),
    );

    const triggers = tools.get('triggers');
    assert.equal(triggers?.selectionDepth, 2);
    assert.match(triggers?.query ?? '', /task \{/);
    assert.match(triggers?.description ?? '', /task \{/);
    assert.equal(
      triggers?.outputSchema.safeParse([{ id: '1', cron: '*', __typename: 'Trigger' }]).success,
      false,
    );
    // The undecorated neighbour is untouched.
    assert.equal(tools.get('tasks')?.selectionDepth, 1);
    assert.doesNotMatch(tools.get('tasks')?.query ?? '', /runs \{/);
  });

  test('a query in the same patch still wins over the rebuild', () => {
    const [tool] = buildTools(schema, {
      include: ['tasks'],
      selectionDepth: 1,
      decorate: () => ({ selectionDepth: 2, query: 'query tasks { tasks { id } }' }),
    });
    assert.equal(tool.query, 'query tasks { tasks { id } }');
    assert.equal(tool.selectionDepth, 2);
  });

  test('a decorate patch that repeats the current depth rebuilds nothing', () => {
    const plain = buildTools(schema, { selectionDepth: 1 })[0];
    const patched = buildTools(schema, {
      selectionDepth: 1,
      decorate: () => ({ selectionDepth: 1, title: 'Kept' }),
    })[0];
    assert.equal(patched.query, plain.query);
    assert.equal(patched.title, 'Kept');
  });
});

describe('buildTools argument shape examples', () => {
  // The shape an argument expects is already in `inputSchema`. That is the
  // problem being fixed: on a real surface the schema is hundreds of kilobytes
  // and a model reads the prose, so a non-obvious shape gets guessed from the
  // argument's name instead.
  const sdl = `
    enum Direction { ASC DESC }
    scalar DateTime
    input StringFilter { eq: String contains: String }
    input OrderByField { direction: Direction! priority: Int! }
    input TaskOrderBy { startedAt: OrderByField }
    input TaskFilters { name: StringFilter OR: [TaskFilters!] }
    input TaskInput { name: String! due: DateTime }
    type Task { id: ID! name: String! }
    type Query { tasks(where: TaskFilters, orderBy: [TaskOrderBy!], limit: Int = 50): [Task!]! }
    type Mutation { createTask(input: TaskInput!): Task }
  `;
  const schema = buildSchema(sdl);

  const byName = (tools: ReturnType<typeof buildTools>) => new Map(tools.map((t) => [t.name, t]));

  /** Every `shape:` line in a description, paired with the argument above it. */
  function examples(description: string): Array<[string, string]> {
    const lines = description.split('\n');
    const found: Array<[string, string]> = [];
    lines.forEach((line, index) => {
      const shape = /^ {2}shape: (.+)$/.exec(line);
      if (!shape) return;
      const arg = /^- `([^`]+)`/.exec(lines[index - 1] ?? '');
      assert.ok(arg, `a shape line with no argument above it: ${line}`);
      found.push([arg[1], shape[1]]);
    });
    return found;
  }

  test('an argument that takes an input object carries a JSON example', () => {
    const tasks = byName(buildTools(schema)).get('tasks');
    assert.match(
      tasks?.description ?? '',
      /Arguments \(`shape:` shows a minimal JSON example — required fields only\):/,
    );
    assert.deepEqual(examples(tasks?.description ?? ''), [
      ['where', '{"name":{"eq":"string"}}'],
      // The measured failure was `orderBy: { startedAt: "desc" }` against a type
      // that is really a nested object keyed by column — and `ASC`, not `"desc"`.
      ['orderBy', '[{"startedAt":{"direction":"ASC","priority":0}}]'],
    ]);
    // A scalar argument keeps its plain line; there is nothing to show.
    assert.match(tasks?.description ?? '', /- `limit`: `Int` \(omit for the default `50`/);
  });

  test('every rendered example validates against the tool it appears on', () => {
    // The assertion that turns "we print an example" into "we cannot print a
    // wrong one". An example is only useful if the server would accept it, and
    // parsing it against the tool's own advertised schema is the same check the
    // server makes — including the strictness that rejects an unknown key.
    let checked = 0;
    for (const tool of buildTools(schema)) {
      for (const [arg, json] of examples(tool.description)) {
        const parsed = tool.inputSchema[arg].safeParse(JSON.parse(json));
        assert.ok(parsed.success, `${tool.name}.${arg} rejects its own example: ${json}`);
        checked += 1;
      }
    }
    assert.equal(checked, 3);
  });

  test('exampleDepth 0 drops the examples and the caveat with them', () => {
    const tasks = byName(buildTools(schema, { exampleDepth: 0 })).get('tasks');
    assert.match(tasks?.description ?? '', /^Arguments:$/m);
    assert.deepEqual(examples(tasks?.description ?? ''), []);
  });

  test('a callback sets the depth per field', () => {
    const tools = byName(
      buildTools(schema, { exampleDepth: (field) => (field.name === 'tasks' ? 0 : 3) }),
    );
    assert.deepEqual(examples(tools.get('tasks')?.description ?? ''), []);
    assert.deepEqual(examples(tools.get('create_task')?.description ?? ''), [
      ['input', '{"name":"string"}'],
    ]);
  });

  test('extensions.mcp.exampleDepth beats the option', () => {
    const annotated = buildSchema(sdl);
    setMcpExtensions(annotated, 'Query', 'tasks', { exampleDepth: 0 });
    const tools = byName(buildTools(annotated, { exampleDepth: 3 }));
    assert.deepEqual(examples(tools.get('tasks')?.description ?? ''), []);
    assert.equal(examples(tools.get('create_task')?.description ?? '').length, 1);
  });

  test('nullBranches does not reach the examples', () => {
    // The renderer only ever emits fields it chose to include, so it never emits
    // a null — pinned here because a future change could couple them silently.
    const always = byName(buildTools(schema)).get('tasks');
    const never = byName(buildTools(schema, { nullBranches: 'never' })).get('tasks');
    assert.deepEqual(examples(always?.description ?? ''), examples(never?.description ?? ''));
  });

  test('a decorate patch replacing the description replaces the examples too', () => {
    // Deliberately unlike `selectionDepth`: an example affects the description
    // alone, so there is nothing to rebuild and no descriptor field to keep in
    // step — `decorate` already owns the whole string.
    const [tool] = buildTools(schema, {
      include: ['tasks'],
      decorate: () => ({ description: 'Mine.' }),
    });
    assert.equal(tool.description, 'Mine.');
  });
});

describe('buildTools per-field null branches', () => {
  // The trade splits by kind on a generated CRUD surface: a filter set to an
  // explicit null is a caller mistake, while a mutation uses one to clear a
  // column. A single mode makes that one decision for both.
  const sdl = `
    input TaskFilters { name: String status: String }
    input TaskInput { name: String status: String }
    type Owner { id: ID! name: String! }
    type Task { id: ID! name: String! owner: Owner! }
    type Query { tasks(where: TaskFilters, limit: Int = 10): [Task!]! }
    type Mutation { updateTask(where: TaskFilters!, values: TaskInput!): Task }
  `;
  const schema = buildSchema(sdl);

  const byName = (tools: ReturnType<typeof buildTools>) => new Map(tools.map((t) => [t.name, t]));
  const render = (tool?: ReturnType<typeof buildTools>[number]) =>
    JSON.stringify(toJsonSchemaCompat(z.object(tool?.inputSchema ?? {})));

  test('a descriptor records the setting it was built at', () => {
    assert.equal(buildTools(schema)[0].nullBranches, 'always');
    assert.equal(buildTools(schema, { nullBranches: 'never' })[0].nullBranches, 'never');
  });

  test('a callback sets the mode per kind', () => {
    const tools = byName(
      buildTools(schema, {
        nullBranches: (_field, kind) => (kind === 'query' ? 'never' : 'always'),
      }),
    );
    assert.equal(tools.get('tasks')?.nullBranches, 'never');
    assert.equal(tools.get('update_task')?.nullBranches, 'always');
    // Search the whole rendered schema: v4 hoists the input type into
    // `definitions` and leaves a `$ref`, so `properties` alone would miss it.
    assert.doesNotMatch(render(tools.get('tasks')), /"null"/);
    assert.match(render(tools.get('update_task')), /"null"/);
  });

  test('the callback sees the field and its kind', () => {
    const seen: Array<[string, string]> = [];
    buildTools(schema, {
      nullBranches: (field, kind) => {
        seen.push([field.name, kind]);
        return 'always';
      },
    });
    assert.deepEqual(seen.sort(), [
      ['tasks', 'query'],
      ['updateTask', 'mutation'],
    ]);
  });

  test('the prose moves with the schema', () => {
    // `null` advice that describes an impossible call is worse than none: under
    // `'never'` an explicit null is rejected outright. This is the guard that
    // the description and the input schema cannot be built at different modes.
    const always = byName(buildTools(schema)).get('tasks');
    const never = byName(buildTools(schema, { nullBranches: 'never' })).get('tasks');
    assert.match(always?.description ?? '', /an explicit `null` is sent as null/);
    assert.doesNotMatch(never?.description ?? '', /explicit `null`/);
    // The default itself is still advertised either way.
    assert.match(never?.description ?? '', /omit for the default `10`/);
  });

  test('extensions.mcp.nullBranches beats the option', () => {
    const annotated = buildSchema(sdl);
    setMcpExtensions(annotated, 'Query', 'tasks', { nullBranches: 'never' });
    const tools = byName(buildTools(annotated, { nullBranches: 'always' }));
    assert.equal(tools.get('tasks')?.nullBranches, 'never');
    assert.doesNotMatch(render(tools.get('tasks')), /"null"/);
    assert.equal(tools.get('update_task')?.nullBranches, 'always');
  });

  test('decorate can set the mode, and both artifacts are rebuilt for it', () => {
    const tools = byName(
      buildTools(schema, {
        decorate: (d) => (d.name === 'tasks' ? { nullBranches: 'never' } : undefined),
      }),
    );
    const tasks = tools.get('tasks');
    assert.equal(tasks?.nullBranches, 'never');
    assert.doesNotMatch(render(tasks), /"null"/);
    assert.doesNotMatch(tasks?.description ?? '', /explicit `null`/);
    // The undecorated neighbour keeps the default.
    assert.match(render(tools.get('update_task')), /"null"/);
  });

  test('a description in the same patch still wins over the rebuild', () => {
    const [tool] = buildTools(schema, {
      include: ['tasks'],
      decorate: () => ({ nullBranches: 'never', description: 'Mine.' }),
    });
    assert.equal(tool.description, 'Mine.');
    assert.equal(tool.nullBranches, 'never');
    assert.doesNotMatch(render(tool), /"null"/);
  });

  test('a patch that repeats the current mode rebuilds nothing', () => {
    const plain = buildTools(schema, { include: ['tasks'], nullBranches: 'never' })[0];
    const patched = buildTools(schema, {
      include: ['tasks'],
      nullBranches: 'never',
      decorate: () => ({ nullBranches: 'never', title: 'Kept' }),
    })[0];
    assert.equal(patched.query, plain.query);
    assert.equal(patched.description, plain.description);
    assert.equal(patched.title, 'Kept');
  });

  // The two rebuild triggers share one branch, so a patch naming one setting
  // must forward the other rather than the value it was originally built from.
  // Get this wrong and a tool's description describes a schema it no longer has.
  test('a patch changing only the depth keeps the null-branch mode', () => {
    const [tool] = buildTools(schema, {
      include: ['tasks'],
      nullBranches: 'never',
      decorate: () => ({ selectionDepth: 1 }),
    });
    assert.equal(tool.selectionDepth, 1);
    assert.doesNotMatch(tool.query, /owner \{/);
    assert.equal(tool.nullBranches, 'never');
    assert.doesNotMatch(render(tool), /"null"/);
    assert.doesNotMatch(tool.description, /explicit `null`/);
  });

  test('a patch changing only the null-branch mode keeps the depth', () => {
    const [tool] = buildTools(schema, {
      include: ['tasks'],
      selectionDepth: 1,
      decorate: () => ({ nullBranches: 'never' }),
    });
    assert.equal(tool.nullBranches, 'never');
    assert.doesNotMatch(render(tool), /"null"/);
    assert.equal(tool.selectionDepth, 1);
    assert.doesNotMatch(tool.query, /owner \{/);
    assert.doesNotMatch(tool.description, /owner \{/);
  });
});

describe('mutationHints', () => {
  const schema = buildSchema(`
    type Task { id: ID! name: String! }
    type Query { tasks: [Task!]! }
    type Mutation {
      createTask(name: String!): Task!
      addTag(id: ID!, tag: String!): Task!
      insert_task(name: String!): Task!
      deleteTask(id: ID!): Boolean!
      removeTag(id: ID!, tag: String!): Task!
      updateTask(id: ID!, name: String!): Task!
      runTask(id: ID!): Boolean!
      creationFor(id: ID!): Task!
      create: Task!
    }
  `);

  const hintsOf = (mutationHints?: 'uniform' | 'byName') => {
    const tools = buildTools(schema, mutationHints ? { mutationHints } : {});
    return new Map(
      tools.map((t) => [t.name, [t.annotations.destructiveHint, t.annotations.idempotentHint]]),
    );
  };

  test('every mutation is destructive by default', () => {
    const hints = hintsOf();
    for (const name of ['create_task', 'delete_task', 'update_task', 'run_task']) {
      assert.deepEqual(hints.get(name), [true, false], name);
    }
  });

  test("'byName' clears destructiveHint on the additive prefixes", () => {
    const hints = hintsOf('byName');
    for (const name of ['create_task', 'add_tag', 'insert_task', 'create']) {
      assert.deepEqual(hints.get(name), [false, false], name);
    }
  });

  test("'byName' marks the removing prefixes idempotent", () => {
    const hints = hintsOf('byName');
    for (const name of ['delete_task', 'remove_tag']) {
      assert.deepEqual(hints.get(name), [true, true], name);
    }
  });

  test("'byName' leaves an unconventional name at the conservative default", () => {
    const hints = hintsOf('byName');
    // `update` is already right without the convention, and nothing in a name
    // like `runTask` says which side of destructive it falls on.
    for (const name of ['update_task', 'run_task']) {
      assert.deepEqual(hints.get(name), [true, false], name);
    }
  });

  test('a prefix only matches on a word boundary', () => {
    assert.deepEqual(hintsOf('byName').get('creation_for'), [true, false]);
  });

  test("'byName' does not touch queries", () => {
    const tasks = buildTools(schema, { mutationHints: 'byName' }).find((t) => t.name === 'tasks');
    assert.equal(tasks?.annotations.readOnlyHint, true);
    assert.equal(tasks?.annotations.destructiveHint, false);
    assert.equal(tasks?.annotations.idempotentHint, true);
  });

  test('the prefix is read from the GraphQL field name, not the tool name', () => {
    // A renamed tool still describes the operation the field performs.
    const tools = buildTools(schema, {
      mutationHints: 'byName',
      toolName: (field) => (field.name === 'createTask' ? 'task_write' : field.name),
    });
    const renamed = tools.find((t) => t.name === 'task_write');
    assert.equal(renamed?.annotations.destructiveHint, false);
  });

  test('extensions and decorate still have the last word', () => {
    const annotated = buildSchema(`
      type Task { id: ID! }
      type Query { tasks: [Task!]! }
      type Mutation { createTask: Task!, deleteTask: Boolean! }
    `);
    setMcpExtensions(annotated, 'Mutation', 'createTask', {
      annotations: { destructiveHint: true },
    });
    const tools = new Map(
      buildTools(annotated, {
        mutationHints: 'byName',
        decorate: (d) =>
          d.name === 'delete_task' ? { annotations: { idempotentHint: false } } : undefined,
      }).map((t) => [t.name, t]),
    );
    assert.equal(tools.get('create_task')?.annotations.destructiveHint, true);
    assert.equal(tools.get('delete_task')?.annotations.idempotentHint, false);
    // The rest of the derived annotations survive the override.
    assert.equal(tools.get('delete_task')?.annotations.destructiveHint, true);
    assert.equal(tools.get('create_task')?.annotations.title, 'Create Task');
  });
});

describe('buildTools per-type null branches', () => {
  // The split a per-field mode cannot make: this mutation takes a filter *and*
  // a patch, so one decision has to serve both arguments.
  const sdl = `
    input TaskFilters { name: String status: String }
    input TaskInput { name: String notes: String }
    type Task { id: ID! name: String! }
    type Query { tasks(where: TaskFilters, limit: Int = 10): [Task!]! }
    type Mutation { updateTask(where: TaskFilters, set: TaskInput): Task }
  `;
  const schema = buildSchema(sdl);
  const byName = (tools: ReturnType<typeof buildTools>) => new Map(tools.map((t) => [t.name, t]));
  const render = (tool?: ReturnType<typeof buildTools>[number]) =>
    JSON.stringify(toJsonSchemaCompat(z.object(tool?.inputSchema ?? {})));
  const filtersOnly: NullBranchesByType = {
    byType: (type) => (type.name === 'TaskFilters' ? 'never' : 'always'),
  };

  test('one mutation drops the filter branch and keeps the patch branch', () => {
    const update = byName(buildTools(schema, { nullBranches: filtersOnly })).get('update_task');
    const rendered = render(update);
    assert.doesNotMatch(rendered, /"where":\{"anyOf"/);
    // `set: TaskInput` still takes an explicit null, which is how a column is
    // cleared — the whole reason `'never'` is not simply the default.
    assert.match(rendered, /"set":\{"anyOf"/);
  });

  test('the same type renders the same way in every tool it appears in', () => {
    // What the per-field callback cannot promise, and what makes this form safe
    // to flatten into one downstream `$defs` namespace.
    const tools = byName(buildTools(schema, { nullBranches: filtersOnly }));
    for (const name of ['tasks', 'update_task']) {
      assert.doesNotMatch(render(tools.get(name)), /"where":\{"anyOf"/, `${name} disagreed`);
    }
  });

  test('the prose follows per argument, not per tool', () => {
    // `describeArgument` resolves the same setting the schema was built from,
    // so an argument whose branch is gone stops being advertised as taking one.
    const [tasks] = buildTools(schema, {
      include: ['tasks'],
      nullBranches: { byType: (type) => (type.name === 'Int' ? 'never' : 'always') },
    });
    // `limit: Int = 10` is the argument carrying the null caveat.
    assert.match(tasks.description, /omit for the default `10`/);
    assert.doesNotMatch(tasks.description, /explicit `null`/);
  });

  test('the descriptor records the object it was built at', () => {
    const [tasks] = buildTools(schema, { include: ['tasks'], nullBranches: filtersOnly });
    assert.equal(tasks.nullBranches, filtersOnly);
  });

  test('a per-field callback may return a per-type setting', () => {
    // How the two compose: pick a policy by kind, then let the policy pick by
    // type.
    const tools = byName(
      buildTools(schema, {
        nullBranches: (_field, kind) => (kind === 'query' ? 'never' : filtersOnly),
      }),
    );
    assert.doesNotMatch(render(tools.get('tasks')), /"null"/);
    assert.doesNotMatch(render(tools.get('update_task')), /"where":\{"anyOf"/);
    assert.match(render(tools.get('update_task')), /"set":\{"anyOf"/);
  });

  test('decorate can set it, and rebuilds both artifacts for it', () => {
    const tools = byName(
      buildTools(schema, {
        decorate: (d) => (d.name === 'tasks' ? { nullBranches: filtersOnly } : undefined),
      }),
    );
    assert.doesNotMatch(render(tools.get('tasks')), /"where":\{"anyOf"/);
    // The undecorated neighbour keeps the default everywhere.
    assert.match(render(tools.get('update_task')), /"where":\{"anyOf"/);
  });
});
