import { describe, expect, it } from "vitest";
import { payloadTooLargeResponse, readBodyLimited } from "./http-body.server";

const URL_ = "https://example.test/hook";

/** Request whose body arrives in the given chunks, without Content-Length. */
function chunkedRequest(chunks: string[], onPull?: () => void) {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
  });
  return new Request(URL_, { method: "POST", body: stream, duplex: "half" } as RequestInit);
}

describe("readBodyLimited", () => {
  it("returns the text of a body under the limit", async () => {
    const result = await readBodyLimited(
      new Request(URL_, { method: "POST", body: '{"a":"ação"}' }),
      1024,
    );
    expect(result).toEqual({ ok: true, text: '{"a":"ação"}', bytes: 14 });
  });

  it("accepts a body of exactly the limit", async () => {
    const result = await readBodyLimited(
      new Request(URL_, { method: "POST", body: "x".repeat(10) }),
      10,
    );
    expect(result).toMatchObject({ ok: true, bytes: 10 });
  });

  it("returns an empty text when there is no body", async () => {
    expect(await readBodyLimited(new Request(URL_), 10)).toEqual({ ok: true, text: "", bytes: 0 });
  });

  it("rejects a declared Content-Length above the limit before reading", async () => {
    const request = new Request(URL_, {
      method: "POST",
      body: "x".repeat(20),
      headers: { "content-length": "20" },
    });
    expect(await readBodyLimited(request, 10)).toEqual({
      ok: false,
      reason: "too_large",
      limit: 10,
    });
  });

  it("stops reading a streamed body as soon as it passes the limit", async () => {
    let pulls = 0;
    const request = chunkedRequest(
      Array.from({ length: 100 }, () => "x".repeat(4)),
      () => pulls++,
    );
    const result = await readBodyLimited(request, 10);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(pulls).toBeLessThan(10);
  });

  it("counts bytes, not characters", async () => {
    // "ç" is 2 bytes in UTF-8: 6 characters = 12 bytes.
    const result = await readBodyLimited(chunkedRequest(["çççççç"]), 11);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("joins multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("ação");
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.close();
        sent = true;
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(await readBodyLimited(request, 100)).toMatchObject({ ok: true, text: "ação" });
  });

  it("reports a broken stream as read_error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(await readBodyLimited(request, 100)).toEqual({
      ok: false,
      reason: "read_error",
      error: "connection reset",
    });
  });
});

describe("payloadTooLargeResponse", () => {
  it("answers 413 with a short JSON body and the given headers", async () => {
    const response = payloadTooLargeResponse(1024, { "Access-Control-Allow-Origin": "*" });
    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({
      ok: false,
      error: "corpo da requisição grande demais",
      limit_bytes: 1024,
    });
  });
});
