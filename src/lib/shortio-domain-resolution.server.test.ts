// Task 7 — per-send shortener domain. resolveShortenerDomain picks the
// requested verified domain of the house, else its verified default, else the
// CRM-wide SHORTIO_DOMAIN; prepareTrackedText/prepareTrackedTextBatch create
// links on the resolved hostname and never re-shorten URLs already on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  listDemoTenantIds: vi.fn(async () => []),
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
  __resetShortenerDomainCacheForTests,
  prepareTrackedText,
  prepareTrackedTextBatch,
  resolveShortenerDomain,
} from "./shortio.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const DOM_DEFAULT = "10000000-0000-4000-8000-000000000001";
const DOM_CAMPAIGN = "10000000-0000-4000-8000-000000000002";
const DOM_PENDING = "10000000-0000-4000-8000-000000000003";
const DOM_REMOVED = "10000000-0000-4000-8000-000000000004";
const DOM_OTHER_HOUSE = "10000000-0000-4000-8000-000000000005";
const DOM_EMAIL = "10000000-0000-4000-8000-000000000006";

function domain(over: Record<string, unknown>) {
  return {
    tenant_id: TENANT,
    kind: "shortener",
    status: "verified",
    is_default: false,
    removed_at: null,
    ...over,
  };
}

function seedDomains() {
  fake.db
    .rows("tenant_domains")
    .push(
      domain({ id: DOM_DEFAULT, hostname: "go.casa.bet", is_default: true }),
      domain({ id: DOM_CAMPAIGN, hostname: "promo.casa.bet" }),
      domain({ id: DOM_PENDING, hostname: "novo.casa.bet", status: "pending" }),
      domain({ id: DOM_REMOVED, hostname: "velho.casa.bet", removed_at: "2026-10-20T00:00:00Z" }),
      domain({ id: DOM_OTHER_HOUSE, tenant_id: OTHER, hostname: "go.outra.bet", is_default: true }),
      domain({ id: DOM_EMAIL, kind: "email", hostname: "mail.casa.bet" }),
    );
}

const shortioCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  fake.db.reset();
  __resetShortenerDomainCacheForTests();
  shortioCalls.length = 0;
  vi.stubEnv("SHORTIO_DOMAIN", "crm.short");
  vi.stubEnv("SHORTIO_API_KEY", "shortio-test-key");
  vi.stubEnv("CLICK_TRACKING_SECRET", "x".repeat(40));
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      shortioCalls.push({ href, ...body });
      if (href === "https://api.short.io/links") {
        return Response.json({
          id: `lnk_${shortioCalls.length}`,
          shortURL: `https://${String(body.domain)}/s${shortioCalls.length}`,
        });
      }
      if (href === "https://api.short.io/links/bulk") {
        const links = body.links as Array<{ originalURL: string }>;
        return Response.json(
          links.map((l, i) => ({
            idString: `bulk_${shortioCalls.length}_${i}`,
            shortURL: `https://${String(body.domain)}/b${shortioCalls.length}x${i}`,
            originalURL: l.originalURL,
          })),
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    }),
  );
  fake.db.onRpc("consume_channel_budget", (args) => ({
    data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }],
    error: null,
  }));
  fake.db.onRpc("resolve_conversion_experiment", () => ({ data: null, error: null }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveShortenerDomain", () => {
  it("returns the requested domain when it is a verified shortener of the house", async () => {
    seedDomains();
    await expect(resolveShortenerDomain(TENANT, DOM_CAMPAIGN)).resolves.toEqual({
      hostname: "promo.casa.bet",
      domainId: DOM_CAMPAIGN,
      usingCrmFallback: false,
    });
  });

  it.each([
    ["another house's domain", DOM_OTHER_HOUSE],
    ["a removed domain", DOM_REMOVED],
    ["a pending domain", DOM_PENDING],
    ["an email domain", DOM_EMAIL],
    ["an unknown id", "10000000-0000-4000-8000-0000000000ff"],
  ])("falls back to the house's verified default for %s", async (_label, requested) => {
    seedDomains();
    await expect(resolveShortenerDomain(TENANT, requested)).resolves.toEqual({
      hostname: "go.casa.bet",
      domainId: DOM_DEFAULT,
      usingCrmFallback: false,
    });
  });

  it("uses the house default when nothing is requested", async () => {
    seedDomains();
    await expect(resolveShortenerDomain(TENANT)).resolves.toMatchObject({
      hostname: "go.casa.bet",
      usingCrmFallback: false,
    });
  });

  it("ignores a default that is no longer verified or was removed", async () => {
    fake.db.rows("tenant_domains").push(
      domain({ id: DOM_PENDING, hostname: "novo.casa.bet", status: "failed", is_default: true }),
      domain({
        id: DOM_REMOVED,
        hostname: "velho.casa.bet",
        is_default: true,
        removed_at: "2026-10-20T00:00:00Z",
      }),
    );
    await expect(resolveShortenerDomain(TENANT, DOM_PENDING)).resolves.toEqual({
      hostname: "crm.short",
      domainId: null,
      usingCrmFallback: true,
    });
  });

  it("falls back to SHORTIO_DOMAIN when the house has no verified default", async () => {
    await expect(resolveShortenerDomain(TENANT, null)).resolves.toEqual({
      hostname: "crm.short",
      domainId: null,
      usingCrmFallback: true,
    });
  });

  it("returns a null hostname when SHORTIO_DOMAIN is not configured either", async () => {
    vi.stubEnv("SHORTIO_DOMAIN", "");
    await expect(resolveShortenerDomain(TENANT)).resolves.toEqual({
      hostname: null,
      domainId: null,
      usingCrmFallback: true,
    });
  });
});

