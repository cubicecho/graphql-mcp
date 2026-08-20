import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLocalExecutor } from './executor.ts';
import { extendSchemaForMcp } from './extend.ts';
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
