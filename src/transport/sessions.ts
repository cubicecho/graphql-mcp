/**
 * The in-memory session table behind stateful MCP-over-HTTP. A session routes every request after `initialize` to the
 * same long-lived server, which is what leaves a connection open for server-initiated messages. The store evicts by
 * idle time and by count, sweeping on each lookup rather than on a timer, because a client that walks away never sends
 * `DELETE`. The table is per-process because a session owns a live {@link McpServer} that cannot be serialized, so a
 * {@link SessionDirectory} shares only which instance holds each id.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_CLAIM_TTL_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_SESSIONS } from '../core/defaults.ts';
import { type EventStore, eventStoreFactory, type ReplayOption } from './event-store.ts';

/**
 * A shared record of which instance holds which session, never the session object itself. {@link claim} is called
 * when a session is registered and again on each later use, so make it idempotent and let a TTL treat it as the
 * refresh. {@link owner} answers a lookup that missed the local table, and {@link release} is called when the session
 * ends. Claims are written without being awaited and outlive an instance that dies, so prefer the store's native
 * expiry to clean them up.
 */
export interface SessionDirectory {
  /** Records (or refreshes) `owner` as the holder of `sessionId`. */
  claim(sessionId: string, owner: string): void | Promise<void>;
  /** The instance holding `sessionId`, or `undefined` if nobody claims it. */
  owner(sessionId: string): string | undefined | Promise<string | undefined>;
  /** Forgets `sessionId`, whoever held it. */
  release(sessionId: string): void | Promise<void>;
}

/** The transport half of a session: anything the store can shut down. */
export interface ClosableTransport {
  close(): Promise<void>;
}

/** A live session: the server, its transport, and when it was last used. */
export interface Session<T extends ClosableTransport> {
  readonly server: McpServer;
  transport?: T;
  lastSeen: number;
}

/** Options for stateful session handling. */
export interface SessionOptions {
  /**
   * Milliseconds a session may sit unused before it is evicted. Default five
   * minutes. A client that disconnects without sending `DELETE` leaves its
   * session behind, so this is the backstop that keeps the table from growing.
   */
  idleTimeoutMs?: number;
  /**
   * Hard cap on concurrent sessions. Default `1000`. At the cap the
   * least-recently-used session is closed to make room, so a burst of abandoned
   * sessions degrades the oldest clients rather than the process.
   */
  maxSessions?: number;
  /**
   * Mints the session id. Default `crypto.randomUUID()`. Override to encode
   * routing information (e.g. an instance id) for a sticky load balancer.
   */
  generateSessionId?: () => string;
  /**
   * Return JSON responses to POSTs instead of opening an SSE stream. Default
   * `false` for sessions — SSE is the reason to be stateful. Set `true` behind a
   * proxy that buffers streaming responses.
   */
  enableJsonResponse?: boolean;
  /**
   * A shared record of which instance holds which session, consulted when a
   * lookup misses the local table. Omit for a single process, where the local
   * table is the whole truth.
   *
   * It does not make sessions portable — an `McpServer` cannot move — but it
   * turns a misrouted request from an unexplained 404 into one that names the
   * instance that should have received it. See {@link SessionDirectory} and the
   * README's deployment notes.
   */
  directory?: SessionDirectory;
  /**
   * This process's name in the {@link directory}. Default a random UUID, which
   * is enough to tell instances apart but tells an operator nothing — set it to
   * something recognisable (a pod name, a hostname) if you intend to route on
   * it, and to something you are willing to disclose, since a misrouted request
   * is answered with the owner's name.
   */
  instanceId?: string;
  /**
   * How each session buffers SSE events so a dropped connection can resume from `Last-Event-ID`. Default `true`, a
   * bounded in-memory buffer per session. `false` turns resumability off, so a dropped stream loses whatever was in
   * flight. An options object tunes the bounds and a factory supplies a store of your own, as {@link ReplayOption}
   * describes.
   */
  replay?: ReplayOption;
}

