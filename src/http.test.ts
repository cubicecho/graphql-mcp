/**
 * Exercises createHttpHandler against a real Node HTTP server (no Express) using
 * the SDK's Streamable HTTP client — the same "side-by-side" path a host app
 * uses, minus the framework. A tiny handler parses the JSON body onto `req.body`
 * exactly as `express.json()` would.
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
