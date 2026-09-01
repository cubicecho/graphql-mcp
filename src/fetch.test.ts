/**
 * Exercises createFetchHandler with no network at all: the SDK client accepts a
 * custom `fetch`, so the handler is driven directly with `Request` objects the
 * way a Worker or Deno host would drive it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalExecutor } from './executor.ts';
import { createFetchHandler, type McpFetchHandler } from './fetch.ts';
import { makeTodoSchema } from './fixtures.test.ts';

const BASE = new URL('https://worker.test/mcp');

/** Connects a client that calls `handler` directly instead of going over a socket. */
async function connect(handler: McpFetchHandler): Promise<Client> {
  const client = new Client({ name: 'fetch-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(BASE, {
      fetch: (url, init) => handler(new Request(url, init)),
    }),
  );
  return client;
}

/** A handler over the todos fixture, with the executor already wired up. */
function todoHandler(options: { sessions?: boolean } = {}): McpFetchHandler {
  const { schema, root } = makeTodoSchema();
  return createFetchHandler({
    schema,
    executor: createLocalExecutor(schema, { rootValue: root }),
    ...options,
  });
}

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('createFetchHandler', () => {
  test('lists the schema tools', async () => {
    const handler = todoHandler();
    const client = await connect(handler);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'create_todo',
      'set_completed',
      'todo',
      'todos',
    ]);
    await client.close();
    await handler.close();
  });

  test('runs a tool and returns the JSON envelope', async () => {
    const handler = todoHandler();
    const client = await connect(handler);
    const result = (await client.callTool({ name: 'todos', arguments: {} })) as TextResult;
    const payload = JSON.parse(result.content[0].text) as { data: { todos: unknown[] } };
    assert.ok(payload.data.todos.length > 0);
    await client.close();
    await handler.close();
  });

  test('derives context from the Request', async () => {
    const seen: unknown[] = [];
    const { schema, root } = makeTodoSchema();
    const local = createLocalExecutor(schema, { rootValue: root });
    const handler = createFetchHandler({
      schema,
      executor: async (request) => {
        seen.push(request.context);
        return local(request);
      },
      contextFromRequest: (request) => ({ auth: request.headers.get('x-test-user') }),
    });
    const client = new Client({ name: 'fetch-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(BASE, {
        fetch: (url, init) => {
          const request = new Request(url, init);
          request.headers.set('x-test-user', 'u7');
          return handler(request);
        },
      }),
    );
    await client.callTool({ name: 'todos', arguments: {} });
    assert.ok(seen.some((ctx) => (ctx as { auth: unknown }).auth === 'u7'));
    await client.close();
    await handler.close();
  });

  test('answers a stateless request with no session header', async () => {
    const handler = todoHandler();
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '0' },
          },
        }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    await handler.close();
  });
});

describe('createFetchHandler with sessions', () => {
  test('issues a session id and reuses one server across it', async () => {
    const seenRequests = new Set<unknown>();
    const { schema, root } = makeTodoSchema();
    const handler = createFetchHandler({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      sessions: true,
      contextFromRequest: (request) => {
        seenRequests.add(request);
        return { auth: null };
      },
    });
    const client = await connect(handler);
    await client.callTool({ name: 'todos', arguments: {} });
    await client.callTool({ name: 'todos', arguments: {} });
    assert.equal(seenRequests.size, 1);
    await client.close();
    await handler.close();
  });

  test('rejects an unknown session id with 404', async () => {
    const handler = todoHandler({ sessions: true });
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': 'no-such-session',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32001);
    await handler.close();
  });

  test('close() ends the session so its id stops resolving', async () => {
    const handler = todoHandler({ sessions: true });
    const client = await connect(handler);
    await client.listTools();
    await handler.close();
    await assert.rejects(() => client.listTools());
    await client.close().catch(() => {});
  });
});
