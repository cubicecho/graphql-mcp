import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  clamp,
  DEFAULT_MAX_CHARS,
  runExecutor,
  type TruncationRecord,
  text,
  toCallToolResult,
} from './result.ts';

/** The tool's text body — `content[0]` is always a text block here. */
function bodyOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function payloadOf(result: CallToolResult) {
  return JSON.parse(bodyOf(result));
}

describe('toCallToolResult failure signalling', () => {
  test('a clean result is not an error and carries no errors key', () => {
    const result = toCallToolResult({ data: { todo: { id: '1' } } });
    assert.equal(result.isError, false);
    const payload = payloadOf(result);
    assert.deepEqual(payload.data, { todo: { id: '1' } });
    assert.equal('errors' in payload, false);
    assert.equal('note' in payload, false);
  });

  test('errors with no data are a real failure', () => {
    const result = toCallToolResult({ data: null, errors: [{ message: 'boom' }] });
    assert.equal(result.isError, true);
    assert.equal(payloadOf(result).errors[0].message, 'boom');
  });

  test('an absent data key (transport error) is a real failure', () => {
    const result = toCallToolResult({ errors: [{ message: 'endpoint responded 500' }] });
    assert.equal(result.isError, true);
    assert.equal('data' in payloadOf(result), false);
  });

  test('partial data is NOT flagged as an error, so an agent keeps using it', () => {
    const result = toCallToolResult({
      data: { items: [{ id: 'a' }, { id: 'b', boom: null }] },
      errors: [{ message: 'resolver exploded', path: ['items', 1, 'boom'] }],
    });
    assert.equal(result.isError, false);
    const payload = payloadOf(result);
    // The usable rows survive alongside the error.
    assert.deepEqual(payload.data.items, [{ id: 'a' }, { id: 'b', boom: null }]);
    assert.equal(payload.errors.length, 1);
    assert.match(payload.note, /Partial result/);
  });

  test('a nullable root field that threw is a failure, despite data being present', () => {
    // GraphQL yields `data: { boom: null }` here — an object, but nothing usable.
    const result = toCallToolResult({ data: { boom: null }, errors: [{ message: 'exploded' }] });
    assert.equal(result.isError, true);
    assert.equal('note' in payloadOf(result), false);
  });

  test('one usable root field among nulls still counts as partial', () => {
    const result = toCallToolResult({
      data: { a: null, b: { id: '1' } },
      errors: [{ message: 'a failed' }],
    });
    assert.equal(result.isError, false);
    assert.match(payloadOf(result).note, /Partial result/);
  });

  test('data present with no errors gets no partial note', () => {
    const result = toCallToolResult({ data: { a: 1 } });
    assert.equal('note' in payloadOf(result), false);
  });
});

describe('toCallToolResult error condensing', () => {
  const raw = {
    data: null,
    errors: [
      {
        message: 'Unauthorized',
        // Line/column into a query string the agent never wrote.
        locations: [{ line: 2, column: 14 }],
        path: ['viewer'],
        extensions: { code: 'UNAUTHENTICATED' },
      },
    ],
  };

  test('drops locations, which point into a query the agent cannot see', () => {
    const error = payloadOf(toCallToolResult(raw)).errors[0];
    assert.equal('locations' in error, false);
  });

  test('keeps message, path, and extensions', () => {
    const error = payloadOf(toCallToolResult(raw)).errors[0];
    assert.equal(error.message, 'Unauthorized');
    assert.deepEqual(error.path, ['viewer']);
    assert.deepEqual(error.extensions, { code: 'UNAUTHENTICATED' });
  });

  test('drops an empty extensions object, which graphql-js sets on every error', () => {
    // A real `GraphQLError` from the local executor always carries `extensions`,
    // so a truthiness check would put `"extensions": {}` on every failure.
    const error = payloadOf(
      toCallToolResult({
        data: null,
        errors: [{ message: 'kaboom', path: ['boom'], extensions: {} }],
      }),
    ).errors[0];
    assert.deepEqual(error, { message: 'kaboom', path: ['boom'] });
  });

  test('drops an empty path array too', () => {
    const error = payloadOf(
      toCallToolResult({ data: null, errors: [{ message: 'kaboom', path: [] }] }),
    ).errors[0];
    assert.deepEqual(error, { message: 'kaboom' });
  });

  test('omits path and extensions when absent rather than emitting nulls', () => {
    const error = payloadOf(toCallToolResult({ data: null, errors: [{ message: 'plain' }] }))
      .errors[0];
    assert.deepEqual(error, { message: 'plain' });
  });
});

