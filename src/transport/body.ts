/**
 * Reads a JSON request body under a byte cap, for the handlers' `maxBodyBytes`. The SDK's transports read the body
 * themselves with no cap (1.25 and later) or a fixed 4 MB one (earlier), so a host serving MCP beside a bare
 * `node:http` server had nothing to set. A refusal is spelled as the SDK spells its own transport errors, a JSON-RPC
 * error with a null id, so a client sees one shape whichever layer refused it.
 */

/** What reading a body came to: the parsed value, or the response that refuses it. */
export type BodyReading = { body: unknown } | { refusal: { status: number; body: string } };

/** JSON-RPC's code for a message that is not JSON. */
const PARSE_ERROR = -32700;

/** The SDK's code for a transport-level refusal. */
const SERVER_ERROR = -32000;

/**
 * Reads and parses a body, stopping as soon as it passes `maxBytes`. A declared `Content-Length` over the cap is
 * refused before anything is read.
 *
 * @param chunks - The body's bytes. Returning from it early must not destroy the connection the refusal is sent on.
 * @param declaredLength - The request's `Content-Length` header, if it sent one.
 * @param maxBytes - The largest body accepted, in bytes.
 * @returns The parsed body, or a refusal: 413 for a body over the cap, 400 for one that is empty or not JSON.
 */
export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  declaredLength: string | null | undefined,
  maxBytes: number,
): Promise<BodyReading> {
  if (declaredLength && Number(declaredLength) > maxBytes) {
    return tooLarge(maxBytes);
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      return tooLarge(maxBytes);
    }
    parts.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    // The SDK's own wording, so the answer does not depend on which layer parsed the body.
    return refusal(400, PARSE_ERROR, 'Parse error: Invalid JSON');
  }
}

/**
 * A web stream as chunks, cancelling the stream when the reader stops early.
 *
 * @param stream - A request body, or `null` for a request without one.
 * @returns The stream's chunks; none for `null`.
 */
export async function* streamChunks(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (stream === null) {
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The refusal for a body over the cap.
 *
 * @param maxBytes - The cap it passed.
 * @returns A 413 refusal naming the cap.
 */
function tooLarge(maxBytes: number): BodyReading {
  return refusal(413, SERVER_ERROR, `Payload too large: the request body exceeds ${maxBytes} bytes`);
}

/**
 * A JSON-RPC error response with no id, as the SDK writes one.
 *
 * @param status - The HTTP status.
 * @param code - The JSON-RPC error code.
 * @param message - The error message.
 * @returns The refusal.
 */
function refusal(status: number, code: number, message: string): BodyReading {
  return { refusal: { status, body: JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }) } };
}