describe("tracked links use the resolved shortener domain", () => {
  function trackingOn(tenantId = TENANT) {
    fake.db.rows("shortio_settings").push({
      tenant_id: tenantId,
      enabled: true,
      // Legacy column: no longer the source of the shortener domain.
      domain: "legacy.short",
      fallback_mode: "block",
      default_ttl_days: null,
      allowed_destination_hosts: [],
      enabled_channels: ["sms", "email"],
    });
  }
  const context = (shortDomainId?: string | null, deliveryKey = "dk-1") => ({
    tenantId: TENANT,
    channel: "sms" as const,
    sourceType: "campaign" as const,
    sourceId: "11111111-1111-4111-8111-111111111111",
    deliveryKey,
    shortDomainId,
  });

  it("prepareTrackedText creates the link on the requested verified domain", async () => {
    seedDomains();
    trackingOn();
    const out = await prepareTrackedText(
      "Oferta https://casa.example/promo e https://promo.casa.bet/ja-curto",
      context(DOM_CAMPAIGN),
    );
    expect(shortioCalls).toHaveLength(1);
    expect(shortioCalls[0].domain).toBe("promo.casa.bet");
    expect(out.links).toHaveLength(1);
    expect(out.content).toBe("Oferta https://promo.casa.bet/s1 e https://promo.casa.bet/ja-curto");
  });

  it("prepareTrackedText falls back to the house default for a pending domain", async () => {
    seedDomains();
    trackingOn();
    const out = await prepareTrackedText(
      "Oferta https://casa.example/promo e https://go.casa.bet/ja-curto",
      context(DOM_PENDING),
    );
    expect(shortioCalls[0].domain).toBe("go.casa.bet");
    expect(out.links).toHaveLength(1);
    expect(out.content).toContain("https://go.casa.bet/ja-curto");
  });

  it("prepareTrackedText uses SHORTIO_DOMAIN when the house has no domain", async () => {
    trackingOn();
    await prepareTrackedText("Oferta https://casa.example/promo", context());
    expect(shortioCalls[0].domain).toBe("crm.short");
  });

  it("prepareTrackedText keeps the configuration error when no domain resolves", async () => {
    vi.stubEnv("SHORTIO_DOMAIN", "");
    trackingOn();
    await expect(
      prepareTrackedText("Oferta https://casa.example/promo", context()),
    ).rejects.toThrow("SHORTIO_DOMAIN não configurado para este tenant");
  });

  it("prepareTrackedTextBatch groups by tenant and resolved domain", async () => {
    seedDomains();
    trackingOn();
    const out = await prepareTrackedTextBatch([
      { content: "A https://casa.example/a", context: context(DOM_CAMPAIGN, "dk-a") },
      { content: "B https://casa.example/b", context: context(null, "dk-b") },
      // Pending → resolves to the same default as "B": one bulk call for both.
      { content: "C https://casa.example/c", context: context(DOM_PENDING, "dk-c") },
    ]);
    const bulk = shortioCalls.filter((c) => c.href === "https://api.short.io/links/bulk");
    expect(bulk.map((c) => c.domain).sort()).toEqual(["go.casa.bet", "promo.casa.bet"]);
    expect(bulk.find((c) => c.domain === "go.casa.bet")!.links).toHaveLength(2);
    expect(out.every((r) => r.ok)).toBe(true);
    expect((out[0] as { content: string }).content).toMatch(/^A https:\/\/promo\.casa\.bet\//);
    expect((out[1] as { content: string }).content).toMatch(/^B https:\/\/go\.casa\.bet\//);
    expect((out[2] as { content: string }).content).toMatch(/^C https:\/\/go\.casa\.bet\//);
  });
});
