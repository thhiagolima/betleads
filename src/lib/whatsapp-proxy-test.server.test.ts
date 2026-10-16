// F0-06 / SEC-17: testWhatsappProxy opened a TCP socket to any host:port for
// any logged-in user (internal port scanning). Now super admin only, and the
// host must resolve to a public address; the socket is pinned to that address.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  dns: new Map<string, string[]>(),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const addrs = fake.dns.get(host) ?? ["93.184.216.34"];
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));
vi.mock("./whatsapp-proxy.server", () => ({
  testProxyHandshake: vi.fn(async () => ({ ok: true, stage: "ok" })),
}));

import { testProxyHandshake } from "./whatsapp-proxy.server";
import { runWhatsappProxyTest } from "./whatsapp-proxy-test.server";

const PROXY_ID = "33333333-3333-4333-8333-333333333333";
const handshake = vi.mocked(testProxyHandshake);
let userDb: ReturnType<typeof createFakeDb>;

const inline = (host: string, port = 3128) => ({
  inline: { protocol: "http" as const, host, port, username: null, password: null },
});

beforeEach(() => {
  fake.admin.reset();
  fake.dns.clear();
  userDb = createFakeDb();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === "super-user",
    error: null,
  }));
  handshake.mockClear();
});

describe("runWhatsappProxyTest", () => {
  it("refuses a regular tenant user before opening any socket", async () => {
    await expect(
      runWhatsappProxyTest(userDb.client, "member-user", inline("proxy.example.com")),
    ).rejects.toThrow(/plataforma/);
    expect(handshake).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "localhost",
    "10.0.0.8",
    "169.254.169.254",
    "2130706433",
    "0x7f000001",
    "::1",
    "::ffff:127.0.0.1",
    "metadata.google.internal",
  ])("refuses internal inline host %s", async (host) => {
    await expect(runWhatsappProxyTest(userDb.client, "super-user", inline(host))).rejects.toThrow(
      /bloqueado|interno|reservado|inválido/i,
    );
    expect(handshake).not.toHaveBeenCalled();
  });

  it("refuses an inline hostname that resolves to a private address", async () => {
    fake.dns.set("scan.example.com", ["192.168.0.10"]);
    await expect(
      runWhatsappProxyTest(userDb.client, "super-user", inline("scan.example.com")),
    ).rejects.toThrow();
    expect(handshake).not.toHaveBeenCalled();
  });

  it("also guards stored proxies (id case)", async () => {
    userDb.rows("whatsapp_proxies").push({ id: PROXY_ID });
    fake.admin.rows("whatsapp_proxies").push({
      id: PROXY_ID,
      protocol: "socks5",
      host: "127.0.0.1",
      port: 22,
      username: null,
      password_encrypted: null,
    });
    await expect(
      runWhatsappProxyTest(userDb.client, "super-user", { id: PROXY_ID }),
    ).rejects.toThrow();
    expect(handshake).not.toHaveBeenCalled();
  });

  it("connects to the validated address of a public proxy", async () => {
    fake.dns.set("proxy.example.com", ["203.0.114.10"]);
    const res = await runWhatsappProxyTest(
      userDb.client,
      "super-user",
      inline("proxy.example.com", 8080),
    );
    expect(res.ok).toBe(true);
    expect(handshake).toHaveBeenCalledWith(
      expect.objectContaining({ host: "203.0.114.10", port: 8080, protocol: "http" }),
    );
  });
});
