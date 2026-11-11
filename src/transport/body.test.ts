/** The capped body reader behind both handlers' `maxBodyBytes`, driven with chunks rather than a socket. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readJsonBody, streamChunks } from './body.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Yields `parts`, counting how many were pulled. */
function counted(parts: Uint8Array[]): { chunks: AsyncIterable<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  return {
    chunks: (async function* () {
      for (const part of parts) {
        pulled++;
        yield part;
      }
    })(),
    pulled: () => pulled,
  };
}

describe('readJsonBody', () => {
  test('a body split across chunks is joined and parsed', async () => {
    const { chunks } = counted([encode('{"a":'), encode('[1,2]}')]);
    assert.deepEqual(await readJsonBody(chunks, undefined, 100), { body: { a: [1, 2] } });
  });

  test('a declared length over the cap is refused before anything is read', async () => {
    const { chunks, pulled } = counted([encode('{}')]);
    const reading = await readJsonBody(chunks, '5000', 100);
    assert.ok('refusal' in reading);
    assert.equal(reading.refusal.status, 413);
    assert.equal(pulled(), 0);
  });

  test('reading stops at the chunk that passes the cap', async () => {
    const { chunks, pulled } = counted([encode('x'.repeat(60)), encode('x'.repeat(60)), encode('x')]);
    const reading = await readJsonBody(chunks, undefined, 100);
    assert.ok('refusal' in reading);
    assert.equal(reading.refusal.status, 413);
    assert.equal(pulled(), 2);
  });

  test('an empty body and a malformed one are both the SDK’s parse error', async () => {
    for (const parts of [[], [encode('{oops')]]) {
      const reading = await readJsonBody(counted(parts).chunks, undefined, 100);
      assert.ok('refusal' in reading);
      assert.equal(reading.refusal.status, 400);
      assert.deepEqual(JSON.parse(reading.refusal.body), {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null,
      });
    }
  });
});

describe('streamChunks', () => {
  test('a stream stopped early is cancelled', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encode('x'.repeat(80)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reading = await readJsonBody(streamChunks(stream), null, 100);
    assert.ok('refusal' in reading);
    assert.equal(cancelled, true);
  });

  test('a request without a body has no chunks', async () => {
    const seen: Uint8Array[] = [];
    for await (const chunk of streamChunks(null)) {
      seen.push(chunk);
    }
    assert.deepEqual(seen, []);
  });
});
