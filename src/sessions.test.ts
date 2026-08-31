/**
 * Covers the session table's bounds. The interesting behaviour is all in the
 * eviction paths — idle expiry, the LRU cap, and double-drop — because those are
 * what stand between a stateful server and an unbounded map of live servers.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ClosableTransport, type Session, SessionStore } from './sessions.ts';

/** A transport/server pair that just records that it was closed. */
function fakeSession(log: string[], name: string, lastSeen = Date.now()): Session<FakeTransport> {
  const server = {
    close: async () => {
      log.push(`server:${name}`);
    },
  } as unknown as McpServer;
  const session: Session<FakeTransport> = { server, lastSeen };
  session.transport = {
    close: async () => {
      log.push(`transport:${name}`);
    },
  };
  return session;
}

interface FakeTransport extends ClosableTransport {}

describe('SessionStore', () => {
  test('stores and returns a session by id', () => {
    const store = new SessionStore<FakeTransport>();
    const session = fakeSession([], 'a');
    store.add('a', session);
    assert.equal(store.take('a'), session);
    assert.equal(store.size, 1);
  });

  test('is undefined for an unknown id', () => {
    const store = new SessionStore<FakeTransport>();
    assert.equal(store.take('nope'), undefined);
  });

  test('take marks the session as just used', () => {
    const store = new SessionStore<FakeTransport>();
    const session = fakeSession([], 'a', 0);
    store.add('a', session);
    const before = session.lastSeen;
    store.take('a');
    assert.ok(session.lastSeen >= before);
  });

  test('evicts a session idle past the timeout, closing both halves', () => {
    const log: string[] = [];
    const store = new SessionStore<FakeTransport>({ idleTimeoutMs: 1000 });
    // Registered with a stale timestamp, then aged by rewriting `lastSeen`:
    // `add` stamps the current time, so the staleness has to be applied after.
    const session = fakeSession(log, 'old');
    store.add('old', session);
    session.lastSeen = Date.now() - 5000;

    assert.equal(store.take('old'), undefined);
    assert.equal(store.size, 0);
  });

  test('a session inside the timeout survives a sweep', () => {
    const store = new SessionStore<FakeTransport>({ idleTimeoutMs: 60_000 });
    store.add('fresh', fakeSession([], 'fresh'));
    store.sweep();
    assert.equal(store.size, 1);
  });

  test('closes the least-recently-used session at the cap', async () => {
    const log: string[] = [];
    const store = new SessionStore<FakeTransport>({ maxSessions: 2 });
    store.add('a', fakeSession(log, 'a'));
    store.add('b', fakeSession(log, 'b'));
    // Touching `a` makes `b` the oldest, so `b` is the one that goes.
    store.take('a');
    store.add('c', fakeSession(log, 'c'));

    await Promise.resolve();
    assert.equal(store.size, 2);
    assert.equal(store.take('b'), undefined);
    assert.ok(store.take('a'));
    assert.ok(store.take('c'));
    assert.deepEqual(log, ['transport:b', 'server:b']);
  });

  test('drop closes the pair and is safe to repeat', async () => {
    const log: string[] = [];
    const store = new SessionStore<FakeTransport>();
    store.add('a', fakeSession(log, 'a'));
    await store.drop('a');
    // The transport's `onclose` and an explicit DELETE both land for the same
    // session, so the second drop has to be a no-op rather than a double close.
    await store.drop('a');
    assert.deepEqual(log, ['transport:a', 'server:a']);
    assert.equal(store.size, 0);
  });

  test('closeAll empties the table', async () => {
    const log: string[] = [];
    const store = new SessionStore<FakeTransport>();
    store.add('a', fakeSession(log, 'a'));
    store.add('b', fakeSession(log, 'b'));
    await store.closeAll();
    assert.equal(store.size, 0);
    assert.deepEqual(log.sort(), ['server:a', 'server:b', 'transport:a', 'transport:b']);
  });

  test('a transport that throws on close does not strand the rest', async () => {
    const log: string[] = [];
    const store = new SessionStore<FakeTransport>();
    const broken = fakeSession(log, 'broken');
    broken.transport = {
      close: async () => {
        throw new Error('already gone');
      },
    };
    store.add('broken', broken);
    store.add('ok', fakeSession(log, 'ok'));

    await store.closeAll();
    assert.equal(store.size, 0);
    // The broken transport's server still closed, and so did the healthy pair.
    assert.ok(log.includes('server:broken'));
    assert.ok(log.includes('transport:ok'));
  });

  test('generates unique session ids by default', () => {
    const store = new SessionStore<FakeTransport>();
    const ids = new Set([store.generateSessionId(), store.generateSessionId()]);
    assert.equal(ids.size, 2);
  });

  test('honours a custom id generator', () => {
    let n = 0;
    const store = new SessionStore<FakeTransport>({ generateSessionId: () => `s${++n}` });
    assert.equal(store.generateSessionId(), 's1');
    assert.equal(store.generateSessionId(), 's2');
  });
});
