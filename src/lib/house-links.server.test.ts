// Task 9 — loadHouseLinks: house URL + quick links resolved and cached 60s
// per tenant.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import { __resetHouseLinksCacheForTests, loadHouseLinks } from "./house-links.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  fake.db.reset();
  __resetHouseLinksCacheForTests();
});

describe("loadHouseLinks", () => {
  it("retorna siteUrl null e quickLinks vazio quando a casa não tem site", () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: null });
    return loadHouseLinks(TENANT).then((house) => {
      expect(house).toEqual({ siteUrl: null, quickLinks: {} });
    });
  });

  it("resolve as URLs rápidas contra siteUrl", async () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: "https://x.com" });
    fake.db
      .rows("tenant_quick_links")
      .push(
        { tenant_id: TENANT, key: "login", path: "/login" },
        { tenant_id: TENANT, key: "promo", path: "/promo" },
      );
    const house = await loadHouseLinks(TENANT);
    expect(house).toEqual({
      siteUrl: "https://x.com",
      quickLinks: { login: "https://x.com/login", promo: "https://x.com/promo" },
    });
  });

  it("ignora URLs rápidas quando não há site_url", async () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: null });
    fake.db.rows("tenant_quick_links").push({ tenant_id: TENANT, key: "login", path: "/login" });
    const house = await loadHouseLinks(TENANT);
    expect(house).toEqual({ siteUrl: null, quickLinks: {} });
  });

  it("usa cache por 60s — não refaz a query na segunda chamada", async () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: "https://x.com" });
    await loadHouseLinks(TENANT);
    const callsAfterFirst = fake.db.calls.length;
    await loadHouseLinks(TENANT);
    expect(fake.db.calls.length).toBe(callsAfterFirst);
  });

  it("__resetHouseLinksCacheForTests força nova leitura", async () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: "https://x.com" });
    await loadHouseLinks(TENANT);
    __resetHouseLinksCacheForTests();
    const callsAfterReset = fake.db.calls.length;
    await loadHouseLinks(TENANT);
    expect(fake.db.calls.length).toBeGreaterThan(callsAfterReset);
  });

  it("normaliza site_url vazio para null", async () => {
    fake.db.rows("tenants").push({ id: TENANT, site_url: "" });
    const house = await loadHouseLinks(TENANT);
    expect(house).toEqual({ siteUrl: null, quickLinks: {} });
  });

  // Important 2 (controller ruling) — a DB error must never break a send: a
  // batch across several tenants (runSmsFlowBatch's Promise.all) must not
  // fail wholesale because one tenant's house lookup errored. Falls back to
  // the legacy rendering (siteUrl: null) instead of throwing, and the
  // fallback value isn't cached (the next call retries the query).
  it("nunca lança em erro de banco — cai para o legado e não é cacheado", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.db.rows("tenants").push({ id: TENANT, site_url: "https://x.com" });
    fake.db.failNext("tenants", "select", "connection reset");

    await expect(loadHouseLinks(TENANT)).resolves.toEqual({ siteUrl: null, quickLinks: {} });
    expect(errorSpy).toHaveBeenCalled();

    // Not cached: a retry now succeeds and reflects the real data.
    const house = await loadHouseLinks(TENANT);
    expect(house).toEqual({ siteUrl: "https://x.com", quickLinks: {} });
    errorSpy.mockRestore();
  });
});
