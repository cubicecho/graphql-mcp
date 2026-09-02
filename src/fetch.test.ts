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
import { MemorySessionDirectory } from './sessions.ts';

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
function todoHandler(
  options: Partial<Parameters<typeof createFetchHandler>[0]> = {},
): McpFetchHandler {
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
  // Two handlers, one behaviour: the same assertion http.test.ts makes. The hook
  // has to run before the server is connected or the capability is never
  // advertised, and nothing about that is transport-specific.
  test('a decorateServer prompt is advertised and round-trips', async () => {
    const handler = todoHandler({
      decorateServer: (server) =>
        server.registerPrompt(
          'triage',
          { title: 'Triage', description: 'How to triage a todo.', argsSchema: {} },
          () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Triage it.' } }] }),
        ),
    });
    const client = await connect(handler);
    assert.ok(client.getServerCapabilities()?.prompts, 'prompts capability was not advertised');
    assert.equal((await client.getPrompt({ name: 'triage' })).messages.length, 1);
    await client.close();
    await handler.close();
  });

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

describe('createFetchHandler with a session directory', () => {
  /** A `tools/list` carrying a session id — the shape a misrouted request has. */
  function ask(sessionId: string): Request {
    return new Request('https://example.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  }

  test('names the instance holding a session that reached the wrong isolate', async () => {
    const directory = new MemorySessionDirectory();
    directory.claim('elsewhere', 'do-2');
    const handler = todoHandler({ sessions: { directory, instanceId: 'do-1' } });
    const response = await handler(ask('elsewhere'));
    // 404 either way — an McpServer cannot move — but one that says where to look.
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('mcp-session-owner'), 'do-2');
    const body = (await response.json()) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32001);
    assert.match(body.error.message, /held by 'do-2'/);
    await handler.close();
  });

  test('says only that the session is gone when nobody claims it', async () => {
    const handler = todoHandler({
      sessions: { directory: new MemorySessionDirectory(), instanceId: 'do-1' },
    });
    const response = await handler(ask('never-existed'));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('mcp-session-owner'), null);
    const body = (await response.json()) as { error: { message: string } };
    assert.equal(body.error.message, 'Session not found');
    await handler.close();
  });

  test('claims a live session for its instance and releases it on close', async () => {
    const directory = new MemorySessionDirectory();
    const handler = todoHandler({ sessions: { directory, instanceId: 'do-1' } });
    const client = await connect(handler);
    await client.listTools();
    assert.equal(directory.size, 1);
    await handler.close();
    assert.equal(directory.size, 0);
    await client.close().catch(() => {});
  });
});
