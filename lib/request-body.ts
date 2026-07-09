// Hard byte-cap enforcement for request bodies on Route Handlers.
//
// `serverActions.bodySizeLimit` (next.config.js) only bounds Server Action bodies,
// NOT Route Handlers, and a Content-Length header is trivially defeated
// (Transfer-Encoding: chunked, an omitted header, or a lie). So a route that must
// bound its body has to actually count the bytes it reads and abort mid-stream.

// Pure accumulator: given the running byte total, the next chunk's length, and the
// cap, return the new total and whether the cap has been exceeded. Extracted so the
// over-cap decision is unit-testable without a real stream.
export function accumulateBytes(
  total: number,
  chunkLen: number,
  cap: number
): { total: number; over: boolean } {
  const next = total + chunkLen;
  return { total: next, over: next > cap };
}

export type CappedBody = { text: string } | { overCap: true };

// Read a request body stream, enforcing a hard byte cap. Accumulates raw chunk
// lengths and aborts the moment cumulative bytes exceed `cap` (cancelling the
// stream so we never buffer the rest), then returns the decoded UTF-8 text. This
// is the authoritative size guard — the caller may still do a fast-path
// Content-Length check first, but must not trust it as the only guard.
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number
): Promise<CappedBody> {
  if (!body) return { text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const acc = accumulateBytes(total, value.byteLength, cap);
      total = acc.total;
      if (acc.over) {
        await reader.cancel();
        return { overCap: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}
