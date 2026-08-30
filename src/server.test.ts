/**
 * End-to-end: drive a generated server through a real MCP Client over an
 * in-memory transport pair — list the tools, call them, and exercise custom-tool
 * overrides — so the SDK registration path is covered, not just the descriptors.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildSchema } from 'graphql';
import { createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';
import { createMcpServer } from './server.ts';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseResult(result: unknown): { isError?: boolean; data?: unknown; errors?: unknown } {
  const typed = result as TextResult;
  const parsed = JSON.parse(typed.content[0].text);
  return { isError: typed.isError, ...parsed };
}

describe('createMcpServer', () => {
  test('exposes every root field as a listable tool', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'createTodo',
      'setCompleted',
      'todo',
      'todos',
    ]);
    const createTodo = tools.find((t) => t.name === 'createTodo');
    // The input schema reached the client as JSON Schema derived from the args.
    assert.equal(createTodo?.inputSchema.type, 'object');
    assert.ok((createTodo?.inputSchema.properties as Record<string, unknown>).input);
    await client.close();
  });

  test('calling a query tool runs the operation and returns data', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'todo', arguments: { id: 'todo-1' } });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.deepEqual(
      (data as { todo: { description: string } }).todo.description,
      'write the wrapper',
    );
    await client.close();
  });

  test('calling a mutation tool mutates through the schema', async () => {
    const { schema, root, store } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);

    const before = store.length;
    const result = await client.callTool({
      name: 'createTodo',
      arguments: { input: { userId: 'user-2', description: 'new task' } },
    });
    const { data } = parseResult(result);
    assert.equal(
      (data as { createTodo: { description: string } }).createTodo.description,
      'new task',
    );
    assert.equal(store.length, before + 1);
    await client.close();
  });

  test('a missing record is data: null, not an error', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'todo', arguments: { id: 'nope' } });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.equal((data as { todo: unknown }).todo, null);
    await client.close();
  });

  test('a failed root field is reported as an error', async () => {
    const schema = buildSchema('type Query { boom: String }');
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, {
        rootValue: {
          boom: () => {
            throw new Error('resolver exploded');
          },
        },
      }),
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'boom', arguments: {} });
    const { isError, errors } = parseResult(result);
    assert.equal(isError, true);
    assert.equal((errors as Array<{ message: string }>)[0].message, 'resolver exploded');
    await client.close();
  });

  test('a partial result stays usable instead of being flagged an error', async () => {
    // One row resolves, the next throws — GraphQL returns data *and* errors.
    const schema = buildSchema(
      'type Item { id: String! boom: String } type Query { items: [Item!]! }',
    );
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, {
        rootValue: {
          items: () => [
            { id: 'a', boom: () => 'fine' },
            {
              id: 'b',
              boom: () => {
                throw new Error('resolver exploded');
              },
            },
          ],
        },
      }),
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'items', arguments: {} });
    const { isError, data, errors } = parseResult(result);
    // The good row survived, so the agent must not be told the call failed.
    assert.equal(isError, false);
    const items = (data as { items: Array<{ id: string; boom: string | null }> }).items;
    assert.equal(items.length, 2);
    assert.equal(items[0].boom, 'fine');
    assert.equal(items[1].boom, null);
    assert.equal((errors as unknown[]).length, 1);
    await client.close();
  });

  test('error payloads drop locations but keep path and extensions', async () => {
    const schema = buildSchema('type Query { boom: String }');
    const server = createMcpServer({
      schema,
      executor: async () => ({
        data: null,
        errors: [
          {
            message: 'Unauthorized',
            locations: [{ line: 2, column: 14 }],
            path: ['boom'],
            extensions: { code: 'UNAUTHENTICATED' },
          },
        ],
      }),
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'boom', arguments: {} });
    const error = (parseResult(result).errors as Array<Record<string, unknown>>)[0];
    // Line/column point into a query the agent never wrote.
    assert.equal('locations' in error, false);
    assert.deepEqual(error.path, ['boom']);
    assert.deepEqual(error.extensions, { code: 'UNAUTHENTICATED' });
    await client.close();
  });

  test('maxChars clamps a generated tool result', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      maxChars: 120,
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'todos', arguments: {} });
    const body = (result as TextResult).content[0].text;
    assert.match(body, /\[truncated \d+ of \d+ characters/);
    await client.close();
  });

  test('a tool description states the selection the agent will get back', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const todos = tools.find((t) => t.name === 'todos');
    assert.ok(todos?.description);
    // The return type alone wouldn't tell the agent which fields arrive, nor
    // that `createdBy` is truncated to `id` by the depth limit.
    assert.match(todos.description, /Returns this fixed selection/);
    assert.match(todos.description, /createdBy \{ id __typename \}/);
    await client.close();
  });

  test('a custom tool overrides a generated one by name', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      tools: [
        {
          name: 'todo',
          description: 'Overridden todo tool',
          handler: async () => ({ content: [{ type: 'text', text: 'custom!' }] }),
        },
      ],
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    const todo = tools.find((t) => t.name === 'todo');
    assert.equal(todo?.description, 'Overridden todo tool');
    // still only four tools — the custom one replaced, not added
    assert.equal(tools.length, 4);

    const result = await client.callTool({ name: 'todo', arguments: {} });
    assert.equal((result as TextResult).content[0].text, 'custom!');
    await client.close();
  });

  test('a renamed tool still executes its operation', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      toolName: (field, kind) => `${kind}_${field.name}`,
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'query_todo', arguments: { id: 'todo-1' } });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.equal((data as { todo: { description: string } }).todo.description, 'write the wrapper');
    await client.close();
  });

  test('extend adds MCP-only fields served by the default local executor', async () => {
    const { schema } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      extend: {
        typeDefs: /* GraphQL */ `
          extend type Query {
            "How an agent should use this API."
            usageGuide: String!
          }
        `,
        resolvers: {
          Query: { usageGuide: () => 'call todos first' },
        },
      },
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'usageGuide'));

    const result = await client.callTool({ name: 'usageGuide', arguments: {} });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.equal((data as { usageGuide: string }).usageGuide, 'call todos first');
    await client.close();
  });

  test('metaTools: true adds the four schema-exploration tools alongside generated ones', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      metaTools: true,
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'createTodo',
      'graphql_execute',
      'graphql_introspect',
      'graphql_search',
      'graphql_validate',
      'setCompleted',
      'todo',
      'todos',
    ]);
    await client.close();
  });

  test('the execute meta tool runs a document end to end', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      metaTools: true,
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'graphql_execute',
      arguments: { query: 'query All { todos { id description } }' },
    });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.equal((data as { todos: unknown[] }).todos.length, 2);
    await client.close();
  });

  test('the execute meta tool inherits the server exclude rules', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      exclude: ['Mutation.*'],
      metaTools: true,
    });
    const client = await connect(server);

    // The generated mutation tools are gone…
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === 'createTodo'));

    // …and the raw-document path can't reach them either.
    const result = (await client.callTool({
      name: 'graphql_execute',
      arguments: {
        query: 'mutation { createTodo(input: { userId: "u", description: "d" }) { id } }',
      },
    })) as TextResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Not permitted: `createTodo`/);
    await client.close();
  });

  test('metaTools rules override the server rules when given explicitly', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      // No generated tools at all — the meta tools are the whole surface.
      includeQueries: false,
      includeMutations: false,
      metaTools: { tools: ['execute'], prefix: 'gql_', include: ['todos'] },
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['gql_execute'],
    );

    const ok = await client.callTool({
      name: 'gql_execute',
      arguments: { query: '{ todos { id } }' },
    });
    assert.equal(parseResult(ok).isError, false);

    const denied = (await client.callTool({
      name: 'gql_execute',
      arguments: { query: '{ todo(id: "todo-1") { id } }' },
    })) as TextResult;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Not permitted: `todo`/);
    await client.close();
  });

  test('a custom tool overrides a meta tool by name', async () => {
    const { schema } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      metaTools: true,
      tools: [
        {
          name: 'graphql_search',
          description: 'Overridden search',
          handler: async () => ({ content: [{ type: 'text', text: 'mine' }] }),
        },
      ],
    });
    const client = await connect(server);

    const { tools } = await client.listTools();
    assert.equal(tools.filter((t) => t.name === 'graphql_search').length, 1);
    assert.equal(tools.find((t) => t.name === 'graphql_search')?.description, 'Overridden search');
    await client.close();
  });

  test('metaTools sees the extended schema', async () => {
    const { schema, root } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      includeQueries: false,
      includeMutations: false,
      extend: {
        typeDefs: 'extend type Query { usageGuide: String! }',
        resolvers: { Query: { usageGuide: () => 'start with todos' } },
      },
      metaTools: { tools: ['introspect'] },
    });
    const client = await connect(server);

    const result = (await client.callTool({
      name: 'graphql_introspect',
      arguments: {},
    })) as TextResult;
    assert.match(result.content[0].text, /usageGuide: String!/);
    await client.close();
  });

  test('per-call context is threaded into the executor', async () => {
    const { schema } = makeTodoSchema();
    let seenContext: unknown;
    const server = createMcpServer({
      schema,
      context: { userId: 'ctx-user' },
      executor: async ({ context }) => {
        seenContext = context;
        return { data: { todos: [] } };
      },
    });
    const client = await connect(server);
    await client.callTool({ name: 'todos', arguments: {} });
    assert.deepEqual(seenContext, { userId: 'ctx-user' });
    await client.close();
  });
});