/**
 * Header naming the instance that holds a session, on a request that reached the
 * wrong one. Present only when a {@link SessionDirectory} answered.
 */
export const SESSION_OWNER_HEADER = 'Mcp-Session-Owner';

/**
 * The message for a session id this instance cannot serve. Both handlers answer 404, with or without an owner, because
 * the spec has clients treat 404 as a reason to initialize again, while a 400 would leave them retrying a dead id.
 * Naming the owner lets an operator diagnose a load balancer that lost its stickiness from a single response. The
 * wording and {@link SESSION_OWNER_HEADER} live here so the Node and fetch handlers cannot drift apart.
 *
 * @param owner - The instance holding the session, from
 *   {@link SessionStore.elsewhere}, or `undefined` if it is simply gone.
 */
export function sessionNotFound(owner?: string): string {
  return owner === undefined ? 'Session not found' : `Session not found on this instance; it is held by '${owner}'`;
}

/** Response headers to accompany {@link sessionNotFound}. */
export function headersFor(owner?: string): Record<string, string> {
  return owner === undefined ? {} : { [SESSION_OWNER_HEADER]: owner };
}

/**
 * A bounded map of session id → live server/transport pair.
 *
 * Transport-agnostic on purpose: the Node and web-standard HTTP handlers differ
 * in how they take a request but not in how they keep a session, so both drive
 * this same store.
 */
export class SessionStore<T extends ClosableTransport> {
  private readonly sessions = new Map<string, Session<T>>();
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly directory?: SessionDirectory;
  /** Mints a session id; exposed so the handler can hand it to the transport. */
  readonly generateSessionId: () => string;
  /** This process's name in the directory. */
  readonly instanceId: string;

  constructor(options: SessionOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.generateSessionId = options.generateSessionId ?? (() => crypto.randomUUID());
    this.directory = options.directory;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
  }

  /** How many sessions are currently held. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Looks up a session, marking it as just-used. Sweeps expired sessions first,
   * so an id that timed out reads as absent rather than as a stale hit.
   *
   * @param id - The `Mcp-Session-Id` from the request.
   * @returns The session, or `undefined` if unknown or expired.
   */
  take(id: string): Session<T> | undefined {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    session.lastSeen = Date.now();
    // Re-insert so Map iteration order tracks recency, which is what makes the
    // first entry the LRU victim when the table is full.
    this.sessions.delete(id);
    this.sessions.set(id, session);
    // Re-claiming on use is what lets a directory expire the claims of an
    // instance that died without ever getting to release them.
    void this.claimQuietly(id);
    return session;
  }

  /**
   * Which *other* instance holds a session this table doesn't, according to the
   * directory. `undefined` when there is no directory, when nobody claims the
   * id, or when the claim is this instance's own — which means the session was
   * evicted here, so the claim is stale and is dropped rather than reported.
   *
   * Only ever called after {@link take} has missed, so it costs nothing on the
   * path that matters.
   *
   * @param id - The `Mcp-Session-Id` that just failed to resolve locally.
   * @returns The owning instance's name, or `undefined` if the session is
   *   genuinely gone.
   */
  async elsewhere(id: string): Promise<string | undefined> {
    if (!this.directory) {
      return undefined;
    }
    const owner = await this.directory.owner(id);
    if (owner === undefined) {
      return undefined;
    }
    if (owner === this.instanceId) {
      await this.directory.release(id);
      return undefined;
    }
    return owner;
  }

