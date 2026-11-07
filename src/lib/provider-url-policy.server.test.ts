import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInfobipBaseUrl,
  assertShortBrasilUrl,
  providerFetch,
} from "./provider-url-policy.server";

afterEach(() => vi.unstubAllGlobals());

describe("assertInfobipBaseUrl", () => {
  it("accepts a subdomain of api.infobip.com", () => {
    expect(assertInfobipBaseUrl("https://abc12.api.infobip.com")).toBe(
      "https://abc12.api.infobip.com",
    );
  });

  it("accepts the bare api.infobip.com host", () => {
    expect(assertInfobipBaseUrl("https://api.infobip.com")).toBe("https://api.infobip.com");
  });

  it("normalizes a trailing slash away", () => {
    expect(assertInfobipBaseUrl("https://abc12.api.infobip.com/")).toBe(
      "https://abc12.api.infobip.com",
    );
  });

  it("rejects http", () => {
    expect(() => assertInfobipBaseUrl("http://abc.api.infobip.com")).toThrow(/URL base da Infobip/);
  });

  it("rejects a lookalike host", () => {
    expect(() => assertInfobipBaseUrl("https://abc.api.infobip.com.evil.io")).toThrow(
      /URL base da Infobip/,
    );
  });

  it("rejects a raw IP (the metadata address, among others)", () => {
    expect(() => assertInfobipBaseUrl("https://169.254.169.254")).toThrow(/URL base da Infobip/);
  });

  it("rejects embedded credentials", () => {
    expect(() => assertInfobipBaseUrl("https://user:pw@abc.api.infobip.com")).toThrow(
      /URL base da Infobip/,
    );
  });

  it("rejects a non-default port", () => {
    expect(() => assertInfobipBaseUrl("https://abc.api.infobip.com:8443")).toThrow(
      /URL base da Infobip/,
    );
  });

  it("rejects a path", () => {
    expect(() => assertInfobipBaseUrl("https://abc.api.infobip.com/v2")).toThrow(
      /URL base da Infobip/,
    );
  });

  it("rejects an invalid URL", () => {
    expect(() => assertInfobipBaseUrl("not a url")).toThrow(/URL base da Infobip/);
  });
});

describe("assertShortBrasilUrl", () => {
  it("accepts https on api.shortcode.com.br", () => {
    expect(assertShortBrasilUrl("shortcode_url", "https://api.shortcode.com.br/messages")).toBe(
      "https://api.shortcode.com.br/messages",
    );
  });

  it("accepts http on the legacy lp01-short.painelsms.com host", () => {
    expect(
      assertShortBrasilUrl("single_url", "http://lp01-short.painelsms.com/bot/single-sms.php"),
    ).toBe("http://lp01-short.painelsms.com/bot/single-sms.php");
  });

  it("accepts https on the legacy host too", () => {
    expect(
      assertShortBrasilUrl("bulk_url", "https://lp01-short.painelsms.com/bot/bulk-sms.php"),
    ).toBe("https://lp01-short.painelsms.com/bot/bulk-sms.php");
  });

  it("rejects http on api.shortcode.com.br", () => {
    expect(() =>
      assertShortBrasilUrl("shortcode_url", "http://api.shortcode.com.br/messages"),
    ).toThrow(/Short Brasil/);
  });

  it("rejects a host outside the allowlist", () => {
    expect(() =>
      assertShortBrasilUrl("single_url", "https://evil.example.com/single-sms.php"),
    ).toThrow(/Short Brasil/);
  });

  it("rejects a lookalike host", () => {
    expect(() =>
      assertShortBrasilUrl("bulk_url", "https://api.shortcode.com.br.evil.io/bulk-sms.php"),
    ).toThrow(/Short Brasil/);
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      assertShortBrasilUrl("shortcode_url", "https://user:pw@api.shortcode.com.br/messages"),
    ).toThrow(/Short Brasil/);
  });

  it("rejects an invalid URL", () => {
    expect(() => assertShortBrasilUrl("shortcode_url", "not a url")).toThrow(/Short Brasil/);
  });
});

describe("providerFetch", () => {
  it("throws on a redirect instead of following it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.example.com" } })),
    );
    await expect(providerFetch("https://abc.api.infobip.com/x", { timeoutMs: 1000 })).rejects.toThrow(
      /Redirecionamento/,
    );
  });

  it("passes redirect: manual and a timeout signal through to fetch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await providerFetch("https://abc.api.infobip.com/x", { timeoutMs: 5000, headers: { X: "1" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://abc.api.infobip.com/x",
      expect.objectContaining({ redirect: "manual", headers: { X: "1" } }),
    );
    const callInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the response as-is on a non-redirect status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const response = await providerFetch("https://abc.api.infobip.com/x", { timeoutMs: 1000 });
    expect(response.status).toBe(404);
  });
});
