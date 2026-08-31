/**
 * Exercises createHttpHandler against a real Node HTTP server (no Express) using
 * the SDK's Streamable HTTP client — the same "side-by-side" path a host app
 * uses, minus the framework. A tiny handler parses the JSON body onto `req.body`
 * exactly as `express.json()` would — though the transport reads the request
 * stream itself when `req.body` is absent, which the last suite here pins down.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';
import { createHttpHandler, type McpHttpHandler, type McpHttpRequest } from './http.ts';

/** Hosts an MCP HTTP handler on an ephemeral port; returns the base URL + closer. */
async function host(handler: McpHttpHandler): Promise<{ url: URL; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      (req as McpHttpRequest).body = raw ? JSON.parse(raw) : undefined;
      handler(req as McpHttpRequest, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), close: () => server.close() };
}

/** The same host, with no body parser at all — `req.body` is never set. */
async function hostRaw(handler: McpHttpHandler): Promise<{ url: URL; close: () => void }> {
  const server = http.createServer((req, res) => {
    handler(req as McpHttpRequest, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), close: () => server.close() };
}

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('createHttpHandler', () => {
  let server: { url: URL; close: () => void };
  const seenContexts: unknown[] = [];

  before(async () => {
    const { schema, root } = makeTodoSchema();
    const localExecutor = createLocalExecutor(schema, { rootValue: root });
    const handler = createHttpHandler({
      schema,
      // Capture the per-request context so we can assert contextFromRequest works.
      executor: async (request) => {
        seenContexts.push(request.context);
        return localExecutor(request);
      },
      contextFromRequest: (req) => ({ auth: req.headers['x-test-user'] ?? null }),
    });
    server = await host(handler);
  });

  after(() => server.close());

  test('lists the schema tools over HTTP', async () => {
    const client = await connect(server.url);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'createTodo',
      'setCompleted',
      'todo',
      'todos',
    ]);
    await client.close();
  });

  test('calls a mutation then reads it back over HTTP', async () => {
    const client = await connect(server.url);
    const created = await client.callTool({
      name: 'createTodo',
      arguments: { input: { userId: 'u9', description: 'via http' } },
    });
    assert.equal((created as TextResult).isError, false);

    const readBack = await client.callTool({ name: 'todo', arguments: { id: 'todo-3' } });
    const data = JSON.parse((readBack as TextResult).content[0].text).data;
    assert.equal(data.todo.description, 'via http');
    await client.close();
  });

  test('derives per-request context from the HTTP request', async () => {
    seenContexts.length = 0;
    const client = await connect(server.url);
    await client.callTool({ name: 'todos', arguments: {} });
    // The executor saw a context built from contextFromRequest (auth header absent ⇒ null).
    assert.ok(
      seenContexts.some((ctx) => ctx !== undefined && (ctx as { auth: unknown }).auth === null),
    );
    await client.close();
  });
});

describe('createHttpHandler without a body parser', () => {
  // The docs used to require `express.json()`. The transport falls back to
  // reading the request stream when `req.body` is undefined, so a bare
  // `node:http` server works — worth pinning so the claim can't rot.
  let hosted: { url: URL; close: () => void };

  before(async () => {
    const { schema, root } = makeTodoSchema();
    hosted = await hostRaw(
      createHttpHandler({ schema, executor: createLocalExecutor(schema, { rootValue: root }) }),
    );
  });

  after(() => hosted.close());

  test('initialize and tools/list work with req.body unset', async () => {
    const client = await connect(hosted.url);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'todos'));
    await client.close();
  });

  test('a tool call round-trips too', async () => {
    const client = await connect(hosted.url);
    const result = (await client.callTool({ name: 'todos', arguments: {} })) as TextResult;
    const payload = JSON.parse(result.content[0].text) as { data: { todos: unknown[] } };
    assert.ok(payload.data.todos.length > 0);
    await client.close();
  });
});

describe('createHttpHandler with sessions', () => {
  let hosted: { url: URL; close: () => void };
  let handler: McpHttpHandler;
  // Every server closes over the request that built it, so the number of
  // distinct requests seen here is the number of servers in play.
  const seenRequests = new Set<unknown>();

  before(async () => {
    const { schema, root } = makeTodoSchema();
    handler = createHttpHandler({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      sessions: true,
      contextFromRequest: (req) => {
        seenRequests.add(req);
        return { auth: null };
      },
    });
    hosted = await host(handler);
  });

  after(async () => {
    await handler.close();
    hosted.close();
  });

  test('keeps one server across a session instead of one per request', async () => {
    seenRequests.clear();
    const client = await connect(hosted.url);
    await client.callTool({ name: 'todos', arguments: {} });
    await client.callTool({ name: 'todos', arguments: {} });
    // Two tool calls, five HTTP requests, one captured request: the server that
    // handled `initialize` is the one still answering — which is also why
    // `contextFromRequest` is documented as running against the initializing
    // request rather than the current one.
    assert.equal(seenRequests.size, 1);
    await client.close();
  });

  test('two clients get independent sessions', async () => {
    seenRequests.clear();
    const first = await connect(hosted.url);
    const second = await connect(hosted.url);
    await first.callTool({ name: 'todos', arguments: {} });
    await second.callTool({ name: 'todos', arguments: {} });
    assert.equal(seenRequests.size, 2);
    await first.close();
    await second.close();
  });

  test('an unknown session id is rejected with 404 so the client re-initializes', async () => {
    const response = await fetch(hosted.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32001);
    assert.match(body.error.message, /Session not found/);
  });

  test('a request with no session id and no initialize is refused', async () => {
    const response = await fetch(hosted.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    // The transport rejects it (400, not initialized) and the handler throws the
    // stray server away rather than leaving it in the table.
    assert.equal(response.status, 400);
  });

  test('a tool call still round-trips inside a session', async () => {
    const client = await connect(hosted.url);
    const result = (await client.callTool({ name: 'todos', arguments: {} })) as TextResult;
    const payload = JSON.parse(result.content[0].text) as { data: { todos: unknown[] } };
    assert.ok(payload.data.todos.length > 0);
    await client.close();
  });
});

describe('createHttpHandler close()', () => {
  test('is a no-op in stateless mode', async () => {
    const { schema, root } = makeTodoSchema();
    const handler = createHttpHandler({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
    });
    await handler.close();
  });

  test('ends live sessions', async () => {
    const { schema, root } = makeTodoSchema();
    const handler = createHttpHandler({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      sessions: { enableJsonResponse: true },
    });
    const hosted = await host(handler);
    const client = await connect(hosted.url);
    await client.listTools();

    await handler.close();
    // The session is gone, so the id the client still holds now 404s.
    await assert.rejects(() => client.listTools());
    await client.close().catch(() => {});
    hosted.close();
  });
});
