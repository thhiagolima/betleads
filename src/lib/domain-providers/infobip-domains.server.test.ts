// Infobip domain-management HTTP client (house onboarding, Task 3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainProviderError } from "./shortio-domains.server";
import {
  createInfobipDomain,
  deleteInfobipDomain,
  getInfobipDomain,
  requestInfobipVerification,
} from "./infobip-domains.server";

const realFetch = globalThis.fetch;
const realBaseUrl = process.env.INFOBIP_BASE_URL;
const realApiKey = process.env.INFOBIP_API_KEY;

beforeEach(() => {
  process.env.INFOBIP_BASE_URL = "https://xxxxx.api.infobip.com";
  process.env.INFOBIP_API_KEY = "infobip-test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBaseUrl === undefined) delete process.env.INFOBIP_BASE_URL;
  else process.env.INFOBIP_BASE_URL = realBaseUrl;
  if (realApiKey === undefined) delete process.env.INFOBIP_API_KEY;
  else process.env.INFOBIP_API_KEY = realApiKey;
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createInfobipDomain", () => {
  it("POSTs to /email/1/domains with the App authorization header and expected body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        domainId: 7,
        active: false,
        dnsRecords: [
          {
            recordType: "TXT",
            name: "x._domainkey.mail.x.com",
            expectedValue: "k=rsa...",
            verified: false,
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createInfobipDomain("mail.x.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://xxxxx.api.infobip.com/email/1/domains");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("App infobip-test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      domainName: "mail.x.com",
      dkimKeyLength: 2048,
      targetedDailyTraffic: 1000,
    });

    expect(result).toEqual({
      providerDomainId: "7",
      providerState: "inactive",
      status: "pending",
      dnsRecords: [
        { type: "TXT", name: "x._domainkey.mail.x.com", value: "k=rsa...", verified: false },
      ],
    });
  });

  it("maps active:true with all records verified to status verified", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        domainId: 7,
        active: true,
        dnsRecords: [
          {
            recordType: "TXT",
            name: "x._domainkey.mail.x.com",
            expectedValue: "k=rsa...",
            verified: true,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await createInfobipDomain("mail.x.com");

    expect(result.status).toBe("verified");
  });

  it("maps active:true with one unverified record to status pending", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        domainId: 7,
        active: true,
        dnsRecords: [
          { recordType: "TXT", name: "a", expectedValue: "v1", verified: true },
          { recordType: "TXT", name: "b", expectedValue: "v2", verified: false },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await createInfobipDomain("mail.x.com");

    expect(result.status).toBe("pending");
  });

  it("maps blocked:true to status failed", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        domainId: 7,
        active: true,
        blocked: true,
        dnsRecords: [{ recordType: "TXT", name: "a", expectedValue: "v1", verified: true }],
      }),
    ) as unknown as typeof fetch;

    const result = await createInfobipDomain("mail.x.com");

    expect(result.status).toBe("failed");
  });

  it("throws DomainProviderError ALREADY_EXISTS on 400 with 'already exists' in the error text", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(400, {
        requestError: {
          serviceException: { messageId: "BAD_REQUEST", text: "Domain already exists" },
        },
      }),
    ) as unknown as typeof fetch;

    await expect(createInfobipDomain("mail.x.com")).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
      status: 400,
    });
    await expect(createInfobipDomain("mail.x.com")).rejects.toBeInstanceOf(DomainProviderError);
  });

  it("throws DomainProviderError UNAVAILABLE without calling fetch when INFOBIP_API_KEY is missing", async () => {
    delete process.env.INFOBIP_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(createInfobipDomain("mail.x.com")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws DomainProviderError UNAVAILABLE without calling fetch when INFOBIP_BASE_URL is missing", async () => {
    delete process.env.INFOBIP_BASE_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(createInfobipDomain("mail.x.com")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getInfobipDomain", () => {
  it("GETs /email/1/domains/{name}", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        domainId: 7,
        active: true,
        dnsRecords: [{ recordType: "TXT", name: "a", expectedValue: "v1", verified: true }],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getInfobipDomain("mail.x.com");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://xxxxx.api.infobip.com/email/1/domains/mail.x.com");
    expect((init?.method ?? "GET")).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("App infobip-test-key");
    expect(result.status).toBe("verified");
  });

  it("throws DomainProviderError NOT_FOUND on 404", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(404, {
        requestError: { serviceException: { messageId: "NOT_FOUND", text: "Domain not found" } },
      }),
    ) as unknown as typeof fetch;

    await expect(getInfobipDomain("mail.x.com")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("requestInfobipVerification", () => {
  it("POSTs to /email/1/domains/{name}/verify and accepts 202", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(requestInfobipVerification("mail.x.com")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://xxxxx.api.infobip.com/email/1/domains/mail.x.com/verify");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("App infobip-test-key");
  });

  it("throws DomainProviderError ALREADY_EXISTS on 400 with 'already exists' in the error text", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(400, {
        requestError: {
          serviceException: { messageId: "BAD_REQUEST", text: "Verification already exists" },
        },
      }),
    ) as unknown as typeof fetch;

    await expect(requestInfobipVerification("mail.x.com")).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
      status: 400,
    });
  });
});

describe("deleteInfobipDomain", () => {
  it("DELETEs /email/1/domains/{name} and accepts 204", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(deleteInfobipDomain("mail.x.com")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://xxxxx.api.infobip.com/email/1/domains/mail.x.com");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("App infobip-test-key");
  });

  it("throws DomainProviderError NOT_FOUND on 404", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(404, {
        requestError: { serviceException: { messageId: "NOT_FOUND", text: "Domain not found" } },
      }),
    ) as unknown as typeof fetch;

    await expect(deleteInfobipDomain("mail.x.com")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});
