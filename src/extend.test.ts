import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLScalarType } from 'graphql';
import { createLocalExecutor } from './executor.ts';
import { extendSchemaForMcp, stripRootTypes } from './extend.ts';
import { makeTodoSchema, setMcpExtensions } from './fixtures.test.ts';
import { buildTools } from './tools.ts';

const USAGE_EXTENSION = {
  typeDefs: /* GraphQL */ `
    "Input for the MCP-only summary field."
    input SummaryInput {
      "Cap the number of todos summarized."
      limit: Int
    }

    extend type Query {
      "An MCP-only summary of the todo list."
      todoSummary(input: SummaryInput): String!
    }
  `,
  resolvers: {
    Query: {
      todoSummary: () => 'all todos look great',
    },
  },
};

describe('extendSchemaForMcp', () => {
  test('extended fields become tools and execute through the local executor', async () => {
    const { schema } = makeTodoSchema();
    const extended = extendSchemaForMcp(schema, USAGE_EXTENSION);

    const tools = buildTools(extended);
    const summary = tools.find((t) => t.name === 'todoSummary');
    assert.ok(summary);
    assert.match(summary.description, /An MCP-only summary of the todo list\./);

    const executor = createLocalExecutor(extended);
    const result = await executor({
      query: summary.query,
      variables: {},
      operationName: summary.operationName,
    });
    assert.equal(result.errors, undefined);
    assert.equal(result.data?.todoSummary, 'all todos look great');
  });

  test('original fields still resolve after the merge', async () => {
    const { schema, root } = makeTodoSchema();
    const extended = extendSchemaForMcp(schema, USAGE_EXTENSION);

    const executor = createLocalExecutor(extended, { rootValue: root });
    const result = await executor({
      query: 'query todos { todos { id } }',
      variables: {},
      operationName: 'todos',
    });
    assert.equal(result.errors, undefined);
    assert.equal((result.data?.todos as unknown[]).length, 2);
  });

  test('extension-added input types flow through the tool input schema', () => {
    const { schema } = makeTodoSchema();
    const extended = extendSchemaForMcp(schema, USAGE_EXTENSION);
    const summary = buildTools(extended).find((t) => t.name === 'todoSummary');
    assert.ok(summary?.inputSchema.input);
    assert.match(summary.description, /- `input`: `SummaryInput`/);
  });

  test('field.extensions.mcp metadata on the base schema survives the merge', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { appendDescription: 'Agent note.' });
    const extended = extendSchemaForMcp(schema, USAGE_EXTENSION);

    const todo = buildTools(extended).find((t) => t.name === 'todo');
    assert.match(todo?.description ?? '', /Agent note\./);
  });
});

describe('stripRootTypes', () => {
  test('drops the root operation types and keeps everything else', () => {
    const { schema } = makeTodoSchema();
    const stripped = stripRootTypes(schema);

    assert.equal(stripped.getQueryType(), undefined);
    assert.equal(stripped.getMutationType(), undefined);
    const names = Object.keys(stripped.getTypeMap());
    for (const kept of ['Todo', 'User', 'CreateTodoInput', 'TodoStatus']) {
      assert.ok(names.includes(kept), `expected ${kept} to survive`);
    }
    assert.ok(!names.includes('Query'));
    assert.ok(!names.includes('Mutation'));
  });

  test('preserves custom scalar behaviour', () => {
    const schema = buildSchema('scalar Stamp\ntype Query { at: Stamp }');
    const stamp = schema.getType('Stamp') as GraphQLScalarType;
    stamp.serialize = (value) => `stamped:${value}`;

    const kept = stripRootTypes(schema).getType('Stamp') as GraphQLScalarType;
    assert.equal(kept.serialize?.('x'), 'stamped:x');
  });
});

describe('extend.typesOnly', () => {
  const TOOL_SURFACE = {
    typesOnly: true,
    typeDefs: /* GraphQL */ `
      type Query {
        "Find todos an agent should look at."
        agentTodos(status: TodoStatus): [Todo!]!
      }
    `,
    resolvers: {
      Query: {
        agentTodos: () => [
          {
            id: 't1',
            completed: false,
            description: 'from the tool schema',
            createdBy: { id: 'user-1', todos: [] },
          },
        ],
      },
    },
  };

  test('only the tool-specific root fields become tools', () => {
    const { schema } = makeTodoSchema();
    const merged = extendSchemaForMcp(schema, TOOL_SURFACE);
    assert.deepEqual(
      buildTools(merged).map((t) => t.name),
      ['agentTodos'],
    );
  });

  test('base types are reusable from the tool-specific SDL', () => {
    const { schema } = makeTodoSchema();
    const merged = extendSchemaForMcp(schema, TOOL_SURFACE);
    const tool = buildTools(merged)[0];
    assert.ok(tool);
    // `Todo`'s fields and the `TodoStatus` enum came from the base schema.
    assert.match(tool.query, /description/);
    assert.ok(tool.inputSchema.status);
    assert.equal(tool.inputSchema.status?.parse('DONE'), 'DONE');
  });

  test('the tool-specific field executes through the local executor', async () => {
    const { schema } = makeTodoSchema();
    const merged = extendSchemaForMcp(schema, TOOL_SURFACE);
    const tool = buildTools(merged)[0];
    assert.ok(tool);

    const result = await createLocalExecutor(merged)({
      query: tool.query,
      variables: {},
      operationName: tool.operationName,
    });
    assert.equal(result.errors, undefined);
    const todos = result.data?.agentTodos as Array<{ description: string }>;
    assert.equal(todos[0]?.description, 'from the tool schema');
  });

  test('without typesOnly the base root fields are still there', () => {
    const { schema } = makeTodoSchema();
    const merged = extendSchemaForMcp(schema, {
      ...TOOL_SURFACE,
      typesOnly: false,
      typeDefs: 'extend type Query { agentTodos(status: TodoStatus): [Todo!]! }',
    });
    const names = buildTools(merged).map((t) => t.name);
    assert.ok(names.includes('agentTodos'));
    assert.ok(names.includes('todos'));
  });

  test('throws when the extension declares no Query type', () => {
    const { schema } = makeTodoSchema();
    assert.throws(
      () =>
        extendSchemaForMcp(schema, {
          typesOnly: true,
          typeDefs: 'input Unused { a: String }',
        }),
      /must declare its own `type Query/,
    );
  });
});
