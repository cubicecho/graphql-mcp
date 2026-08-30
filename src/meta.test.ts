/**
 * The opt-in schema-exploration tools. The priority here is the rule
 * enforcement on `execute`: it runs agent-written documents, so if the
 * include/exclude checks leak, a raw document becomes a way around the
 * generated tool surface.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema } from 'graphql';
import { createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';
import { buildMetaTools, type MetaToolsOptions } from './meta.ts';
import type { CustomTool } from './server.ts';

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function makeTools(options: MetaToolsOptions = {}): Map<string, CustomTool> {
  const { schema, root } = makeTodoSchema();
  const tools = buildMetaTools(
    { schema, executor: createLocalExecutor(schema, { rootValue: root }) },
    options,
  );
  return new Map(tools.map((tool) => [tool.name, tool]));
}

async function call(
  tools: Map<string, CustomTool>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<TextResult> {
  const tool = tools.get(name);
  assert.ok(tool, `no meta tool named ${name}`);
  return (await tool.handler(args, undefined)) as TextResult;
}

const body = (result: TextResult) => result.content[0]?.text ?? '';

describe('buildMetaTools', () => {
  test('builds all four tools with the default prefix', () => {
    assert.deepEqual(
      [...makeTools().keys()],
      ['graphql_introspect', 'graphql_search', 'graphql_validate', 'graphql_execute'],
    );
  });

  test('tools selects a subset and prefix renames them', () => {
    const tools = makeTools({ tools: ['introspect', 'execute'], prefix: 'api__' });
    assert.deepEqual([...tools.keys()], ['api__introspect', 'api__execute']);
  });

  test('execute is annotated read-only when mutations are off', () => {
    const off = makeTools({ allowMutations: false }).get('graphql_execute');
    assert.equal(off?.annotations?.readOnlyHint, true);
    assert.equal(off?.annotations?.destructiveHint, false);
    const on = makeTools().get('graphql_execute');
    assert.equal(on?.annotations?.readOnlyHint, false);
    assert.equal(on?.annotations?.destructiveHint, true);
  });
});

describe('graphql_introspect', () => {
  test('with no argument prints callable root fields and every type name', async () => {
    const out = body(await call(makeTools(), 'graphql_introspect'));
    assert.match(out, /type Query \{/);
    assert.match(out, /todos\(status: TodoStatus\): \[Todo!\]!/);
    assert.match(out, /type Mutation \{/);
    assert.match(out, /Types \(\d+\): .*Todo/);
  });

  test('the overview hides root fields the rules deny', async () => {
    const out = body(await call(makeTools({ exclude: ['Mutation.*'] }), 'graphql_introspect'));
    assert.doesNotMatch(out, /type Mutation \{/);
    assert.doesNotMatch(out, /createTodo/);
    // Non-root types are still listed — the rules gate calling, not reading.
    assert.match(out, /Types \(\d+\): /);
  });

  test('with a type name prints that type SDL', async () => {
    const out = body(await call(makeTools(), 'graphql_introspect', { type: 'Todo' }));
    assert.match(out, /type Todo \{/);
    assert.match(out, /completed: Boolean!/);
  });

  test('an unknown type is an error with a suggestion', async () => {
    const result = await call(makeTools(), 'graphql_introspect', { type: 'Todoo' });
    assert.equal(result.isError, true);
    assert.match(body(result), /Unknown type 'Todoo'/);
    assert.match(body(result), /Did you mean 'Todo'/);
  });

  test('introspection types are not reachable', async () => {
    const result = await call(makeTools(), 'graphql_introspect', { type: '__Schema' });
    assert.equal(result.isError, true);
  });
});

describe('graphql_search', () => {
  test('matches type and field names', async () => {
    const out = body(await call(makeTools(), 'graphql_search', { query: 'todo' }));
    assert.match(out, /type Todo/);
    assert.match(out, /Query\.todos\(/);
    assert.match(out, /Mutation\.createTodo\(/);
  });

  test('matches descriptions too', async () => {
    const out = body(await call(makeTools(), 'graphql_search', { query: 'UUID' }));
    assert.match(out, /Todo\.id/);
  });

  test('hides root fields the rules deny', async () => {
    const out = body(
      await call(makeTools({ exclude: ['createTodo'] }), 'graphql_search', { query: 'todo' }),
    );
    assert.doesNotMatch(out, /Mutation\.createTodo/);
    assert.match(out, /Query\.todos\(/);
  });

  test('limit caps the number of hits', async () => {
    const out = body(await call(makeTools(), 'graphql_search', { query: 'todo', limit: 2 }));
    assert.equal(out.split('\n').length, 2);
  });

  test('reports a miss instead of erroring', async () => {
    const result = await call(makeTools(), 'graphql_search', { query: 'zzz' });
    assert.equal(result.isError, undefined);
    assert.match(body(result), /No type or field matches 'zzz'/);
  });
});

describe('graphql_validate', () => {
  test('accepts a valid document', async () => {
    const result = await call(makeTools(), 'graphql_validate', {
      query: '{ todos { id } }',
    });
    assert.equal(result.isError, undefined);
    assert.equal(body(result), 'Valid.');
  });

  test('reports validation errors', async () => {
    const result = await call(makeTools(), 'graphql_validate', {
      query: '{ todos { nope } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Invalid document:/);
    assert.match(body(result), /Cannot query field "nope"/);
  });

  test('reports a syntax error distinctly', async () => {
    const result = await call(makeTools(), 'graphql_validate', { query: '{ todos {' });
    assert.equal(result.isError, true);
    assert.match(body(result), /^Syntax error: /);
  });

  test('does not enforce the execute rules — validate only reads', async () => {
    const result = await call(makeTools({ exclude: ['createTodo'] }), 'graphql_validate', {
      query: 'mutation { createTodo(input: { userId: "u", description: "d" }) { id } }',
    });
    assert.equal(body(result), 'Valid.');
  });
});

describe('graphql_execute', () => {
  test('runs a document and returns the data', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query: '{ todos { id description } }',
    });
    assert.equal(result.isError, false);
    const { data } = JSON.parse(body(result));
    assert.equal(data.todos.length, 2);
  });

  test('passes variables through', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query: 'query One($id: String!) { todo(id: $id) { description } }',
      variables: { id: 'todo-2' },
    });
    const { data } = JSON.parse(body(result));
    assert.equal(data.todo.description, 'read the brief');
  });

  test('runs a mutation when allowed', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query:
        'mutation { createTodo(input: { userId: "u1", description: "fresh" }) { description } }',
    });
    assert.equal(result.isError, false);
    const { data } = JSON.parse(body(result));
    assert.equal(data.createTodo.description, 'fresh');
  });

  test('a GraphQL execution error comes back as isError', async () => {
    const { schema } = makeTodoSchema();
    const tools = new Map(
      buildMetaTools({
        schema,
        // No rootValue, so the non-null `[Todo!]!` resolves to null and errors.
        executor: createLocalExecutor(schema),
      }).map((t) => [t.name, t]),
    );
    const result = await call(tools, 'graphql_execute', { query: '{ todos { id } }' });
    assert.equal(result.isError, true);
    assert.ok(JSON.parse(body(result)).errors);
  });

  test('rejects a syntax error before touching the executor', async () => {
    const result = await call(makeTools(), 'graphql_execute', { query: '{ todos {' });
    assert.equal(result.isError, true);
    assert.match(body(result), /^Syntax error: /);
  });

  test('rejects a document that fails validation', async () => {
    const result = await call(makeTools(), 'graphql_execute', { query: '{ nope }' });
    assert.equal(result.isError, true);
    assert.match(body(result), /Invalid document:/);
  });

  test('requires operationName when the document defines several', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query: 'query A { todos { id } } query B { todos { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /multiple operations \(A, B\) — pass operationName/);
  });

  test('picks the named operation', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query: 'query A { todo(id: "todo-1") { id } } query B { todos { id } }',
      operationName: 'B',
    });
    const { data } = JSON.parse(body(result));
    assert.ok(Array.isArray(data.todos));
  });

  test('reports an unknown operationName', async () => {
    const result = await call(makeTools(), 'graphql_execute', {
      query: 'query A { todos { id } }',
      operationName: 'C',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /No operation named 'C'/);
  });

  test('refuses subscriptions, without reaching the executor', async () => {
    // The todo fixture has no Subscription type (validate would reject first),
    // so use a schema that does, to reach the subscription branch.
    const schema = buildSchema('type Query { ping: String }\ntype Subscription { ticks: String }');
    let called = false;
    const tools = new Map(
      buildMetaTools({
        schema,
        executor: async () => {
          called = true;
          return { data: null };
        },
      }).map((t) => [t.name, t]),
    );
    const result = await call(tools, 'graphql_execute', { query: 'subscription { ticks }' });
    assert.equal(result.isError, true);
    assert.match(body(result), /Subscriptions are not supported over MCP\./);
    assert.equal(called, false);
  });
});

describe('graphql_execute rule enforcement', () => {
  test('refuses a root field denied by exclude', async () => {
    const result = await call(makeTools({ exclude: ['createTodo'] }), 'graphql_execute', {
      query: 'mutation { createTodo(input: { userId: "u", description: "d" }) { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `createTodo`/);
    assert.match(body(result), /graphql_introspect/);
  });

  test('refuses a root field outside include', async () => {
    const result = await call(makeTools({ include: ['todos'] }), 'graphql_execute', {
      query: '{ todo(id: "todo-1") { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `todo`/);
  });

  test('allows a root field inside include', async () => {
    const result = await call(makeTools({ include: ['todos'] }), 'graphql_execute', {
      query: '{ todos { id } }',
    });
    assert.equal(result.isError, false);
  });

  test('only root fields are gated — nested field names are not', async () => {
    // `Todo.createdBy` shares no name with a denied root field, but `todo` does
    // appear as `User.todos`; selecting it must not be treated as a root call.
    const result = await call(makeTools({ include: ['todo'] }), 'graphql_execute', {
      query: '{ todo(id: "todo-1") { createdBy { todos { id } } } }',
    });
    assert.equal(result.isError, false);
  });

  test('names every denied root field, not just the first', async () => {
    const result = await call(makeTools({ include: ['nothing'] }), 'graphql_execute', {
      query: '{ todos { id } todo(id: "todo-1") { id } }',
    });
    assert.match(body(result), /Not permitted: `todos`, `todo`/);
  });

  test('a root fragment spread cannot hide a denied field', async () => {
    const result = await call(makeTools({ exclude: ['todo'] }), 'graphql_execute', {
      query: '{ ...Roots } fragment Roots on Query { todo(id: "todo-1") { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `todo`/);
  });

  test('a nested fragment spread cannot hide a denied field either', async () => {
    const result = await call(makeTools({ exclude: ['todo'] }), 'graphql_execute', {
      query:
        '{ ...Outer } fragment Outer on Query { ...Inner } fragment Inner on Query { todo(id: "x") { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `todo`/);
  });

  test('a root inline fragment cannot hide a denied field', async () => {
    const result = await call(makeTools({ exclude: ['todo'] }), 'graphql_execute', {
      query: '{ ... on Query { todo(id: "todo-1") { id } } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `todo`/);
  });

  test('__typename at the root is always permitted', async () => {
    const result = await call(makeTools({ include: ['todos'] }), 'graphql_execute', {
      query: '{ __typename todos { id } }',
    });
    assert.equal(result.isError, false);
  });

  test('refuses mutations when allowMutations is false', async () => {
    const result = await call(makeTools({ allowMutations: false }), 'graphql_execute', {
      query: 'mutation { createTodo(input: { userId: "u", description: "d" }) { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /does not allow mutations/);
  });

  test('a Query-scoped rule does not gate a same-named mutation field', async () => {
    // `Query.*` constrains the kind, so mutations fall outside the include list.
    const result = await call(makeTools({ include: ['Query.*'] }), 'graphql_execute', {
      query: 'mutation { createTodo(input: { userId: "u", description: "d" }) { id } }',
    });
    assert.equal(result.isError, true);
    assert.match(body(result), /Not permitted: `createTodo`/);
  });
});

describe('meta tool context and truncation', () => {
  test('execute resolves the per-call context and passes it to the executor', async () => {
    const { schema } = makeTodoSchema();
    let seen: unknown;
    const tools = new Map(
      buildMetaTools({
        schema,
        executor: async ({ context }) => {
          seen = context;
          return { data: { todos: [] } };
        },
        resolveContext: async (extra) => ({ from: extra }),
      }).map((t) => [t.name, t]),
    );
    const tool = tools.get('graphql_execute');
    assert.ok(tool);
    await tool.handler({ query: '{ todos { id } }' }, { token: 'abc' });
    assert.deepEqual(seen, { from: { token: 'abc' } });
  });

  test('maxChars truncates a long result with a note', async () => {
    const out = body(await call(makeTools({ maxChars: 40 }), 'graphql_introspect'));
    assert.match(out, /\[truncated \d+ of \d+ characters/);
    // The clamp keeps the budget plus the note.
    assert.ok(out.startsWith('type Query {'));
  });

  test('maxChars truncates an execute result too', async () => {
    const result = await call(makeTools({ maxChars: 30 }), 'graphql_execute', {
      query: '{ todos { id description } }',
    });
    assert.match(body(result), /\[truncated \d+ of \d+ characters/);
  });
});

describe('graphql_introspect deprecation', () => {
  const schema = buildSchema(/* GraphQL */ `
    type T {
      id: ID!
      stale: String @deprecated(reason: "gone in v3")
    }
    type Query {
      t: T!
      old: T! @deprecated(reason: "use t")
    }
  `);

  async function introspect(args: Record<string, unknown>) {
    const tools = buildMetaTools({ schema, executor: createLocalExecutor(schema) }, {});
    const tool = tools.find((t) => t.name === 'graphql_introspect');
    assert.ok(tool);
    const result = await tool.handler(args, {});
    return (result.content[0] as { text: string }).text;
  }

  // On a schema large enough to need the meta tools, this listing can be the
  // agent's whole view of the root fields.
  test('the root-field overview marks a deprecated field', async () => {
    const text = await introspect({});
    assert.match(text, /old: T! @deprecated\(reason: "use t"\)/);
  });

  test('a live field is left unmarked', async () => {
    const text = await introspect({});
    assert.match(text, /^ {2}t: T!$/m);
  });

  test('the per-type view still prints SDL deprecations', async () => {
    const text = await introspect({ type: 'T' });
    assert.match(text, /stale: String @deprecated\(reason: "gone in v3"\)/);
  });
});