  /**
   * Registers a newly initialized session, evicting the least-recently-used one
   * if that would exceed `maxSessions`.
   *
   * @param id - The session id the transport generated.
   * @param session - The server/transport pair to keep.
   */
  add(id: string, session: Session<T>): void {
    this.sweep();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) {
        break;
      }
      void this.drop(oldest.value);
    }
    session.lastSeen = Date.now();
    this.sessions.set(id, session);
    void this.claimQuietly(id);
  }

  /**
   * Removes a session and closes both halves. Safe to call for an id that is
   * already gone, which matters because transport `onclose` and an explicit
   * `DELETE` can both land for the same session.
   *
   * @param id - The session to end.
   */
  async drop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.delete(id);
    // Started together rather than in sequence: a real directory is a network
    // hop, and nothing about closing the session waits on giving the claim back.
    await Promise.all([this.releaseQuietly(id), closeQuietly(session)]);
  }

  /** Evicts every session idle for longer than `idleTimeoutMs`. */
  sweep(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen <= cutoff) {
        this.sessions.delete(id);
        void this.releaseQuietly(id);
        void closeQuietly(session);
      }
    }
  }

  /** Closes every session. Called by a handler's `close()` on shutdown. */
  async closeAll(): Promise<void> {
    const live = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(live.flatMap(([id, s]) => [this.releaseQuietly(id), closeQuietly(s)]));
  }

  /**
   * Claims a session for this instance, swallowing failures. A directory that
   * is momentarily unreachable must not fail the request being served; the
   * next use of the session claims it again.
   *
   * @param id - The session id to claim.
   */
  private async claimQuietly(id: string): Promise<void> {
    try {
      await this.directory?.claim(id, this.instanceId);
    } catch {
      // The session still works here; only cross-instance lookup misses it.
    }
  }

  /**
   * Drops a claim, swallowing failures. Eviction and shutdown must not be held
   * up — or abandoned halfway — by a directory that is momentarily unreachable;
   * a claim left behind expires on its own, while a session left open does not.
   */
  private async releaseQuietly(id: string): Promise<void> {
    try {
      await this.directory?.release(id);
    } catch {
      // The claim outlives its session until the directory's TTL takes it.
    }
  }
}

/**
 * Closes a transport and its server, swallowing failures.
 *
 * Teardown runs from eviction, shutdown and end-of-request paths where there is
 * no caller left to report to, and a transport that throws on close must not
 * strand the other sessions in the same sweep or the response already built.
 */
export async function closeQuietly<T extends ClosableTransport>(
  session: Pick<Session<T>, 'server' | 'transport'>,
): Promise<void> {
  try {
    await session.transport?.close();
  } catch {
    // Already closed, or the peer vanished; nothing to do about it here.
  }
  try {
    await session.server.close();
  } catch {
    // As above.
  }
}

/**
 * A {@link SessionDirectory} in local memory, with a TTL. It is a test double and the shape to copy for a Redis or
 * database version, not a multi-instance directory, because instances do not share memory. The TTL is swept on read
 * rather than on a timer, because a timer would hold the process open. A real implementation should use its store's
 * native expiry instead.
 */
export class MemorySessionDirectory implements SessionDirectory {
  private readonly claims = new Map<string, { owner: string; expires: number }>();
  private readonly ttlMs: number;

  /**
   * @param ttlMs - How long a claim survives without a refresh. Default ten
   *   minutes, twice the default idle timeout, so a live session is always
   *   re-claimed well before its claim lapses.
   */
  constructor(ttlMs: number = DEFAULT_CLAIM_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Number of unexpired claims. Expired entries are counted out, not swept. */
  get size(): number {
    const now = Date.now();
    let live = 0;
    for (const claim of this.claims.values()) {
      if (claim.expires > now) {
        live++;
      }
    }
    return live;
  }

  claim(sessionId: string, owner: string): void {
    this.claims.set(sessionId, { owner, expires: Date.now() + this.ttlMs });
  }

  owner(sessionId: string): string | undefined {
    const claim = this.claims.get(sessionId);
    if (!claim) {
      return undefined;
    }
    if (claim.expires <= Date.now()) {
      this.claims.delete(sessionId);
      return undefined;
    }
    return claim.owner;
  }

  release(sessionId: string): void {
    this.claims.delete(sessionId);
  }
}

/** The request header a client sends its session id in. */
export const SESSION_ID_HEADER = 'mcp-session-id';

/** HTTP status for a session id this instance cannot serve. */
const SESSION_NOT_FOUND_STATUS = 404;

/** JSON-RPC error code the MCP SDK uses for an unknown session. */
const SESSION_NOT_FOUND_CODE = -32001;

/** What a session transport must expose for {@link SessionHost} to keep it. */
export interface SessionTransport extends ClosableTransport {
  sessionId?: string;
  onclose?: () => void;
}

/** The options {@link SessionHost.begin} hands a transport constructor. */
export interface SessionTransportOptions {
  sessionIdGenerator: () => string;
  enableJsonResponse: boolean;
  eventStore: EventStore | undefined;
  onsessioninitialized: (id: string) => void;
  onsessionclosed: (id: string) => Promise<void>;
}

/** The ready-to-send answer for a session id this instance cannot serve. */
export interface SessionMiss {
  status: number;
  headers: Record<string, string>;
  /** A serialized JSON-RPC error. */
  body: string;
}

/**
 * The session lifecycle both HTTP handlers share: find a session, answer for a
 * missing one, begin a new one, and drop a pair that never initialized. Each
 * handler only translates its own request and response types around it.
 */
export class SessionHost<T extends SessionTransport> {
  /** The live sessions. */
  readonly store: SessionStore<T>;
  private readonly enableJsonResponse: boolean;
  private readonly newEventStore: () => EventStore | undefined;