describe('toCallToolResult size clamping', () => {
  test('a large result drops rows and says how many, and still parses', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}`, blob: 'x'.repeat(100) }));
    const result = toCallToolResult({ data: { rows } }, 2_000);
    const body = bodyOf(result);
    assert.ok(body.length <= 2_000, `expected a body inside the budget, got ${body.length}`);
    // The point of the whole exercise: a client can still parse it. Slicing the
    // serialization cut mid-token, so the body a `JSON.parse` client got back
    // was a `SyntaxError` rather than either the rows or the advice.
    const payload = payloadOf(result) as { data: { rows: unknown[] }; truncated: TruncationRecord };
    assert.ok(payload.data.rows.length > 0, 'kept no rows at all');
    assert.ok(payload.data.rows.length < 500, 'dropped nothing');
    // Counted, not just flagged: an agent needs the scale to judge whether to
    // page or to narrow, and every row it did get is a whole row.
    assert.equal(payload.truncated.droppedItems, 500 - payload.data.rows.length);
    assert.equal(payload.truncated.totalItems, 500);
    assert.deepEqual(payload.data.rows[0], { id: 'row-0', blob: 'x'.repeat(100) });
    assert.equal(result.isError, false);
  });

  test('rows are dropped evenly, so the result keeps its shape', () => {
    // Draining the biggest collection first would leave one field full and the
    // other empty, which reads as though the second returned nothing.
    const some = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) => ({ id: `${prefix}-${i}` }));
    const result = toCallToolResult({ data: { tasks: some('task'), runs: some('run') } }, 2_000);
    const data = (payloadOf(result) as { data: { tasks: unknown[]; runs: unknown[] } }).data;
    assert.ok(data.tasks.length > 0 && data.runs.length > 0);
    assert.equal(data.tasks.length, data.runs.length);
  });

  test('a payload with nothing to drop omits data rather than cutting the JSON', () => {
    // One enormous scalar: no rows to shed, so the honest answer is to say so.
    const result = toCallToolResult({ data: { blob: 'x'.repeat(5_000) } }, 500);
    const payload = payloadOf(result) as { data?: unknown; truncated: TruncationRecord };
    assert.equal(payload.data, undefined);
    assert.equal(payload.truncated.dataOmitted, true);
    assert.match(payload.truncated.advice, /narrow the query/);
  });

  test('a result within budget is left untouched and stays parseable', () => {
    const result = toCallToolResult({ data: { a: 1 } }, DEFAULT_MAX_CHARS);
    assert.deepEqual(payloadOf(result).data, { a: 1 });
    assert.equal((payloadOf(result) as { truncated?: unknown }).truncated, undefined);
  });
});

describe('a clamped result keeps its diagnostics', () => {
  const rows = () =>
    Array.from({ length: 400 }, (_, i) => ({ id: `row-${i}`, blob: 'y'.repeat(80) }));

  test('errors survive a clamp, and so does the failure flag', () => {
    // `errors` serializes after `data`, so a clamp that sliced the string threw
    // away the whole reason the call failed and left `isError` pointing at a
    // body that no longer said anything about it.
    const result = toCallToolResult(
      { data: null, errors: [{ message: 'permission denied', extensions: { code: 'FORBIDDEN' } }] },
      2_000,
    );
    const payload = payloadOf(result) as { errors: Array<Record<string, unknown>> };
    assert.equal(result.isError, true);
    assert.equal(payload.errors[0].message, 'permission denied');
    assert.deepEqual(payload.errors[0].extensions, { code: 'FORBIDDEN' });
  });

  test('a partial result keeps both its note and its errors after clamping', () => {
    const result = toCallToolResult(
      { data: { rows: rows() }, errors: [{ message: 'owner resolver failed', path: ['rows', 3] }] },
      2_000,
    );
    const payload = payloadOf(result) as {
      data: { rows: unknown[] };
      errors: unknown[];
      note: string;
      truncated: TruncationRecord;
    };
    // Partial success: rows came back, so this is not a failure — but the agent
    // has to be told the nulls it sees are failures and not absent data.
    assert.equal(result.isError, false);
    assert.match(payload.note, /Partial result/);
    assert.equal(payload.errors.length, 1);
    assert.ok(payload.data.rows.length > 0);
    assert.equal(payload.truncated.totalItems, 400);
  });

  test('every clamped body parses, across a range of budgets', () => {
    // The bisection lands on a different row count at each budget; none of them
    // may produce a body a client cannot read.
    for (const budget of [80, 200, 500, 1_000, 5_000, 20_000]) {
      const result = toCallToolResult({ data: { rows: rows() } }, budget);
      assert.doesNotThrow(
        () => JSON.parse(bodyOf(result)),
        `budget ${budget} produced unparseable JSON`,
      );
    }
  });

  test('a clamp rewrites objects but leaves non-plain values alone', () => {
    // A `Date` (or any class instance) walked field-by-field would come back as
    // `{}` instead of its serialized form.
    const when = new Date('2020-01-01T00:00:00.000Z');
    const result = toCallToolResult({ data: { when, rows: rows() } }, 2_000);
    assert.equal((payloadOf(result) as { data: { when: string } }).data.when, when.toISOString());
  });
});

describe('clamp and text', () => {
  test('clamp returns short input unchanged', () => {
    assert.equal(clamp('short', 100), 'short');
  });

  test('clamp reports the exact overflow', () => {
    const clamped = clamp('a'.repeat(30), 10);
    assert.match(clamped, /truncated 20 of 30 characters/);
    assert.ok(clamped.startsWith('a'.repeat(10)));
  });

  test('text wraps a body as a non-error tool result', () => {
    assert.deepEqual(text('hello'), { content: [{ type: 'text', text: 'hello' }] });
  });
});

describe('runExecutor', () => {
  const request = { query: '{ a }', variables: {} };

  test('passes a successful result straight through', async () => {
    const result = await runExecutor(async () => ({ data: { a: 1 } }), request);
    assert.deepEqual(result, { data: { a: 1 } });
  });

  test('a thrown Error becomes a GraphQL result, so the body stays parseable JSON', async () => {
    const result = await runExecutor(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:4000');
    }, request);
    assert.deepEqual(result, { errors: [{ message: 'ECONNREFUSED 127.0.0.1:4000' }] });
    // The whole point: this still round-trips through the normal formatter.
    const body = bodyOf(toCallToolResult(result));
    assert.equal(JSON.parse(body).errors[0].message, 'ECONNREFUSED 127.0.0.1:4000');
  });

  test('a thrown non-Error is reported by its string form', async () => {
    const result = await runExecutor(async () => {
      throw 'gateway timeout';
    }, request);
    assert.deepEqual(result, { errors: [{ message: 'gateway timeout' }] });
  });

  test('a thrown value with no usable message still says something', async () => {
    const result = await runExecutor(async () => {
      throw {};
    }, request);
    assert.match((result.errors ?? [])[0].message, /executor failed/);
  });
});

describe('runExecutor request shaping', () => {
  test('fills in empty variables, so a caller can pass just a query', async () => {
    let seen: unknown;
    await runExecutor(
      async (request) => {
        seen = request.variables;
        return { data: {} };
      },
      { query: '{ a }' },
    );
    assert.deepEqual(seen, {});
  });

  test('passes given variables and the rest of the request through untouched', async () => {
    let seen: unknown;
    await runExecutor(
      async (request) => {
        seen = request;
        return { data: {} };
      },
      { query: '{ a }', variables: { id: '1' }, operationName: 'A', context: { token: 't' } },
    );
    assert.deepEqual(seen, {
      query: '{ a }',
      variables: { id: '1' },
      operationName: 'A',
      context: { token: 't' },
    });
  });
});

describe('truncation hints', () => {
  test('clamp appends a hint to the note', () => {
    const clamped = clamp('a'.repeat(30), 10, 'This field paginates: pass `first`.');
    assert.match(clamped, /narrow the query or request fewer fields\. This field paginates/);
  });

  test('a short value is returned unchanged even with a hint', () => {
    assert.equal(clamp('short', 100, 'ignored'), 'short');
  });

  test('toCallToolResult passes the hint through to the truncation record', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}` }));
    const result = toCallToolResult({ data: { rows } }, 200, 'This field paginates: pass `first`.');
    assert.match(bodyOf(result), /This field paginates: pass `first`\./);
  });

  test('a result inside the budget carries no note and so no hint', () => {
    const result = toCallToolResult({ data: { ok: true } }, 10_000, 'This field paginates.');
    assert.doesNotMatch(bodyOf(result), /paginates/);
  });
});
