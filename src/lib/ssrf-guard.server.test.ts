import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSafeOutboundHost,
  assertSafeOutboundUrl,
  isBlockedHostname,
  isBlockedIp,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
} from "./ssrf-guard.server";

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

describe("isBlockedIp — IPv4", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1", // CGNAT
    "100.127.255.254",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "1.1.1.1"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("isBlockedIp — IPv6", () => {
  it.each([
    "::",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    // IPv4-mapped / embedded forms pointing at internal space
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "::127.0.0.1", // deprecated IPv4-compatible
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "2002:7f00:0001::1", // 6to4 of 127.0.0.1
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("treats garbage as blocked (fail closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "api.localhost",
    "metadata.google.internal",
    "metadata",
    "foo.internal",
    "printer.local",
    "",
  ])("blocks %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each(["example.com", "hooks.crm.com.br", "localhost.example.com"])("allows %s", (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });
});

describe("assertSafeOutboundHost", () => {
  it.each([
    "127.0.0.1",
    "2130706433", // decimal 127.0.0.1
    "0x7f000001", // hex 127.0.0.1
    "0177.0.0.1", // octal 127.0.0.1
    "127.1", // short form
    "0xa9fea9fe", // hex 169.254.169.254
    "[::1]",
    "::ffff:127.0.0.1",
    "localhost",
    "metadata.google.internal",
  ])("rejects literal/obfuscated internal host %s without resolving DNS", async (host) => {
    const lookup = vi.fn(publicLookup);
    await expect(assertSafeOutboundHost(host, { lookup })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a public-looking name that resolves to a private address", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSafeOutboundHost("evil.example.com", { lookup })).rejects.toThrow(
      /interno|reservado/,
    );
  });

  it("rejects names resolving to IPv4-mapped loopback", async () => {
    const lookup = vi.fn(async () => [{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertSafeOutboundHost("evil.example.com", { lookup })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
  });

  it("rejects names that do not resolve", async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    await expect(assertSafeOutboundHost("nope.example.com", { lookup })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
    const empty = vi.fn(async () => []);
    await expect(assertSafeOutboundHost("nope.example.com", { lookup: empty })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
  });

  it("returns every validated address for public names", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    await expect(assertSafeOutboundHost("example.com", { lookup })).resolves.toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });

  it("accepts a public IP literal without DNS", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(assertSafeOutboundHost("8.8.8.8", { lookup })).resolves.toEqual(["8.8.8.8"]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("assertSafeOutboundUrl", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/hook",
    "http://example.com/hook", // plain http is refused by default
    "ftp://example.com/x",
    "file:///etc/passwd",
    "gopher://example.com",
    "https://127.0.0.1/hook",
    "https://2130706433/hook",
    "https://0x7f000001/hook",
    "https://[::1]/hook",
    "https://[::ffff:169.254.169.254]/hook",
    "https://localhost:8443/hook",
    "https://user:pass@example.com/hook",
    "not a url",
  ])("rejects %s", async (raw) => {
    await expect(assertSafeOutboundUrl(raw, { lookup: publicLookup })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
  });

  it("accepts a public https URL", async () => {
    const res = await assertSafeOutboundUrl("https://hooks.example.com/betleads?x=1", {
      lookup: publicLookup,
    });
    expect(res.url.hostname).toBe("hooks.example.com");
    expect(res.addresses).toEqual(["93.184.216.34"]);
  });
});

describe("safeOutboundFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("validates the URL, disables redirects and sets a timeout signal", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await safeOutboundFetch(
      "https://hooks.example.com/x",
      { method: "POST", body: "{}" },
      { lookup: publicLookup, timeoutMs: 5000 },
    );
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST");
  });

  it("never calls fetch for an unsafe destination", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      safeOutboundFetch("http://169.254.169.254/", {}, { lookup: publicLookup }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
