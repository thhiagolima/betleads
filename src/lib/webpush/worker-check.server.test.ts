// Web push (OneSignal) — Task 5: fetches the house site's OneSignal worker
// file and checks it is reachable, served as JS, and has the right content.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_FILE_CONTENT } from "./shared";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsResponse(body: string, contentType = "application/javascript") {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("checkWorkerFile", () => {
  it("returns ok for a 200 application/javascript response with the right content", async () => {
    const fetchMock = vi.fn(async () => jsResponse(WORKER_FILE_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bravabet365.com/push/onesignal/OneSignalSDKWorker.js");
    expect(init.redirect).toBe("manual");
  });

  it("returns nao_encontrado for a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "nao_encontrado" });
  });

  it("returns html for a 200 text/html response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsResponse("<html></html>", "text/html")),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "html" });
  });

  it("returns tipo_errado for a 200 text/plain response even with the right content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsResponse(WORKER_FILE_CONTENT, "text/plain")),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "tipo_errado" });
  });

  it("returns conteudo_errado for a 200 JS response without the right content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsResponse("console.log('oi');")),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "conteudo_errado" });
  });

  it("returns inacessivel when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "inacessivel" });
  });

  it("returns inacessivel for a 301 redirect to another host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://outrodominio.com/push/onesignal/OneSignalSDKWorker.js" },
        }),
      ),
    );

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "inacessivel" });
  });

  it("returns inacessivel for a same-host redirect that downgrades to http", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 301,
        headers: { location: "http://bravabet365.com/push/onesignal/OneSignalSDKWorker.js" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: false, reason: "inacessivel" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a same-host redirect once and evaluates the final response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://bravabet365.com/novo/OneSignalSDKWorker.js",
          },
        }),
      )
      .mockResolvedValueOnce(jsResponse(WORKER_FILE_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    const { checkWorkerFile } = await import("./worker-check.server");
    const result = await checkWorkerFile("https://bravabet365.com");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a 10s timeout signal", async () => {
    const fetchMock = vi.fn(async () => jsResponse(WORKER_FILE_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    const { checkWorkerFile } = await import("./worker-check.server");
    await checkWorkerFile("https://bravabet365.com");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
