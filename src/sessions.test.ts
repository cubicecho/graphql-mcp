/**
 * Covers the session table's bounds. The interesting behaviour is all in the
 * eviction paths — idle expiry, the LRU cap, and double-drop — because those are
 * what stand between a stateful server and an unbounded map of live servers.
 *
 * The directory tests cover the other half: a session table that is per-process
 * by necessity can at least say *which* process, and every path that ends a
 * session has to give the claim back or the answer goes stale.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ClosableTransport,
  headersFor,
  MemorySessionDirectory,
  SESSION_OWNER_HEADER,
  type Session,
  type SessionDirectory,
  SessionStore,
  sessionNotFound,
} from './sessions.ts';

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

describe('MemorySessionDirectory', () => {
  test('reports the owner it was given', () => {
    const directory = new MemorySessionDirectory();
    directory.claim('a', 'web-1');
    assert.equal(directory.owner('a'), 'web-1');
  });

  test('is undefined for an unclaimed id', () => {
    assert.equal(new MemorySessionDirectory().owner('nope'), undefined);
  });

  test('release forgets the claim', () => {
    const directory = new MemorySessionDirectory();
    directory.claim('a', 'web-1');
    directory.release('a');
    assert.equal(directory.owner('a'), undefined);
    assert.equal(directory.size, 0);
  });

  test('claiming again moves the session to the new owner', () => {
    const directory = new MemorySessionDirectory();
    directory.claim('a', 'web-1');
    directory.claim('a', 'web-2');
    assert.equal(directory.owner('a'), 'web-2');
    assert.equal(directory.size, 1);
  });

  test('a claim past its ttl reads as unclaimed', () => {
    const directory = new MemorySessionDirectory(-1); // Already expired when written.
    directory.claim('a', 'web-1');
    assert.equal(directory.owner('a'), undefined);
  });

  test('re-claiming refreshes the ttl', () => {
    // 20ms of life, refreshed after 15ms: without the refresh the read at 25ms
    // would miss. Real implementations lean on their store's expiry; this is the
    // behaviour they have to reproduce.
    const directory = new MemorySessionDirectory(20);
    directory.claim('a', 'web-1');
    const at = Date.now();
    while (Date.now() - at < 15) {} // Busy-wait: a timer would make the test async for nothing.
    directory.claim('a', 'web-1');
    assert.equal(directory.owner('a'), 'web-1');
  });

  test('size counts only unexpired claims', () => {
    const directory = new MemorySessionDirectory(-1);
    directory.claim('a', 'web-1');
    assert.equal(directory.size, 0);
  });
});

describe('SessionStore with a directory', () => {
  test('claims a session for this instance when it is added', () => {
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession([], 'a'));
    assert.equal(directory.owner('a'), 'web-1');
  });

  test('re-claims on every use, so a live session outlives its ttl', () => {
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession([], 'a'));
    directory.release('a');
    store.take('a');
    assert.equal(directory.owner('a'), 'web-1');
  });

  test('releases the claim when the session is dropped', async () => {
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession([], 'a'));
    await store.drop('a');
    assert.equal(directory.owner('a'), undefined);
  });

  test('releases the claim when the session is swept', () => {
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({
      directory,
      instanceId: 'web-1',
      idleTimeoutMs: 1000,
    });
    const session = fakeSession([], 'a');
    store.add('a', session);
    session.lastSeen = Date.now() - 5000;
    store.sweep();
    assert.equal(directory.owner('a'), undefined);
  });

  test('releases every claim on closeAll', async () => {
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession([], 'a'));
    store.add('b', fakeSession([], 'b'));
    await store.closeAll();
    assert.equal(directory.size, 0);
  });

  test('elsewhere names the instance holding a session this one does not', async () => {
    const directory = new MemorySessionDirectory();
    directory.claim('a', 'web-2');
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    assert.equal(await store.elsewhere('a'), 'web-2');
  });

  test('elsewhere is undefined for a session nobody claims', async () => {
    const store = new SessionStore<FakeTransport>({
      directory: new MemorySessionDirectory(),
      instanceId: 'web-1',
    });
    assert.equal(await store.elsewhere('gone'), undefined);
  });

  test('elsewhere drops a stale claim of this instance rather than reporting it', async () => {
    // The session was evicted locally but the claim outlived it. Reporting
    // ourselves as the owner would tell an operator to route here — which is
    // exactly where the request already is.
    const directory = new MemorySessionDirectory();
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    directory.claim('a', 'web-1');
    assert.equal(await store.elsewhere('a'), undefined);
    assert.equal(directory.owner('a'), undefined);
  });

  test('elsewhere is undefined when there is no directory at all', async () => {
    const store = new SessionStore<FakeTransport>();
    assert.equal(await store.elsewhere('a'), undefined);
  });

  test('a directory that throws does not stop a session from closing', async () => {
    // Teardown has to finish: a claim left behind expires on its own, a session
    // left open does not.
    const log: string[] = [];
    const directory: SessionDirectory = {
      claim: () => {},
      owner: () => undefined,
      release: () => {
        throw new Error('directory unreachable');
      },
    };
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession(log, 'a'));
    await store.drop('a');
    assert.deepEqual(log, ['transport:a', 'server:a']);
  });

  test('a directory that rejects does not stop closeAll', async () => {
    const log: string[] = [];
    const directory: SessionDirectory = {
      claim: async () => {},
      owner: async () => undefined,
      release: async () => {
        throw new Error('directory unreachable');
      },
    };
    const store = new SessionStore<FakeTransport>({ directory, instanceId: 'web-1' });
    store.add('a', fakeSession(log, 'a'));
    await store.closeAll();
    assert.deepEqual(log, ['transport:a', 'server:a']);
  });
});

describe('sessionNotFound', () => {
  test('says only that the session is gone when nobody owns it', () => {
    assert.equal(sessionNotFound(), 'Session not found');
    assert.deepEqual(headersFor(), {});
  });

  test('names the owning instance when the directory knows it', () => {
    assert.match(sessionNotFound('web-2'), /held by 'web-2'/);
    assert.deepEqual(headersFor('web-2'), { [SESSION_OWNER_HEADER]: 'web-2' });
  });
});
