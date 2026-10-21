// Short.io domain-management HTTP client (house onboarding, Task 3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createShortioDomain,
  deleteShortioDomain,
  DomainProviderError,
  findShortioDomainByHostname,
  getShortioDomain,
  shortioDnsRecords,
} from "./shortio-domains.server";

const realFetch = globalThis.fetch;
const realApiKey = process.env.SHORTIO_API_KEY;
const realIp = process.env.SHORTIO_A_RECORD_IP;

beforeEach(() => {
  process.env.SHORTIO_API_KEY = "shortio-test-key";
  delete process.env.SHORTIO_A_RECORD_IP;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realApiKey === undefined) delete process.env.SHORTIO_API_KEY;
  else process.env.SHORTIO_API_KEY = realApiKey;
  if (realIp === undefined) delete process.env.SHORTIO_A_RECORD_IP;
  else process.env.SHORTIO_A_RECORD_IP = realIp;
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("shortioDnsRecords", () => {
  it("returns a CNAME record for a subdomain", () => {
    expect(shortioDnsRecords("go.x.com", false)).toEqual([
      { type: "CNAME", name: "go", value: "cname.short.io", verified: false },
    ]);
  });

  it("returns an A record for a root domain (2 labels)", () => {
    expect(shortioDnsRecords("x.com", false)).toEqual([
      { type: "A", name: "@", value: "207.174.61.1", verified: false },
    ]);
  });

  it("returns an A record for a root domain under a 2-label public suffix (.bet.br)", () => {
    expect(shortioDnsRecords("suacasa.bet.br", true)).toEqual([
      { type: "A", name: "@", value: "207.174.61.1", verified: true },
    ]);
  });

  it("returns an A record for a root domain under .com.br", () => {
    expect(shortioDnsRecords("suacasa.com.br", false)).toEqual([
      { type: "A", name: "@", value: "207.174.61.1", verified: false },
    ]);
  });

  it("treats a subdomain of a .bet.br root as a CNAME, not an A record", () => {
    expect(shortioDnsRecords("go.suacasa.bet.br", false)).toEqual([
      { type: "CNAME", name: "go", value: "cname.short.io", verified: false },
    ]);
  });

  it("honours SHORTIO_A_RECORD_IP override for root domains", () => {
    process.env.SHORTIO_A_RECORD_IP = "1.2.3.4";
    expect(shortioDnsRecords("x.com", false)).toEqual([
      { type: "A", name: "@", value: "1.2.3.4", verified: false },
    ]);
  });

  it("sets verified:true on every record when configured", () => {
    expect(shortioDnsRecords("go.x.com", true)).toEqual([
      { type: "CNAME", name: "go", value: "cname.short.io", verified: true },
    ]);
  });
});

describe("createShortioDomain", () => {
  it("POSTs to /domains with the authorization header and hostname body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 12345, state: "not_configured" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createShortioDomain("go.x.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.short.io/domains");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("shortio-test-key");
    expect(JSON.parse(init.body as string)).toEqual({ hostname: "go.x.com", linkType: "random" });

    expect(result).toEqual({
      providerDomainId: "12345",
      providerState: "not_configured",
      status: "pending",
      dnsRecords: [{ type: "CNAME", name: "go", value: "cname.short.io", verified: false }],
    });
  });

  it("maps state:configured to status verified with verified DNS records", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { id: 12345, state: "configured" }),
    ) as unknown as typeof fetch;

    const result = await createShortioDomain("go.x.com");

    expect(result.status).toBe("verified");
    expect(result.dnsRecords).toEqual([
      { type: "CNAME", name: "go", value: "cname.short.io", verified: true },
    ]);
  });

  it("maps state:not_registered to status failed", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { id: 12345, state: "not_registered" }),
    ) as unknown as typeof fetch;

    const result = await createShortioDomain("go.x.com");

    expect(result.status).toBe("failed");
  });

  it("builds an A record for a root hostname", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { id: 1, state: "not_configured" }),
    ) as unknown as typeof fetch;

    const result = await createShortioDomain("x.com");

    expect(result.dnsRecords).toEqual([
      { type: "A", name: "@", value: "207.174.61.1", verified: false },
    ]);
  });

  it("throws DomainProviderError ALREADY_EXISTS on 409", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(409, { error: "domain exists" })) as unknown as typeof fetch;

    await expect(createShortioDomain("go.x.com")).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
      status: 409,
    });
    await expect(createShortioDomain("go.x.com")).rejects.toBeInstanceOf(DomainProviderError);
  });

  it("throws DomainProviderError UNAVAILABLE on 402", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(402, { error: "payment required" })) as unknown as typeof fetch;

    await expect(createShortioDomain("go.x.com")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 402,
    });
  });

  it("throws DomainProviderError UNAVAILABLE on 5xx", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(503, { error: "down" })) as unknown as typeof fetch;

    await expect(createShortioDomain("go.x.com")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 503,
    });
  });

  it("throws DomainProviderError UNAVAILABLE without calling fetch when SHORTIO_API_KEY is missing", async () => {
    delete process.env.SHORTIO_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(createShortioDomain("go.x.com")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getShortioDomain", () => {
  it("GETs /domains/{id} and maps state like create", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 12345, state: "configured" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getShortioDomain("12345", "go.x.com");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.short.io/domains/12345");
    expect((init.headers as Record<string, string>).authorization).toBe("shortio-test-key");
    expect(result.status).toBe("verified");
    expect(result.providerDomainId).toBe("12345");
  });

  it("throws DomainProviderError NOT_FOUND on 404", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, { error: "not found" })) as unknown as typeof fetch;

    await expect(getShortioDomain("12345", "go.x.com")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("findShortioDomainByHostname", () => {
  it("GETs /api/domains?pattern= and returns the item matching the hostname exactly", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, [
        { id: 1, state: "configured", hostname: "other.x.com" },
        { id: 2, state: "not_configured", hostname: "go.x.com" },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await findShortioDomainByHostname("go.x.com");

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.short.io/api/domains?pattern=go.x.com");
    expect(result).toEqual({
      providerDomainId: "2",
      providerState: "not_configured",
      status: "pending",
      dnsRecords: [{ type: "CNAME", name: "go", value: "cname.short.io", verified: false }],
    });
  });

  it("returns null when no item matches the hostname exactly", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, [{ id: 1, state: "configured", hostname: "other.x.com" }]),
    ) as unknown as typeof fetch;

    const result = await findShortioDomainByHostname("go.x.com");

    expect(result).toBeNull();
  });
});

describe("deleteShortioDomain", () => {
  it("POSTs to /domains/delete/{id} with the authorization header", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deleteShortioDomain("12345");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.short.io/domains/delete/12345");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("shortio-test-key");
  });

  it("throws DomainProviderError NOT_FOUND on 404", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    await expect(deleteShortioDomain("12345")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("throws DomainProviderError UNAVAILABLE on other non-2xx", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    await expect(deleteShortioDomain("12345")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 500,
    });
  });
});
