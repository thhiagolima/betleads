/**
 * Reads a request body as UTF-8 text, stopping as soon as it grows past
 * `maxBytes` (ENG-05). `request.text()` buffers whatever the client sends,
 * so one public endpoint could be made to hold hundreds of MB in memory.
 *
 * A declared Content-Length above the limit is rejected before reading; the
 * stream is still counted, because the header can be absent or lie.
 */
export type LimitedBody =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "too_large"; limit: number }
  | { ok: false; reason: "read_error"; error: string };

export const HOUSE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export async function readBodyLimited(request: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large", limit: maxBytes };
  }
  if (!request.body) return { ok: true, text: "", bytes: 0 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large", limit: maxBytes };
      }
      chunks.push(value);
    }
  } catch (error) {
    return {
      ok: false,
      reason: "read_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all), bytes };
}

/** Short JSON answer for a body over the limit. */
export function payloadTooLargeResponse(limit: number, headers?: Record<string, string>): Response {
  return Response.json(
    { ok: false, error: "corpo da requisição grande demais", limit_bytes: limit },
    { status: 413, headers },
  );
}
