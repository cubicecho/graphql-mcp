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
import { MemorySessionDirectory, type SessionDirectory } from './sessions.ts';

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
      'create_todo',
      'set_completed',
      'todo',
      'todos',
    ]);
    await client.close();
  });

  test('calls a mutation then reads it back over HTTP', async () => {
    const client = await connect(server.url);
    const created = await client.callTool({
      name: 'create_todo',
      arguments: { input: { userId: 'u9', description: 'via http' } },
    });
    assert.equal((created as TextResult).isError, false);

    const readBack = await client.callTool({ name: 'todo', arguments: { id: 'todo-3' } });
    const data = JSON.parse((readBack as TextResult).content[0].text).data;
    assert.equal(data.todo.description, 'via http');
    await client.close();
  });

  // Every argument of `todos` is optional, so a client has nothing to put in
  // `params.arguments` and the MCP schema lets it leave the key out entirely.
  test('a call that omits its arguments is answered, not rejected', async () => {
    const client = await connect(server.url);
    const result = await client.callTool({ name: 'todos' });
    assert.equal((result as TextResult).isError, false);
    assert.ok(JSON.parse((result as TextResult).content[0].text).data.todos.length > 0);
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

describe('createHttpHandler with decorateServer', () => {
  // The hook is the only window in which a prompt can declare its capability:
  // the SDK refuses to register one once a transport is attached, and the
  // handler connects each server the moment it is minted. Asserted over real
  // HTTP because that is the path a host app takes.
  let hosted: { url: URL; close: () => void };

  before(async () => {
    const { schema, root } = makeTodoSchema();
    hosted = await host(
      createHttpHandler({
        schema,
        executor: createLocalExecutor(schema, { rootValue: root }),
        decorateServer: (server) =>
          server.registerPrompt(
            'triage',
            { title: 'Triage', description: 'How to triage a todo.', argsSchema: {} },
            () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Triage it.' } }] }),
          ),
      }),
    );
  });

  after(() => hosted.close());

  test('the prompt capability survives initialize', async () => {
    const client = await connect(hosted.url);
    assert.ok(client.getServerCapabilities()?.prompts, 'prompts capability was not advertised');
    await client.close();
  });

  test('and the prompt round-trips', async () => {
    const client = await connect(hosted.url);
    const { messages } = await client.getPrompt({ name: 'triage' });
    assert.equal(messages.length, 1);
    await client.close();
  });

  test('the generated tools are untouched', async () => {
    const client = await connect(hosted.url);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'create_todo',
      'set_completed',
      'todo',
      'todos',
    ]);
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

  test('and so does one that omits its arguments', async () => {
    const client = await connect(hosted.url);
    const result = await client.callTool({ name: 'todos' });
    assert.equal((result as TextResult).isError, false);
    await client.close();
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

/**
 * A dropped SSE stream and a reconnect claiming `Last-Event-ID`, driven over raw
 * HTTP rather than through the SDK client — the client reconnects on its own
 * schedule, and the point here is what the *server* does when it is asked to
 * resume. See `eventStore.ts`.
 */
describe('resuming a dropped stream', () => {
  const PROTOCOL = '2025-11-25';
  const INITIALIZE = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'resume-test', version: '0.0.0' },
    },
  });

  interface RawResponse {
    status: number;
    sessionId?: string;
    /** The first SSE event, or `'<timeout>'` if the stream sent nothing. */
    first: string;
    /** Drops the connection, as a flaky network would. */
    abort(): void;
  }

  /** One request, resolved as soon as the first bytes of the body land. */
  function raw(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers }, (res) => {
        let settled = false;
        const done = (first: string) => {
          if (settled) return;
          settled = true;
          const sessionId = res.headers['mcp-session-id'];
          resolve({
            status: res.statusCode ?? 0,
            sessionId: Array.isArray(sessionId) ? sessionId[0] : sessionId,
            first,
            abort: () => req.destroy(),
          });
        };
        res.on('data', (chunk) => done(String(chunk)));
        res.on('end', () => done(''));
        // A stream that stays open with nothing to say is the interesting
        // answer in the no-replay case, so it resolves rather than hanging.
        setTimeout(() => done('<timeout>'), 750).unref();
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * Initializes a session and drops the connection the instant the first event
   * arrives — the response to `initialize` is still in flight at that point,
   * which is exactly the work a replay buffer exists to save.
   */
  async function initializeThenDrop(url: URL) {
    const init = await raw(
      url,
      'POST',
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE,
    );
    init.abort();
    return { ...init, eventId: /^id: (.*)$/m.exec(init.first)?.[1] };
  }

  function reconnect(url: URL, sessionId: string, lastEventId: string) {
    return raw(url, 'GET', {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL,
      accept: 'text/event-stream',
      'last-event-id': lastEventId,
    });
  }

  /**
   * Runs `body` against a stateful handler and always tears it down — a failed
   * assertion would otherwise leave an HTTP server listening and an SSE stream
   * open, and the test process would hang instead of reporting the failure.
   */
  async function withSessions(
    replay: boolean | undefined,
    body: (url: URL) => Promise<void>,
  ): Promise<void> {
    const { schema, root } = makeTodoSchema();
    const handler = createHttpHandler({
      schema,
      executor: createLocalExecutor(schema, { rootValue: root }),
      sessions: replay === undefined ? true : { replay },
    });
    const hosted = await host(handler);
    try {
      await body(hosted.url);
    } finally {
      hosted.close();
      await handler.close();
    }
  }

  test('a reconnect replays the reply the dropped connection never delivered', async () => {
    await withSessions(undefined, async (url) => {
      const dropped = await initializeThenDrop(url);
      // The stream opens with a priming event, which is the id to resume from.
      assert.ok(dropped.eventId, `expected an event id, got ${JSON.stringify(dropped.first)}`);

      const resumed = await reconnect(url, dropped.sessionId ?? '', dropped.eventId);
      assert.equal(resumed.status, 200);
      // The `initialize` result, which the client never saw the first time.
      assert.match(resumed.first, /"protocolVersion"/);
      resumed.abort();
    });
  });

  test('without replay the stream carries no event id to resume from', async () => {
    await withSessions(false, async (url) => {
      const dropped = await initializeThenDrop(url);
      assert.equal(dropped.eventId, undefined);
      // And the reply it was carrying is simply gone: reconnecting opens a
      // fresh, silent stream rather than catching the client up.
      const resumed = await reconnect(url, dropped.sessionId ?? '', '1');
      assert.equal(resumed.first, '<timeout>');
      resumed.abort();
    });
  });

  test('an unresumable id is refused rather than answered with a silent stream', async () => {
    await withSessions(undefined, async (url) => {
      const dropped = await initializeThenDrop(url);
      const resumed = await reconnect(url, dropped.sessionId ?? '', 'aged-out');
      // 400, so the client knows to start over; without a store the same
      // request gets a 200 and no events, which it cannot tell from "nothing
      // happened".
      assert.equal(resumed.status, 400);
      resumed.abort();
    });
  });
});

describe('createHttpHandler with a session directory', () => {
  const { schema, root } = makeTodoSchema();
  const executor = createLocalExecutor(schema, { rootValue: root });

  /**
   * Hosts a session-mode handler that shares `directory` with the rest of the
   * fleet, as `web-1`. Everything runs in one process — the point is not to
   * simulate a load balancer but to pin down what an instance says about a
   * session id it does not hold.
   */
  async function withInstance(
    directory: SessionDirectory,
    body: (url: URL) => Promise<void>,
  ): Promise<void> {
    const handler = createHttpHandler({
      schema,
      executor,
      sessions: { directory, instanceId: 'web-1' },
    });
    const hosted = await host(handler);
    try {
      await body(hosted.url);
    } finally {
      await handler.close();
      hosted.close();
    }
  }

  /** A `tools/list` carrying a session id, which is the misrouting a client shows. */
  function ask(url: URL, sessionId: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  }

  test('names the instance holding a session that landed on the wrong one', async () => {
    const directory = new MemorySessionDirectory();
    directory.claim('elsewhere', 'web-2');
    await withInstance(directory, async (url) => {
      const response = await ask(url, 'elsewhere');
      // Still 404: an McpServer cannot move, so there is nothing to forward to
      // and the client's correct move is to initialize again. The owner is the
      // diagnosis, not a redirect.
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('mcp-session-owner'), 'web-2');
      const body = (await response.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.code, -32001);
      assert.match(body.error.message, /held by 'web-2'/);
    });
  });

  test('says only that the session is gone when the directory has no claim', async () => {
    await withInstance(new MemorySessionDirectory(), async (url) => {
      const response = await ask(url, 'never-existed');
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('mcp-session-owner'), null);
      const body = (await response.json()) as { error: { message: string } };
      assert.equal(body.error.message, 'Session not found');
    });
  });

  test('does not blame itself for a session it evicted', async () => {
    // The claim outlived the session it described. Reporting `web-1` would send
    // an operator back to the instance the request already reached.
    const directory = new MemorySessionDirectory();
    directory.claim('stale', 'web-1');
    await withInstance(directory, async (url) => {
      const response = await ask(url, 'stale');
      assert.equal(response.headers.get('mcp-session-owner'), null);
      const body = (await response.json()) as { error: { message: string } };
      assert.equal(body.error.message, 'Session not found');
      assert.equal(directory.owner('stale'), undefined);
    });
  });

  test('a live session is claimed for its instance and released on DELETE', async () => {
    const directory = new MemorySessionDirectory();
    await withInstance(directory, async (url) => {
      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: 'directory-test', version: '0.0.0' });
      await client.connect(transport);
      const sessionId = transport.sessionId;
      assert.ok(sessionId, 'initialize should have minted a session id');
      assert.equal(directory.owner(sessionId), 'web-1');

      // DELETE ends the session, which is the path that has to give the claim
      // back — otherwise the directory keeps pointing at a session that is gone.
      await transport.terminateSession();
      assert.equal(directory.owner(sessionId), undefined);
      await client.close();
    });
  });
});
