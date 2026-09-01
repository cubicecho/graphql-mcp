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
import { buildSchema, type GraphQLSchema } from 'graphql';
import { z } from 'zod';
import { createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';
import { DEFAULT_MAX_CHARS, runExecutor, toCallToolResult } from './index.ts';
import {
  connectServer,
  createMcpServer,
  createServerFactory,
  type ServerFactory,
} from './server.ts';

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
      'create_todo',
      'set_completed',
      'todo',
      'todos',
    ]);
    const createTodo = tools.find((t) => t.name === 'create_todo');
    // The input schema reached the client as JSON Schema derived from the args.
    assert.equal(createTodo?.inputSchema.type, 'object');
    assert.ok((createTodo?.inputSchema.properties as Record<string, unknown>).input);
    await client.close();
  });

  test('an unknown key is rejected at both levels, naming the field', async () => {
    // The tool listing advertises `additionalProperties: false`; a call has to be
    // held to that. An agent that misspells an argument needs an error it can
    // correct, not a success payload with its typo quietly dropped.
    const { schema, root, store } = makeTodoSchema();
    const seen: Array<Record<string, unknown> | undefined> = [];
    const local = createLocalExecutor(schema, { rootValue: root });
    const server = createMcpServer({
      schema,
      executor: (request) => {
        seen.push(request.variables);
        return local(request);
      },
    });
    const client = await connect(server);

    const nested = (await client.callTool({
      name: 'create_todo',
      arguments: { input: { userId: 'u1', description: 'real', descriptoin: 'typo' } },
    })) as TextResult;
    assert.equal(nested.isError, true);
    assert.match(nested.content[0].text, /descriptoin/);
    // ...and says so in the envelope every other outcome uses.
    assert.equal((parseResult(nested).errors as Array<unknown>).length, 1);

    const topLevel = (await client.callTool({
      name: 'todo',
      arguments: { id: 'todo-1', nope: 'typo' },
    })) as TextResult;
    assert.equal(topLevel.isError, true);
    assert.match(topLevel.content[0].text, /nope/);
    assert.equal((parseResult(topLevel).errors as Array<unknown>).length, 1);

    // Neither call reached GraphQL, and neither wrote anything.
    assert.deepEqual(seen, []);
    assert.equal(store.length, 2);

    // The same calls without the stray key still work.
    const ok = await client.callTool({ name: 'todo', arguments: { id: 'todo-1' } });
    assert.equal(parseResult(ok).isError, false);
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
      name: 'create_todo',
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
    // Parseable first, small second: the budget is a target the clamp works
    // down to by dropping whole rows, and the floor is the record explaining
    // what went missing — a body no client can parse is worth nothing, however
    // small it is.
    const payload = JSON.parse(body) as { truncated?: { totalItems: number } };
    assert.ok(payload.truncated, 'expected the body to report that it was cut');
    assert.ok(body.length < 200, `expected a clamped body, got ${body.length} chars`);
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

  test('an executor that throws still returns a parseable JSON body', async () => {
    // A network failure reaches the SDK as a bare string unless we catch it,
    // breaking `JSON.parse` on exactly the error a client needs to read.
    const { schema } = makeTodoSchema();
    const server = createMcpServer({
      schema,
      executor: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:4000');
      },
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'todos', arguments: {} });
    const body = (result as TextResult).content[0].text;
    const payload = JSON.parse(body) as { errors: Array<{ message: string }> };
    assert.equal(result.isError, true);
    assert.equal(payload.errors[0].message, 'ECONNREFUSED 127.0.0.1:4000');
    await client.close();
  });

  test('a custom tool can reuse the exported result helpers', async () => {
    // Without these on the public API a custom tool has to hand-roll `isError`,
    // and would reintroduce the partial-result bug the generated tools fixed.
    const { schema, root } = makeTodoSchema();
    const executor = createLocalExecutor(schema, { rootValue: root });
    const server = createMcpServer({
      schema,
      executor,
      tools: [
        {
          name: 'firstTodo',
          description: 'The first todo, via the exported helpers.',
          handler: async () => {
            const result = await runExecutor(executor, { query: '{ todos { id } }' });
            return toCallToolResult(result, DEFAULT_MAX_CHARS);
          },
        },
      ],
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'firstTodo', arguments: {} });
    const { isError, data } = parseResult(result);
    assert.equal(isError, false);
    assert.ok((data as { todos: unknown[] }).todos.length > 0);
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
    assert.ok(tools.some((t) => t.name === 'usage_guide'));

    const result = await client.callTool({ name: 'usage_guide', arguments: {} });
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
      'create_todo',
      'graphql_execute',
      'graphql_introspect',
      'graphql_search',
      'graphql_validate',
      'set_completed',
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
    assert.ok(!tools.some((t) => t.name === 'create_todo'));

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

describe('truncated results point at the paging argument', () => {
  const schema = buildSchema('type Query { feed(first: Int, after: String): [String!]! }');
  const root = { feed: () => Array.from({ length: 200 }, (_, i) => `item-${i}`) };

  test('the truncation note names the argument to page with', async () => {
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      maxChars: 200,
    });
    const client = await connect(server);
    const body = ((await client.callTool({ name: 'feed', arguments: {} })) as TextResult).content[0]
      .text;
    // Without this, an agent told only "truncated" can do nothing but re-run
    // the identical call and get the identical oversized page.
    const { truncated } = JSON.parse(body) as { truncated: { totalItems: number; advice: string } };
    assert.equal(truncated.totalItems, 200);
    assert.match(truncated.advice, /pass `first` to cap the page size, then `after`/);
    await client.close();
  });

  test('a result that fits carries no note at all', async () => {
    const server = createMcpServer({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const client = await connect(server);
    const body = ((await client.callTool({ name: 'feed', arguments: {} })) as TextResult).content[0]
      .text;
    assert.doesNotMatch(body, /truncated|paginates/);
    await client.close();
  });

  test('a field with no paging arguments keeps the plain advice', async () => {
    const { schema: todoSchema, root: todoRoot } = makeTodoSchema();
    const server = createMcpServer({
      schema: todoSchema,
      executor: createLocalExecutor(todoSchema, { rootValue: todoRoot }),
      maxChars: 120,
    });
    const client = await connect(server);
    const body = ((await client.callTool({ name: 'todos', arguments: {} })) as TextResult)
      .content[0].text;
    const { truncated } = JSON.parse(body) as { truncated: { advice: string } };
    assert.equal(truncated.advice, 'narrow the query or request fewer fields');
    await client.close();
  });
});

describe('a call that omits its arguments', () => {
  const schema = buildSchema(/* GraphQL */ `
    type Query {
      schedule: String
      tasks(limit: Int): String
    }
  `);

  const server = () =>
    createMcpServer({ schema, executor: createLocalExecutor(schema), name: 't', version: '0' });

  async function connectTolerant(mcp: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([connectServer(mcp, serverTransport), client.connect(clientTransport)]);
    return client;
  }

  // `params.arguments` is optional in the MCP schema, and a field taking no
  // arguments gives a client nothing to put there — so this is the natural call,
  // not a malformed one. The SDK hands `undefined` to the input schema, which
  // rejects it before the handler runs, and the tool becomes uncallable.
  test('a no-argument tool is callable with no arguments at all', async () => {
    const client = await connectTolerant(server());
    const result = parseResult(await client.callTool({ name: 'schedule' }));
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(result.data, { schedule: null });
  });

  test('so is a tool whose arguments are all optional', async () => {
    const client = await connectTolerant(server());
    const result = parseResult(await client.callTool({ name: 'tasks' }));
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(result.data, { tasks: null });
  });

  test('arguments that are sent still reach the operation', async () => {
    const client = await connectTolerant(server());
    const result = parseResult(await client.callTool({ name: 'tasks', arguments: { limit: 3 } }));
    assert.ok(!result.isError, JSON.stringify(result));
  });

  test('a request that is not a tool call passes through untouched', async () => {
    const client = await connectTolerant(server());
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['schedule', 'tasks']);
  });
});

describe('tool definitions stay small for a schema that filters through relations', () => {
  // The shape a generated CRUD API has: each table filters by its relations, and
  // those filter back. Written out at every route rather than shared, one such
  // `where` rendered at 2.8 MB and a seventeen-tool listing at 18 MB — past what
  // any model will read, and it arrives before a single call can be made.
  const schema = buildSchema(/* GraphQL */ `
    input StringFilter {
      eq: String
      ne: String
      contains: String
      OR: [StringFilter!]
    }
    input TaskFilters {
      id: StringFilter
      name: StringFilter
      prompt: StringFilter
      runs: RunFilters
      steps: StepFilters
      triggers: TriggerFilters
      OR: [TaskFilters!]
      NOT: TaskFilters
    }
    input RunFilters {
      id: StringFilter
      status: StringFilter
      task: TaskFilters
      steps: StepFilters
      triggers: TriggerFilters
      OR: [RunFilters!]
    }
    input StepFilters {
      id: StringFilter
      kind: StringFilter
      run: RunFilters
      task: TaskFilters
      triggers: TriggerFilters
      OR: [StepFilters!]
    }
    input TriggerFilters {
      id: StringFilter
      kind: StringFilter
      task: TaskFilters
      run: RunFilters
      steps: StepFilters
      OR: [TriggerFilters!]
    }
    type Task {
      id: String!
      name: String!
    }
    type Query {
      tasks(where: TaskFilters): [Task!]!
      runs(where: RunFilters): [Task!]!
    }
  `);

  test('the whole listing is something a client can actually read', async () => {
    const client = await connect(
      createMcpServer({ schema, executor: createLocalExecutor(schema), name: 't', version: '0' }),
    );
    const { tools } = await client.listTools();
    const size = JSON.stringify(tools).length;
    // The bound is the order of magnitude, not the byte: four tables render at
    // ~7.8 kB shared and ~45 kB written out, and the gap widens with every table
    // a real schema adds.
    assert.ok(size < 20_000, `tools/list rendered ${size} bytes`);
  });

  test('and the relation filters are still there to be used', async () => {
    const client = await connect(
      createMcpServer({ schema, executor: createLocalExecutor(schema), name: 't', version: '0' }),
    );
    const { tools } = await client.listTools();
    // The whole document, not just `properties`: sharing an input type is the
    // point of the fix, and where the shared copy lands is a zod-version
    // detail — v3 inlines the first occurrence under `properties`, v4 hoists it
    // into `definitions` and leaves a `$ref` behind. Either way the relation
    // filters have to be reachable from the schema a client is handed.
    const advertised = JSON.stringify(tools.find((tool) => tool.name === 'tasks')?.inputSchema);
    assert.ok(advertised.includes('runs'));
    assert.ok(advertised.includes('triggers'));
  });

  test('a shared filter is named after its GraphQL type, not by position', async () => {
    const client = await connect(
      createMcpServer({ schema, executor: createLocalExecutor(schema), name: 't', version: '0' }),
    );
    const { tools } = await client.listTools();
    const advertised = tools.find((tool) => tool.name === 'tasks')?.inputSchema as Record<
      string,
      unknown
    >;
    // The fallback name for a hoisted anonymous schema is its position, which
    // carries nothing: an agent reading a `where` argument has to resolve
    // `#/definitions/__schema7` by hand, fifteen times, with nothing to anchor
    // any of it to. The GraphQL type name is the meaning, and we have it.
    assert.doesNotMatch(JSON.stringify(advertised), /__schema\d/);
    // Where a shared type lands is a zod-version detail — v3 inlines it, v4
    // hoists it — so assert on the entries that exist rather than on there
    // being any. Every one has to be a type the SDL declares.
    const declared = ['StringFilter', 'TaskFilters', 'RunFilters', 'StepFilters', 'TriggerFilters'];
    const hoisted = (advertised.definitions ?? advertised.$defs ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(hoisted)) {
      assert.ok(declared.includes(name), `definitions.${name} is not a GraphQL type name`);
    }
  });
});

describe('a filter type reused across columns is rendered once', () => {
  // The other half of the size story, and the half the cyclic schema above
  // cannot catch. `StringFilter` has no self-reference, so nothing about it
  // *forces* a render to share it — the v3 converter did anyway, by pointing
  // every repeat at the first occurrence, while v4 hoists only what it must and
  // wrote the type out at all ten columns. Ten columns across six tables is an
  // ordinary generated CRUD API, and that path rendered its listing at 275 kB
  // against v3's 149 kB. Naming each input type (see `withName`) is what makes
  // v4 hoist it too; this test is the guard on that not drifting back.
  const columns = ['id', 'name', 'slug', 'status', 'kind', 'owner', 'title', 'body', 'tag', 'note'];
  const schema = buildSchema(/* GraphQL */ `
    input StringFilter {
      eq: String
      ne: String
      contains: String
      startsWith: String
      in: [String!]
    }
    input StepFilters {
${columns.map((column) => `      ${column}: StringFilter`).join('\n')}
    }
    type Step {
      id: String!
    }
    type Query {
      steps(where: StepFilters): [Step!]!
    }
  `);

  test('the shared type appears once however many columns reference it', async () => {
    const client = await connect(
      createMcpServer({ schema, executor: createLocalExecutor(schema), name: 't', version: '0' }),
    );
    const { tools } = await client.listTools();
    const advertised = JSON.stringify(tools[0]?.inputSchema);
    // `startsWith` belongs to `StringFilter` alone, so counting it counts how
    // many times the type was written out. Where the single copy lives is a
    // zod-version detail — inline plus back-references on v3, a named
    // `definitions` entry on v4 — but there has to be exactly one.
    const expansions = advertised.split('"startsWith"').length - 1;
    assert.equal(expansions, 1, `StringFilter was written out ${expansions} times`);
    // The size that follows from it. Both majors land near 1.3 kB; the path
    // that expanded per column took the same document to 3.4 kB, and the gap
    // multiplies with every column and table a real schema adds.
    assert.ok(advertised.length < 2_000, `one filter argument rendered ${advertised.length} bytes`);
    await client.close();
  });

  test("nullBranches: 'never' cuts the listing further, end to end", async () => {
    // Sharing the type was the first half; not stating optionality twice is the
    // second. On a filter-per-column schema the null branches are most of what
    // is left, and one of them — `anyOf: [{$ref}, {type: null}]` — has no legal
    // draft-07 rendering at all, so a downstream consumer can neither keep it
    // nor collapse it.
    const listing = async (options: Partial<Parameters<typeof createMcpServer>[0]>) => {
      const client = await connect(
        createMcpServer({
          schema,
          executor: createLocalExecutor(schema),
          name: 't',
          version: '0',
          ...options,
        }),
      );
      const { tools } = await client.listTools();
      const advertised = JSON.stringify(tools[0]?.inputSchema);
      await client.close();
      return advertised;
    };

    const withBranches = await listing({});
    const without = await listing({ nullBranches: 'never' });
    assert.match(withBranches, /"null"/);
    assert.doesNotMatch(without, /"null"/);
    assert.ok(
      without.length < withBranches.length * 0.85,
      `expected a real cut, got ${withBranches.length} → ${without.length}`,
    );
  });
});

describe('the tool listing is rendered once per factory', () => {
  // The SDK converts every tool's Zod schema to JSON Schema inside its
  // `tools/list` handler, so a stateless server pays for it on every request.
  // See `shareToolListing`.
  const COLUMNS = Array.from({ length: 12 }, (_, i) => `col${i}`);
  const TABLES = ['users', 'posts', 'orders', 'teams', 'invoices', 'products'];

  function filterHeavySchema(): GraphQLSchema {
    const parts = [
      `input Filters { eq: String ne: String lt: String gt: String like: String inArray: [String!] isNull: Boolean }`,
    ];
    for (const table of TABLES) {
      const type = table[0].toUpperCase() + table.slice(1);
      parts.push(`type ${type} { ${COLUMNS.map((c) => `${c}: String`).join(' ')} }`);
      parts.push(`input ${type}Where { ${COLUMNS.map((c) => `${c}: Filters`).join(' ')} }`);
    }
    parts.push(
      `type Query { ${TABLES.map((table) => {
        const type = table[0].toUpperCase() + table.slice(1);
        return `${table}(where: ${type}Where, limit: Int): [${type}!]!`;
      }).join(' ')} }`,
    );
    return buildSchema(parts.join('\n'));
  }

  async function listMany(factory: ServerFactory, times: number): Promise<number> {
    const client = await connect(factory());
    await client.listTools();
    const started = performance.now();
    for (let i = 0; i < times; i++) await client.listTools();
    const elapsed = performance.now() - started;
    await client.close();
    return elapsed;
  }

  test('two servers from one factory list identically', async () => {
    const { schema, root } = makeTodoSchema();
    const factory = createServerFactory({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      metaTools: true,
    });
    const first = await connect(factory());
    const second = await connect(factory());

    assert.deepEqual((await first.listTools()).tools, (await second.listTools()).tools);
    await first.close();
    await second.close();
  });

  test('the second listing costs a fraction of the first', async () => {
    const schema = filterHeavySchema();
    const cached = createServerFactory({ schema, selectionDepth: 1 });
    const uncached = createServerFactory({ schema, selectionDepth: 1 });
    // Any change to a tool set retires the shared listing, which is exactly the
    // behaviour to compare against: the SDK rendering every response.
    uncached().sendToolListChanged();

    const withCache = await listMany(cached, 10);
    const withoutCache = await listMany(uncached, 10);

    assert.ok(
      withCache * 4 < withoutCache,
      `expected the cached listings to be far cheaper, got ${withCache.toFixed(1)}ms vs ${withoutCache.toFixed(1)}ms`,
    );
  });

  test('changing one server’s tools retires the listing for all of them', async () => {
    const { schema, root } = makeTodoSchema();
    const factory = createServerFactory({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    const mutated = factory();
    const client = await connect(mutated);
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'late'));

    mutated.registerTool('late', { description: 'registered after the first listing' }, () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    // The server that changed reports the new tool...
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'late'));
    // ...and a sibling that never had it does not inherit a stale listing.
    const sibling = await connect(factory());
    assert.ok(!(await sibling.listTools()).tools.some((t) => t.name === 'late'));
    await client.close();
    await sibling.close();
  });
});

describe('a rejected argument reads like every other failure', () => {
  // The SDK validates `arguments` before the handler runs and reports a failure
  // as bare text, which is the one tool body that would not parse. See
  // `guardToolArguments`.
  const schema = buildSchema(`
    enum Priority { LOW HIGH }
    input Step { name: String! order: Int! }
    input TaskInput { title: String! priority: Priority steps: [Step!] }
    type Task { id: ID! title: String! }
    type Query { tasks(limit: Int, filter: TaskInput): [Task!]! }
  `);

  interface InputError {
    message: string;
    extensions?: { code?: string };
  }

  async function callTasks(args: Record<string, unknown>): Promise<{
    isError?: boolean;
    text: string;
    errors: InputError[];
  }> {
    const server = createMcpServer({ schema, executor: async () => ({ data: { tasks: [] } }) });
    const client = await connect(server);
    const result = (await client.callTool({ name: 'tasks', arguments: args })) as TextResult;
    await client.close();
    const text = result.content[0].text;
    return {
      isError: result.isError,
      text,
      errors: (JSON.parse(text).errors ?? []) as InputError[],
    };
  }

  const malformed: Array<[string, Record<string, unknown>]> = [
    ['a wrong scalar type', { limit: 'ten' }],
    ['an unknown key', { limit: 1, order: 'asc' }],
    ['a bad enum member', { filter: { title: 't', priority: 'URGENT' } }],
    ['a missing required subfield', { filter: { title: 't', steps: [{ name: 'a' }] } }],
  ];

  for (const [label, args] of malformed) {
    test(`${label} comes back as parseable JSON`, async () => {
      const { isError, errors } = await callTasks(args);
      assert.equal(isError, true);
      assert.ok(errors.length >= 1);
      for (const error of errors) {
        assert.equal(error.extensions?.code, 'BAD_INPUT');
        assert.equal(typeof error.message, 'string');
      }
    });
  }

  test('the error names the argument, however deep it is', async () => {
    const { errors } = await callTasks({ filter: { title: 't', steps: [{ name: 'a' }] } });
    assert.match(errors[0].message, /filter\.steps\[0\]\.order/);
  });

  test('every problem is reported, not just the first', async () => {
    // The SDK's message carries one issue; an agent correcting one argument at a
    // time needs a round trip per mistake.
    const { errors } = await callTasks({ limit: 'ten', filter: { priority: 'URGENT' } });
    assert.ok(errors.length >= 2, `expected several errors, got ${errors.length}`);
    assert.ok(errors.some((error) => /limit/.test(error.message)));
    assert.ok(errors.some((error) => /priority/.test(error.message)));
  });

  test('a well-formed call is untouched', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer({
      schema,
      executor: async (request) => {
        seen.push(request.variables);
        return { data: { tasks: [{ id: '1', title: 'ok' }] } };
      },
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: 'tasks',
      arguments: {
        limit: 2,
        filter: { title: 't', priority: 'LOW', steps: [{ name: 'a', order: 1 }] },
      },
    });
    assert.equal(parseResult(result).isError, false);
    assert.deepEqual(seen, [
      { limit: 2, filter: { title: 't', priority: 'LOW', steps: [{ name: 'a', order: 1 }] } },
    ]);
    await client.close();
  });

  test('a custom tool is checked the same way, and a no-argument one still runs', async () => {
    const server = createMcpServer({
      schema,
      executor: async () => ({ data: { tasks: [] } }),
      tools: [
        {
          name: 'ping',
          description: 'no arguments at all',
          handler: () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
        },
        {
          name: 'echo',
          description: 'takes a count',
          inputSchema: { count: z.number() },
          handler: (args) => ({ content: [{ type: 'text' as const, text: String(args.count) }] }),
        },
      ],
    });
    const client = await connect(server);

    const pong = (await client.callTool({ name: 'ping', arguments: {} })) as TextResult;
    assert.equal(pong.content[0].text, 'pong');

    const bad = (await client.callTool({
      name: 'echo',
      arguments: { count: 'two' },
    })) as TextResult;
    assert.equal(bad.isError, true);
    assert.equal(
      (JSON.parse(bad.content[0].text).errors as InputError[])[0].extensions?.code,
      'BAD_INPUT',
    );
    await client.close();
  });

  test('an unknown tool is still the SDK’s answer to give', async () => {
    // Nothing to validate against, and the SDK's message is already the right
    // one — the guard only replaces the body it can improve.
    const server = createMcpServer({ schema, executor: async () => ({ data: { tasks: [] } }) });
    const client = await connect(server);

    const result = (await client.callTool({ name: 'no_such_tool', arguments: {} })) as TextResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no_such_tool/);
    await client.close();
  });
});
