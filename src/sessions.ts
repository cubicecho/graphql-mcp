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
 * This table is per-process. Running several instances behind a load balancer
 * means either sticky routing or staying stateless — see TODO.md.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
}

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
  /** Mints a session id; exposed so the handler can hand it to the transport. */
  readonly generateSessionId: () => string;

  constructor(options: SessionOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.generateSessionId = options.generateSessionId ?? (() => crypto.randomUUID());
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
    return session;
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
    await closeQuietly(session);
  }

  /** Evicts every session idle for longer than `idleTimeoutMs`. */
  sweep(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen <= cutoff) {
        this.sessions.delete(id);
        void closeQuietly(session);
      }
    }
  }

  /** Closes every session. Called by a handler's `close()` on shutdown. */
  async closeAll(): Promise<void> {
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(live.map(closeQuietly));
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
