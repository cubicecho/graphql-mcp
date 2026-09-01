/**
 * The in-memory session table behind stateful MCP-over-HTTP.
 *
 * Stateless mode (the default) mints a server and transport per request and
 * throws both away, which is why it scales across processes without
 * coordination. A *session* is the opposite trade: the client initializes once,
 * gets an `Mcp-Session-Id` back, and every later request is routed to the same
 * long-lived server — which is what makes server-initiated messages (progress
 * notifications, the standalone SSE stream) possible at all, since there is a
 * connection left open to deliver them on.
 *
 * The cost is state, and state has to be bounded. A session ends when the client
 * sends `DELETE`, but a client that simply walks away sends nothing, so the
 * store also evicts by idle time and by count. Sweeping happens on each lookup
 * rather than on a timer: a timer would have to be `unref`'d to avoid holding
 * the process open, and would then be one more lifecycle for callers to own for
 * no benefit over sweeping exactly when the table is touched.
 *
 * ## Why the table stays per-process
 *
 * A session owns a live {@link McpServer}, which is a connected transport, an
 * open stream, and a set of registered handlers — not a value that can be
 * written to Redis and read back on another replica. So the table itself cannot
 * be shared, and a design that tries to serialize it will not work.
 *
 * What *can* be shared is the routing: which instance holds a given session id.
 * That is {@link SessionDirectory}, and supplying one turns the second replica's
 * "I have never heard of this session" into "instance `web-2` holds it" — a
 * routing fact the operator can act on, rather than a mystery 404. Without one
 * the behaviour is unchanged, which is what keeps the single-process case
 * zero-config.
 *
 * The events a session's stream has already sent are bounded separately, in
 * `eventStore.ts`, and belong to the session: they are what a client reconnects
 * against, and they are released when the session here is.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReplayOption } from './eventStore.ts';

/**
 * A shared record of which instance holds which session — identity and
 * ownership, never the session object.
 *
 * Implement it over whatever the deployment already runs: Redis, a database
 * table, a Durable Object namespace. Three methods, all keyed by session id:
 *
 * - {@link claim} is called when a session is registered **and again on each
 *   later use**, so an implementation with a TTL can treat it as the refresh
 *   and needs nothing else. Make it idempotent.
 * - {@link owner} answers a lookup that missed the local table.
 * - {@link release} is called when the session ends, however it ends.
 *
 * Claims are written without being awaited, so a client fast enough to land its
 * second request on another replica before the first claim is durable gets the
 * same 404 it would have got anyway. Nothing is lost that was not already lost;
 * the directory narrows the window rather than closing it.
 *
 * An instance that dies leaves its claims behind. A TTL is the answer, which is
 * why {@link claim} is also the refresh — and why an implementation should
 * prefer its store's native expiry over sweeping.
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
   * How each session buffers SSE events so a dropped connection can resume from
   * `Last-Event-ID`. Default `true`: a bounded in-memory buffer per session.
   *
   * `false` turns resumability off, which is what the transport does unaided —
   * a dropped stream then loses whatever was in flight. An options object tunes
   * the bounds; a factory supplies a store of your own, which is what replay
   * across restarts or replicas needs. See {@link ReplayOption}.
   */
  replay?: ReplayOption;
}

/**
 * Header naming the instance that holds a session, on a request that reached the
 * wrong one. Present only when a {@link SessionDirectory} answered.
 */
export const SESSION_OWNER_HEADER = 'Mcp-Session-Owner';

/**
 * The message for a session id this instance cannot serve.
 *
 * Both handlers answer 404 here, with or without an owner: the spec has clients
 * treat 404 as "your session is gone, initialize again", and a 400 would read as
 * a malformed request and leave the client retrying an id that will never come
 * back. Nor can the request be forwarded — an `McpServer` is a live object, so
 * there is no session to route *to* from here.
 *
 * What the owner adds is the diagnosis. An intermittent, unexplained 404 is the
 * signature of a load balancer that lost its stickiness, and it is miserable to
 * chase; naming the instance turns it into something an operator reads off a
 * single response. The wording and {@link SESSION_OWNER_HEADER} live here, with
 * the directory, so the Node and fetch handlers cannot drift apart.
 *
 * @param owner - The instance holding the session, from
 *   {@link SessionStore.elsewhere}, or `undefined` if it is simply gone.
 */
export function sessionNotFound(owner?: string): string {
  return owner === undefined
    ? 'Session not found'
    : `Session not found on this instance; it is held by '${owner}'`;
}

/** Response headers to accompany {@link sessionNotFound}. */
export function headersFor(owner?: string): Record<string, string> {
  return owner === undefined ? {} : { [SESSION_OWNER_HEADER]: owner };
}

/** Default lifetime of a {@link MemorySessionDirectory} claim without a refresh. */
export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Default idle window before an unused session is evicted. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Default cap on concurrent sessions. */
export const DEFAULT_MAX_SESSIONS = 1000;

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
    if (!session) return undefined;
    session.lastSeen = Date.now();
    // Re-insert so Map iteration order tracks recency, which is what makes the
    // first entry the LRU victim when the table is full.
    this.sessions.delete(id);
    this.sessions.set(id, session);
    // Re-claiming on use is what lets a directory expire the claims of an
    // instance that died without ever getting to release them.
    void this.directory?.claim(id, this.instanceId);
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
    if (!this.directory) return undefined;
    const owner = await this.directory.owner(id);
    if (owner === undefined) return undefined;
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
      if (oldest.done) break;
      void this.drop(oldest.value);
    }
    session.lastSeen = Date.now();
    this.sessions.set(id, session);
    void this.directory?.claim(id, this.instanceId);
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
    if (!session) return;
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
 * Closes a session's transport and server, swallowing failures.
 *
 * Teardown runs from eviction and shutdown paths where there is no caller left
 * to report to, and a transport that throws on close must not strand the other
 * sessions in the same sweep.
 */
async function closeQuietly<T extends ClosableTransport>(session: Session<T>): Promise<void> {
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
 * A {@link SessionDirectory} in local memory, with a TTL.
 *
 * This exists to make the interface concrete — as a test double, and as the
 * shape to copy when writing the Redis or database version. It is *not* a
 * multi-instance directory: memory is exactly the thing several instances do not
 * share, so in a real deployment this answers only for the instance that wrote
 * the claim, which is what the local session table already knew.
 *
 * The TTL is swept on read rather than on a timer, for the same reason
 * {@link SessionStore} sweeps on lookup: a timer would hold the process open.
 * A real implementation should use its store's native expiry instead.
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
    for (const claim of this.claims.values()) if (claim.expires > now) live++;
    return live;
  }

  claim(sessionId: string, owner: string): void {
    this.claims.set(sessionId, { owner, expires: Date.now() + this.ttlMs });
  }

  owner(sessionId: string): string | undefined {
    const claim = this.claims.get(sessionId);
    if (!claim) return undefined;
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