  /**
   * @param options - The handler's `sessions` option, already an object.
   */
  constructor(options: SessionOptions) {
    this.store = new SessionStore<T>(options);
    this.enableJsonResponse = options.enableJsonResponse ?? false;
    // One replay buffer per session, so a reconnecting client resumes its own
    // stream and the buffer dies with the session.
    this.newEventStore = eventStoreFactory(options.replay);
  }

  /**
   * Builds the host for a handler's `sessions` option.
   *
   * @param sessions - `true` for the defaults, an options object, or falsy for stateless.
   * @returns The host, or `undefined` when the handler is stateless.
   */
  static from<T extends SessionTransport>(sessions: boolean | SessionOptions | undefined): SessionHost<T> | undefined {
    const options = sessions === true ? {} : sessions || undefined;
    return options ? new SessionHost<T>(options) : undefined;
  }

  /**
   * Answers a request whose session id is not held here.
   *
   * @param id - The session id the request carried.
   * @returns The status, headers and JSON-RPC body to send; see {@link sessionNotFound}.
   */
  async miss(id: string): Promise<SessionMiss> {
    const owner = await this.store.elsewhere(id);
    const error = { code: SESSION_NOT_FOUND_CODE, message: sessionNotFound(owner) };
    return {
      status: SESSION_NOT_FOUND_STATUS,
      headers: { 'Content-Type': 'application/json', ...headersFor(owner) },
      body: JSON.stringify({ jsonrpc: '2.0', error, id: null }),
    };
  }

  /**
   * Creates the transport for a request with no session id and wires it to the
   * store. Such a request is either an `initialize`, which mints an id, or a
   * stray one the transport rejects itself; the work is the same either way.
   *
   * @param server - The server minted for this session.
   * @param create - Constructs the handler's transport from the session options.
   * @returns The transport, not yet connected.
   */
  begin(server: McpServer, create: (options: SessionTransportOptions) => T): T {
    const session: Session<T> = { server, lastSeen: Date.now() };
    const transport = create({
      sessionIdGenerator: this.store.generateSessionId,
      enableJsonResponse: this.enableJsonResponse,
      eventStore: this.newEventStore(),
      // Registered before the initialize response is written, so a client that
      // fires its next request immediately can't beat the session into the table.
      onsessioninitialized: (id) => this.store.add(id, session),
      onsessionclosed: (id) => this.store.drop(id),
    });
    session.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) {
        void this.store.drop(transport.sessionId);
      }
    };
    return transport;
  }

  /**
   * Closes a pair whose request never initialized a session, so a stray request
   * does not leak a server.
   *
   * @param server - The server passed to {@link SessionHost.begin}.
   * @param transport - The transport it returned, after the request was handled.
   */
  async settle(server: McpServer, transport: T): Promise<void> {
    if (transport.sessionId) {
      return;
    }
    await transport.close();
    await server.close();
  }
}
