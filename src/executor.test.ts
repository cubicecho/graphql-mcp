import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHttpExecutor, createLocalExecutor } from './executor.ts';
import { makeTodoSchema } from './fixtures.test.ts';

describe('createLocalExecutor', () => {
  test('runs an operation in-process and returns data', async () => {
    const { schema, root } = makeTodoSchema();
    const exec = createLocalExecutor(schema, { rootValue: root });
    const result = await exec({
      query: 'query todo($id: String!) {\n  todo(id: $id) { id description __typename }\n}',
      variables: { id: 'todo-1' },
      operationName: 'todo',
    });
    assert.equal(result.errors, undefined);
    // graphql-js returns null-prototype objects; spread to a plain object to compare.
    assert.deepEqual(
      { ...(result.data?.todo as object) },
      { id: 'todo-1', description: 'write the wrapper', __typename: 'Todo' },
    );
  });

  test('surfaces GraphQL errors in the result', async () => {
    const { schema, root } = makeTodoSchema();
    const exec = createLocalExecutor(schema, { rootValue: root });
    // A missing required variable is a coercion error that `execute` reports.
    const result = await exec({
      query: 'query todo($id: String!) {\n  todo(id: $id) { id __typename }\n}',
      variables: {},
      operationName: 'todo',
    });
    assert.ok(result.errors?.length);
  });

  test('forwards per-call context as the GraphQL contextValue', async () => {
    const { schema } = makeTodoSchema();
    let seen: unknown;
    // A root that reads from context proves the value is threaded through.
    const exec = createLocalExecutor(schema, {
      rootValue: {
        todos: (_args: unknown, ctx: unknown) => {
          seen = ctx;
          return [];
        },
      },
    });
    await exec({
      query: 'query todos {\n  todos { id __typename }\n}',
      variables: {},
      operationName: 'todos',
      context: { userId: 'u1' },
    });
    assert.deepEqual(seen, { userId: 'u1' });
  });
});

describe('createHttpExecutor', () => {
  test('POSTs the operation and returns the parsed JSON', async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return {
        ok: true,
        json: async () => ({ data: { ping: 'pong' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const exec = createHttpExecutor('http://localhost/graphql', {
      fetch: fakeFetch,
      headers: (ctx) => ({ authorization: `Bearer ${(ctx as { token: string }).token}` }),
    });
    const result = await exec({
      query: 'query ping { ping }',
      variables: { a: 1 },
      operationName: 'ping',
      context: { token: 'abc' },
    });

    assert.deepEqual(result.data, { ping: 'pong' });
    assert.equal(captured?.url, 'http://localhost/graphql');
    assert.deepEqual(captured?.body, {
      query: 'query ping { ping }',
      variables: { a: 1 },
      operationName: 'ping',
    });
    assert.equal(captured?.headers.authorization, 'Bearer abc');
  });

  test('maps a non-OK HTTP response to a GraphQL error', async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      }) as Response) as unknown as typeof fetch;
    const exec = createHttpExecutor('http://localhost/graphql', { fetch: fakeFetch });
    const result = await exec({ query: '', variables: {}, operationName: 'x' });
    assert.match(result.errors?.[0]?.message ?? '', /502 Bad Gateway/);
  });
});
