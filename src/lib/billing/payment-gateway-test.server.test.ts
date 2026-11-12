import { afterEach, describe, expect, it, vi } from "vitest";

import {
  spacePayTestBase,
  testSpacePayConnection,
  testUpperConnection,
  upperTestBase,
} from "./payment-gateway-test.server";

const fetchMock = vi.fn();

function respond(status: number) {
  fetchMock.mockResolvedValueOnce(new Response(status === 204 ? null : "{}", { status }));
}

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function stubFetch() {
  vi.stubGlobal("fetch", fetchMock);
}

describe("upperTestBase / spacePayTestBase", () => {
  it("normalizes to exactly one /v1 for Upper and strips trailing slashes", () => {
    expect(upperTestBase(null)).toBe("https://api.uppersc.com.br/v1");
    expect(upperTestBase("https://sandbox.upper.test/")).toBe("https://sandbox.upper.test/v1");
    expect(upperTestBase("https://sandbox.upper.test/v1/")).toBe("https://sandbox.upper.test/v1");
    expect(spacePayTestBase(null)).toBe("https://integration.prod.spacedev.pro");
    expect(spacePayTestBase("https://sp.test//")).toBe("https://sp.test");
  });
});

describe("testUpperConnection", () => {
  it("404 on the probe charge means the key was accepted", async () => {
    stubFetch();
    respond(404);
    const result = await testUpperConnection({ apiKey: "upper-secret-key", apiBase: null });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.uppersc.com.br/v1/pix/charges/__connection_test__");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer upper-secret-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("401/403 mean an invalid key, and never echo it", async () => {
    stubFetch();
    respond(401);
    const r401 = await testUpperConnection({ apiKey: "upper-secret-key", apiBase: null });
    respond(403);
    const r403 = await testUpperConnection({ apiKey: "upper-secret-key", apiBase: null });
    expect(r401).toEqual({ ok: false, message: "A Upper recusou a API key (HTTP 401)." });
    expect(r403.ok).toBe(false);
    expect(JSON.stringify([r401, r403])).not.toContain("upper-secret-key");
  });

  it("other statuses and network errors fail with a short message", async () => {
    stubFetch();
    respond(500);
    expect(await testUpperConnection({ apiKey: "k", apiBase: null })).toEqual({
      ok: false,
      message: "A Upper respondeu HTTP 500.",
    });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const timeout = await testUpperConnection({ apiKey: "k", apiBase: null });
    expect(timeout.ok).toBe(false);
    expect(timeout.message).toMatch(/10 segundos/);
  });

  it("refuses an empty key without calling the API", async () => {
    stubFetch();
    expect((await testUpperConnection({ apiKey: "  ", apiBase: null })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("testSpacePayConnection", () => {
  it("reads /transactions?perPage=1 with the casino token when set", async () => {
    stubFetch();
    respond(200);
    const result = await testSpacePayConnection({
      gatewayToken: "gw-token",
      casinoToken: "casino-token",
      platformId: " platform-42 ",
      apiBase: "https://sp.test/",
    });
    expect(result).toEqual({ ok: true, message: "Conectado. A SpacePay aceitou o token do cassino." });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sp.test/transactions?perPage=1");
    expect(init.headers.Authorization).toBe("Bearer casino-token");
    expect(init.headers["X-Platform-Id"]).toBe("platform-42");
  });

  it("falls back to the gateway token; 401/403 = refused", async () => {
    stubFetch();
    respond(403);
    const result = await testSpacePayConnection({
      gatewayToken: "gw-token",
      casinoToken: null,
      platformId: "p1",
      apiBase: null,
    });
    expect(result).toEqual({
      ok: false,
      message: "A SpacePay recusou o token do gateway (HTTP 403).",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://integration.prod.spacedev.pro/transactions?perPage=1",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gw-token");
  });

  it("network failure is reported without details", async () => {
    stubFetch();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await testSpacePayConnection({
      gatewayToken: "gw",
      casinoToken: null,
      platformId: "p1",
      apiBase: null,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Não foi possível falar com a SpacePay/);
  });

  function spacePayError(status: number, errors: string[]) {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, message: "Requisição inválida", data: { errors } }),
        { status },
      ),
    );
  }

  const creds = {
    gatewayToken: "gw-secret-token-123",
    casinoToken: null,
    platformId: "p1",
    apiBase: null,
  };

  it("404 naming the platformId = Platform ID não encontrado", async () => {
    stubFetch();
    spacePayError(404, ["Cassino não encontrado para o platformId informado"]);
    expect(await testSpacePayConnection(creds)).toEqual({
      ok: false,
      message: "Platform ID não encontrado na SpacePay.",
    });
  });

  it("400 shows the first data.errors message, sanitized and without tokens", async () => {
    stubFetch();
    spacePayError(400, ["Header X-Platform-Id é obrigatório", "outro"]);
    expect(await testSpacePayConnection(creds)).toEqual({
      ok: false,
      message: "A SpacePay recusou: Header X-Platform-Id é obrigatório",
    });

    spacePayError(400, [`bad gw-secret-token-123\n${"y".repeat(400)}`]);
    const long = await testSpacePayConnection(creds);
    expect(long.message).not.toContain("gw-secret-token-123");
    expect(long.message).not.toContain("\n");
    expect(long.message.length).toBeLessThanOrEqual("A SpacePay recusou: ".length + 160);
  });

  it("400 without data.errors and other statuses never echo the body", async () => {
    stubFetch();
    fetchMock.mockResolvedValueOnce(
      new Response('{"message":"gw-secret-token-123"}', { status: 400 }),
    );
    expect(await testSpacePayConnection(creds)).toEqual({
      ok: false,
      message: "A SpacePay respondeu HTTP 400.",
    });
    spacePayError(404, ["Rota não encontrada"]);
    expect((await testSpacePayConnection(creds)).message).toBe("A SpacePay respondeu HTTP 404.");
  });

  it("blank Platform ID sends the gateway token as X-Platform-Id", async () => {
    stubFetch();
    respond(200);
    respond(200);
    await testSpacePayConnection({ ...creds, platformId: " " });
    await testSpacePayConnection({ ...creds, casinoToken: "casino-tok", platformId: null });
    expect(fetchMock.mock.calls[0][1].headers["X-Platform-Id"]).toBe("gw-secret-token-123");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer casino-tok");
    expect(fetchMock.mock.calls[1][1].headers["X-Platform-Id"]).toBe("gw-secret-token-123");
  });
});
