/**
 * Covers the replay buffer's bounds and its ordering guarantee. The interesting
 * behaviour is at the edges — what happens after an event ages out, and whether
 * an aged-out id is reported as missing rather than replayed as a partial
 * stream — because that is the difference between a client that knows it has to
 * start over and one that silently believes it caught up.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_MAX_EVENTS_PER_STREAM,
  DEFAULT_MAX_STREAMS,
  type EventStore,
  eventStoreFactory,
  MemoryEventStore,
} from './eventStore.ts';

/** A distinguishable JSON-RPC message. */
function note(n: number): JSONRPCMessage {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: { n } } as JSONRPCMessage;
}

/** Replays a stream from an id, collecting what the transport would have sent. */
async function replay(
  store: EventStore,
  lastEventId: string,
): Promise<{ streamId: string; sent: Array<[string, JSONRPCMessage]> }> {
  const sent: Array<[string, JSONRPCMessage]> = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async (eventId, message) => {
      sent.push([eventId, message]);
    },
  });
  return { streamId, sent };
}

describe('MemoryEventStore', () => {
  test('replays only what came after the given id', async () => {
    const store = new MemoryEventStore();
    const ids = [];
    for (let n = 0; n < 4; n++) ids.push(await store.storeEvent('s', note(n)));

    const { streamId, sent } = await replay(store, ids[1]);
    assert.equal(streamId, 's');
    assert.deepEqual(
      sent.map(([, message]) => message),
      [note(2), note(3)],
    );
    assert.deepEqual(
      sent.map(([id]) => id),
      [ids[2], ids[3]],
    );
  });

  test('replays nothing when the last id is the latest', async () => {
    const store = new MemoryEventStore();
    const id = await store.storeEvent('s', note(0));
    assert.deepEqual((await replay(store, id)).sent, []);
  });

  test('keeps streams apart', async () => {
    const store = new MemoryEventStore();
    const first = await store.storeEvent('a', note(0));
    await store.storeEvent('b', note(1));
    await store.storeEvent('a', note(2));
    await store.storeEvent('b', note(3));

    const { streamId, sent } = await replay(store, first);
    assert.equal(streamId, 'a');
    assert.deepEqual(
      sent.map(([, message]) => message),
      [note(2)],
    );
  });

  test('an event id resolves to its own stream', async () => {
    const store = new MemoryEventStore();
    const a = await store.storeEvent('a', note(0));
    const b = await store.storeEvent('b', note(1));
    assert.equal(await store.getStreamIdForEventId(a), 'a');
    assert.equal(await store.getStreamIdForEventId(b), 'b');
    assert.equal(await store.getStreamIdForEventId('nope'), undefined);
  });

  test('drops the oldest events past the per-stream cap', async () => {
    const store = new MemoryEventStore({ maxEventsPerStream: 3 });
    const ids = [];
    for (let n = 0; n < 5; n++) ids.push(await store.storeEvent('s', note(n)));

    assert.equal(store.size, 3);
    const { sent } = await replay(store, ids[2]);
    assert.deepEqual(
      sent.map(([, message]) => message),
      [note(3), note(4)],
    );
  });

  test('an aged-out id reads as unknown rather than as a partial stream', async () => {
    const store = new MemoryEventStore({ maxEventsPerStream: 2 });
    const first = await store.storeEvent('s', note(0));
    for (let n = 1; n < 4; n++) await store.storeEvent('s', note(n));

    // The transport asks this before replaying, and answers a miss with a 400 —
    // which is the honest answer, because the events between `first` and the
    // survivors are gone and no replay could fill the gap.
    assert.equal(await store.getStreamIdForEventId(first), undefined);
    await assert.rejects(() => replay(store, first), /unknown event id/);
  });

  test('drops the least-recently-written stream past the stream cap', async () => {
    const store = new MemoryEventStore({ maxStreams: 2 });
    const a = await store.storeEvent('a', note(0));
    const b = await store.storeEvent('b', note(1));
    // Writing to 'a' again makes 'b' the oldest, so 'c' evicts 'b', not 'a'.
    await store.storeEvent('a', note(2));
    const c = await store.storeEvent('c', note(3));

    assert.equal(store.streamCount, 2);
    assert.equal(await store.getStreamIdForEventId(a), 'a');
    assert.equal(await store.getStreamIdForEventId(c), 'c');
    assert.equal(await store.getStreamIdForEventId(b), undefined);
  });

  test('event ids are unique across streams', async () => {
    const store = new MemoryEventStore();
    const ids = new Set<string>();
    for (let n = 0; n < 20; n++) ids.add(await store.storeEvent(n % 3 === 0 ? 'a' : 'b', note(n)));
    assert.equal(ids.size, 20);
  });

  test('clear empties every buffer', async () => {
    const store = new MemoryEventStore();
    const id = await store.storeEvent('s', note(0));
    store.clear();
    assert.equal(store.size, 0);
    assert.equal(store.streamCount, 0);
    assert.equal(await store.getStreamIdForEventId(id), undefined);
  });

  test('the defaults are the documented bounds', async () => {
    const store = new MemoryEventStore();
    for (let n = 0; n < DEFAULT_MAX_EVENTS_PER_STREAM + 5; n++)
      await store.storeEvent('s', note(n));
    assert.equal(store.size, DEFAULT_MAX_EVENTS_PER_STREAM);

    const streams = new MemoryEventStore();
    for (let n = 0; n < DEFAULT_MAX_STREAMS + 3; n++) await streams.storeEvent(`s${n}`, note(n));
    assert.equal(streams.streamCount, DEFAULT_MAX_STREAMS);
  });
});

describe('eventStoreFactory', () => {
  test('defaults to a fresh bounded store per session', () => {
    const make = eventStoreFactory();
    const first = make();
    const second = make();
    assert.ok(first instanceof MemoryEventStore);
    // Separate stores: one session's reconnect must not replay another's events.
    assert.notEqual(first, second);
  });

  test('false turns resumability off', () => {
    assert.equal(eventStoreFactory(false)(), undefined);
  });

  test('an options object tunes the bounds', async () => {
    const store = eventStoreFactory({ maxEventsPerStream: 1 })() as MemoryEventStore;
    await store.storeEvent('s', note(0));
    await store.storeEvent('s', note(1));
    assert.equal(store.size, 1);
  });

  test('a factory supplies your own store, once per session', () => {
    const made: EventStore[] = [];
    const make = eventStoreFactory(() => {
      const store = new MemoryEventStore();
      made.push(store);
      return store;
    });
    make();
    make();
    assert.equal(made.length, 2);
  });
});
